import { PREFIX, COMMANDS, commandsText, compactList, aiContext, helpTopicsText, helpTopicAt } from './features.js';
import { isSpotifyUrl, spotifyIdFromUrl, getTrack, spotifyConfigured, searchTracks } from './spotify.js';
import { trackFromQuery } from './track.js';
import { askAI, aiConfigured } from './ai.js';
import { COMPONENT_INTERACTIONS, helpMenu, searchMenu } from './ui.js';

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

  const lastSearch = new Map();
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

  function voiceTarget(msg) {
    const ch = msg.member?.voice?.channel || msg.guild?.members?.me?.voice?.channel || null;
    return ch;
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

  async function findTrack(arg) {
    if (isSpotifyUrl(arg)) {
      if (!spotifyConfigured()) throw new Error('a Spotify link needs SPOTIFY_CLIENT_ID & SPOTIFY_CLIENT_SECRET in .env');
      const id = spotifyIdFromUrl(arg);
      if (!id) throw new Error('unrecognized Spotify link (it must be a track link)');
      return await getTrack(id);
    }
    return await trackFromQuery(arg);
  }

  async function startPlayback(msg, track, status) {
    const target = voiceTarget(msg);
    const channel = target || (cfg.channelId ? await client.channels.fetch(cfg.channelId).catch(() => null) : null);
    if (!channel) throw new Error('you are not in a voice channel, and no default channelId is usable either');
    const guildId = channel.guildId || msg.guildId || cfg.guildId;

    const line = `▶️ **${track.title}**${track.artist ? ` - ${track.artist}` : ''}`;
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
    if (res.ok) {
      await status.edit(
        `${line}\n✅ done • ${res.lyrics} lyric lines • audio: ${res.source}${player.state.offsetMs ? ` • offset ${player.state.offsetMs}ms` : ''}`,
      );
    }
  }

  async function cmdPlay(msg, arg) {
    if (!arg) return say(msg, `Format: \`${prefix}play <song title | spotify link | search result number>\``);
    const status = await statusMessage(msg, '🔎 searching for the song...');
    const n = Number(arg);
    const stored = lastSearch.get(msg.channelId);
    try {
      let track;
      if (Number.isInteger(n) && n > 0 && stored && stored[n - 1]) {
        track = stored[n - 1];
        status.edit(`picked: **${track.title}** - ${track.artist}`);
      } else {
        track = await findTrack(arg);
        if (track.synthetic) status.edit('Spotify is not configured, using a direct search (yt-dlp)');
      }
      await startPlayback(msg, track, status);
    } catch (e) {
      await status.fail(e.message);
    }
  }

  async function cmdSearch(msg, arg) {
    if (!spotifyConfigured()) return say(msg, '❌ Search needs SPOTIFY_CLIENT_ID & SPOTIFY_CLIENT_SECRET in .env');
    if (!arg) return say(msg, `Format: \`${prefix}search <keywords>\``);
    const status = await statusMessage(msg, '🔎 searching Spotify...');
    let results;
    try {
      results = await searchTracks(arg, 6);
    } catch (e) {
      return status.fail(e.message);
    }
    if (!results.length) return status.fail(`no results for "${arg}"`);

    lastSearch.set(msg.channelId, results);
    const text = [
      `**Results for "${arg}"**`,
      '',
      ...results.map((t, i) => `\`${i + 1}\`. **${t.title}** - ${t.artist} \`${fmtDur(t.duration)}\``),
      '',
      `Pick one from the menu below, or type \`${prefix}play <number>\`.`,
    ].join('\n');
    await status.edit(`found ${results.length} results, menu below`);
    await sayWithMenu(msg, text, [searchMenu(results, msg.channelId)]);
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
    const target = voiceTarget(msg);
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

    if (kind === 'search') {
      const results = lastSearch.get(channelId) || lastSearch.get(channel.id) || [];
      const picked = results[Number(value)];
      if (!picked) return answer({ content: 'that list expired, run the search again', components: [] });

      answer({ content: `**${picked.title}** - ${picked.artist}\npicked from the list, preparing...`, components: [] });
      const ctx = {
        channel,
        channelId: channel.id,
        guild: channel.guild || interaction.guild || null,
        guildId: channel.guildId || interaction.guildId || cfg.guildId,
        member: interaction.member || null,
      };
      const st = await statusMessage(ctx, 'preparing...');
      try {
        await startPlayback(ctx, picked, st);
      } catch (e) {
        await st.fail(e.message);
      }
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
      case 'w/search':
        return cmdSearch(msg, arg);
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
    log('this build has no INTERACTION_CREATE handler, so a menu click cannot reach the process; use w/play <n> or w/help <n>');
  }

  return {
    prefix,
    handleMessage,
    /** used by CLI mode: run a single command without Discord */
    _internals: { findTrack, voiceTarget, isHelpReply, handleComponent, lastSearch }, 
  };
}
