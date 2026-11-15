import { PREFIX, COMMANDS, commandsText, compactList, aiContext, helpTopicsText, helpTopicAt } from './features.js';
import { resolvePlayable, trackFromQuery } from './track.js';
import { askAI, aiConfigured } from './ai.js';
import { COMPONENT_INTERACTIONS, helpMenu } from './ui.js';

/**
 * The lists are select menus. Every pick also has a plain command form
 * (`w/play 3`, `w/help 2`), because the selfbot build cannot receive the
 * MESSAGE_COMPONENT interaction that a click produces.
 */

/** How long a w/help topic list stays open for replies. */
const HELP_TTL = 30 * 60 * 1000;

const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const clip = (s, n = 1900) => (s.length > n ? s.slice(0, n - 20) + '\n... (truncated)' : s);

export function attachCommands({ client, player, cfg, log = console.log }) {
  const prefix = cfg.commands?.prefix || PREFIX;
  const onlyChannels = new Set((cfg.commands?.channels || []).map(String));
  const allowOtherUsers = cfg.commands?.allowOtherUsers === true;
  // The canonical names in features.js always use the default PREFIX, so the
  // alias keys must be sliced with PREFIX, never with a custom configured prefix.
  const aliases = new Map();
  for (const c of COMMANDS) {
    aliases.set(c.name.slice(PREFIX.length).toLowerCase(), c.name);
    for (const a of c.aliases) aliases.set(a.slice(PREFIX.length).toLowerCase(), c.name);
  }

  /** channelId -> Map<messageId, sentAt> for the w/help topic lists. */
  const helpMessages = new Map();

  const say = (msg, text) => msg.channel.send(clip(text)).catch((e) => log('failed to send message:', e?.message || e));

  /** Text plus a select menu; if the API refuses the components the text still goes. */
  async function sayWithMenu(msg, text, components) {
    try {
      return await msg.channel.send({ content: clip(text), components });
    } catch (e) {
      log('select menu rejected, sending plain text instead:', e?.message || e);
      return await say(msg, text);
    }
  }

  async function statusMessage(msg, text) {
    const m = await say(msg, text);
    return {
      msg: m,
      async edit(t) {
        if (!m) return;
        try {
          await m.edit(clip(t));
        } catch {}
      },
      async fail(t) {
        await this.edit(`❌ ${t}`);
      },
    };
  }

  /**
   * The voice channel to stream into: the one the user who typed the command
   * is sitting in, whoever that is. The message's cached member can be missing
   * or stale (another user, an uncached guild), so fall back to a fresh member
   * fetch, then to the account's own channel. config.channelId is only used
   * when nobody is in a voice channel at all.
   */
  async function voiceTarget(msg) {
    const authorId = msg.author?.id || msg.author?.user?.id || null;
    const authorVoice = msg.member?.voice?.channel || null;
    if (authorVoice) return authorVoice;

    const guild = msg.guild || (msg.guildId ? client.guilds?.cache?.get(String(msg.guildId)) : null);
    if (guild && authorId) {
      const member = await guild.members.fetch(authorId).catch(() => null);
      if (member?.voice?.channel) return member.voice.channel;
    }
    return msg.guild?.members?.me?.voice?.channel || null;
  }

  function rememberHelpMessage(channelId, messageId) {
    if (!channelId || !messageId) return;
    const key = String(channelId);
    let m = helpMessages.get(key);
    if (!m) {
      m = new Map();
      helpMessages.set(key, m);
    }
    m.set(String(messageId), Date.now());
    for (const [id, ts] of m) if (Date.now() - ts > HELP_TTL) m.delete(id);
    if (!m.size) helpMessages.delete(key);
  }

  /** True when this message is a reply to a w/help list still inside its window. */
  function isHelpReply(msg) {
    const ref = msg.reference?.messageId;
    if (!ref) return false;
    const m = helpMessages.get(String(msg.channelId));
    if (!m) return false;
    const ts = m.get(String(ref));
    return !!ts && Date.now() - ts <= HELP_TTL;
  }

  async function startPlayback(msg, tracks, status) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const target = await voiceTarget(msg);
    const channel = target || (cfg.channelId ? await client.channels.fetch(cfg.channelId).catch(() => null) : null);
    if (!channel) {
      throw new Error('you are not in a voice channel: join one first, or set channelId in config.json as a fallback');
    }
    const guildId = channel.guildId || msg.guildId || cfg.guildId;

    // one token for the whole run: w/stop bumps it and this loop gives up
    const session = player.newSession();
    let played = 0;

    for (let i = 0; i < list.length; i++) {
      if (!player.isCurrent(session)) {
        await status.edit(`stopped after ${played} of ${list.length} tracks`);
        return;
      }
      const track = list[i];
      const queueNote = list.length > 1 ? ` (${i + 1}/${list.length})` : '';
      const line = `${track.title}${track.artist ? ` - ${track.artist}` : ''}${queueNote}`;
      status.edit(`${line}\npreparing...`);

      const res = await player.play({
        track,
        channelId: channel.id,
        guildId,
        onStatus: (m) => status.edit(`${line}\n${m}`),
      });

      if (res.aborted) {
        await status.edit(`${line}\ncancelled`);
        return;
      }
      played++;

      if (!player.isCurrent(session)) {
        await status.edit(`stopped after ${played} of ${list.length} tracks`);
        return;
      }
      if (list.length > 1) {
        status.edit(`${line}\ndone, ${list.length - played} left`);
        // the voice connection is reused, so the handover to the next track is immediate
        await new Promise((r) => setTimeout(r, 1200));
      } else if (res.ok) {
        status.edit(
          `${line}\ndone - ${res.lyrics} lyric lines, audio: ${res.source}${player.state.offsetMs ? `, offset ${player.state.offsetMs}ms` : ''}`,
        );
      }
    }

    if (list.length > 1) await status.edit(`played ${played} of ${list.length} tracks`);
  }

  async function cmdPlay(msg, arg) {
    if (!arg) {
      return say(msg, `Format: \`${prefix}play <song title | Spotify track, album or playlist link>\``);
    }
    const status = await statusMessage(msg, 'looking for the song...');
    try {
      const req = await resolvePlayable(arg, { cap: Number(cfg.commands?.playlistLimit) || 30 });
      if (req.synthetic) status.edit('Spotify is not configured, searching yt-dlp directly');
      if (req.collection) status.edit(`${req.collection}\nqueued, starting the first track...`);
      await startPlayback(msg, req.tracks, status);
    } catch (e) {
      await status.fail(e.message);
    }
  }

  async function cmdStop(msg) {
    if (!player.state.channelId && !player.playing) return say(msg, '⏹️ no stream is running');
    await player.stop();
    setTimeout(() => say(msg, '⏹️ stream stopped, left the voice channel'), 100);
  }

  async function cmdSync(msg, arg) {
    const ms = Number(String(arg).replace(/[^\d+-]/g, ''));
    if (!Number.isFinite(ms) || ms === 0) {
      return say(msg, `Format: \`${prefix}sync +500\` (lyrics are late) or \`${prefix}sync -500\` (lyrics are early)`);
    }
    if (!player.state.track) return say(msg, '❌ no song is playing right now');
    const st = await statusMessage(msg, '⏱️ shifting the lyric timing...');
    const { prev, next, replay } = await player.nudge(ms);
    const target = await voiceTarget(msg);
    await st.edit(`lyric offset: ${prev}ms -> **${next}ms**\nrebuilding the video now (slides are cached, so this is fast)...`);
    replay({
      track: player.state.track,
      channelId: target?.id || player.state.channelId,
      guildId: target?.guildId || player.guildId,
      onStatus: (m) => st.edit(`offset ${next}ms\n${m}`),
    })
      .then((res) => res?.ok && st.edit(`✅ offset ${next}ms is active, stream restarted from the beginning`))
      .catch((e) => st.fail(e.message));
  }

  /**
   * The only path that reaches the AI. The system prompt keeps it inside this
   * bot's features, so an unrelated question gets a one line refusal.
   */
  async function askAbout(msg, question, { fromReply = false } = {}) {
    if (!aiConfigured()) {
      return say(
        msg,
        `❌ The AI is not configured (set AI_API_URL, AI_API_KEY, AI_MODEL in .env), so only the topics work:\n\n${helpTopicsText(prefix)}`,
      );
    }
    if (msg.channel.sendTyping) {
      try {
        await msg.channel.sendTyping();
      } catch {}
    }
    const st = await statusMessage(msg, '🧠 working out the steps...');
    const user = fromReply
      ? `The user replied to the help topic list with this goal, in their own words: ${question}`
      : question;
    try {
      const answer = await askAI({ system: aiContext(), user, maxTokens: 450 });
      return st.edit(answer);
    } catch (e) {
      return st.fail(`AI request failed: ${e.message}`);
    }
  }

  async function cmdHelp(msg, arg) {
    if (arg) {
      const topic = /^\d+$/.test(arg) ? helpTopicAt(arg) : null;
      if (topic) return say(msg, `**${topic.index + 1}. ${topic.q}**\n\n${topic.a}`);
      return askAbout(msg, arg);
    }
    const sent = await sayWithMenu(msg, helpTopicsText(prefix), [helpMenu()]);
    if (sent?.id) rememberHelpMessage(msg.channelId, sent.id);
    return sent;
  }

  /**
   * Handle a select menu pick.
   *
   * Only builds that dispatch MESSAGE_COMPONENT interactions reach this; the
   * selfbot fork drops that packet, which is why the numeric forms stay.
   */
  async function handleComponent(interaction) {
    if (typeof interaction?.isStringSelectMenu !== 'function' || !interaction.isStringSelectMenu()) return;
    if (!allowOtherUsers && interaction.user?.id !== client.user?.id) return;
    const [kind, channelId] = String(interaction.customId || '').split(':');
    const value = interaction.values?.[0];
    if (value === undefined) return;

    const channel = interaction.channel || (channelId ? await client.channels.fetch(channelId).catch(() => null) : null);
    if (!channel) return;

    const answer = (payload) => {
      const body = { ...payload, content: payload.content ? clip(payload.content) : payload.content };
      const viaUpdate =
        typeof interaction.update === 'function'
          ? Promise.resolve(interaction.update(body)).catch(() => null)
          : Promise.resolve(null);
      return viaUpdate.then((done) => done || Promise.resolve(interaction.reply?.(body)).catch(() => null));
    };

    if (kind === 'help') {
      const topic = helpTopicAt(value);
      if (!topic) return;
      return answer({ content: `**${topic.index + 1}. ${topic.q}**\n\n${topic.a}`, components: [] });
    }

    return undefined;
  }

  async function handleMessage(msg) {
    const content = (msg.content || '').trim();
    const isSelf = msg.author?.id && msg.author.id === client.user?.id;
    if (!isSelf && !allowOtherUsers) return;
    if (onlyChannels.size && !onlyChannels.has(String(msg.channelId))) return;

    if (!content.toLowerCase().startsWith(prefix)) {
      // second way in: a reply to the topic list, no prefix needed, the user just
      // says what they want to do and the AI maps it onto a feature
      if (content && isHelpReply(msg)) return askAbout(msg, content, { fromReply: true });
      return;
    }

    const [rawCmd, ...rest] = content.slice(prefix.length).trim().split(/\s+/);
    const name = aliases.get((rawCmd || '').toLowerCase()) || (rawCmd || '').toLowerCase();
    const arg = rest.join(' ').trim();

    switch (name) {
      case 'w/play':
        return cmdPlay(msg, arg);
      case 'w/stop':
        return cmdStop(msg);
      case 'w/sync':
        return cmdSync(msg, arg);
      case 'w/help':
        return cmdHelp(msg, arg);
      case 'w/listcmd':
        return say(msg, `**Command list**\n${compactList()}`);
      default:
        return;
    }
  }

  client.on('messageCreate', (msg) => {
    handleMessage(msg).catch((e) => log('command error:', e?.stack || e?.message || e));
  });

  client.on('interactionCreate', (interaction) => {
    handleComponent(interaction).catch((e) => log('component error:', e?.stack || e?.message || e));
  });

  if (!COMPONENT_INTERACTIONS) {
    log('this build has no INTERACTION_CREATE handler, so a menu click cannot reach the process; use w/help <n>');
  }

  return {
    prefix,
    handleMessage,
    /** used by CLI mode: run a single command without Discord */
    _internals: { resolvePlayable, startPlayback, voiceTarget, isHelpReply, handleComponent }, 
  };
}
