import { PREFIX, COMMANDS, commandsText, compactList, aiContext } from './features.js';
import { isSpotifyUrl, spotifyIdFromUrl, getTrack, spotifyConfigured, searchTracks } from './spotify.js';
import { trackFromQuery } from './track.js';
import { askAI, aiConfigured } from './ai.js';

const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
const CANCEL_EMOJI = '❌';
const AI_HELP_TTL = 10 * 60 * 1000;

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
  let helpCache = { at: 0, text: null };

  const say = (msg, text) => msg.channel.send(clip(text)).catch((e) => log('failed to send message:', e?.message || e));

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
      ...results.map((t, i) => `${NUM_EMOJI[i]} **${t.title}** - ${t.artist} \`${fmtDur(t.duration)}\``),
      '',
      `React with a number to play it, or type \`${prefix}play <number>\`.`,
    ].join('\n');
    await status.edit(text);

    const target = status.msg;
    if (!target) return;
    try {
      for (let i = 0; i < results.length; i++) await target.react(NUM_EMOJI[i]);
      await target.react(CANCEL_EMOJI);
    } catch (e) {
      log('failed to add reactions:', e?.message || e);
      return;
    }

    // wait a moment so the selfbot's own reactions are not collected as input
    await new Promise((r) => setTimeout(r, 1800));
    let collected;
    try {
      collected = await target.awaitReactions({ max: 1, time: 60000, errors: ['time'] });
    } catch {
      return;
    }
    const reaction = collected.first();
    if (!reaction) return;
    const idx = NUM_EMOJI.indexOf(reaction.emoji.name);
    if (idx === -1 || !results[idx]) return;
    const picked = results[idx];
    const st2 = await statusMessage(msg, `▶️ **${picked.title}** - ${picked.artist}\npicked from the list, preparing...`);
    try {
      await startPlayback(msg, picked, st2);
    } catch (e) {
      await st2.fail(e.message);
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

  async function cmdHelp(msg, arg) {
    const base = commandsText();
    if (arg) {
      if (!aiConfigured()) {
        return say(msg, `❌ AI is not configured (set AI_API_URL, AI_API_KEY, AI_MODEL in .env)\n\n${base}`);
      }
      if (!msg.channel.sendTyping) {
        /* noop */
      } else {
        try {
          await msg.channel.sendTyping();
        } catch {}
      }
      const st = await statusMessage(msg, '🧠 thinking...');
      try {
        const answer = await askAI({ system: aiContext(), user: arg, maxTokens: 450 });
        return st.edit(answer);
      } catch (e) {
        return st.fail(`AI request failed: ${e.message}`);
      }
    }

    let intro = '';
    if (aiConfigured()) {
      if (Date.now() - helpCache.at > AI_HELP_TTL) {
        try {
          const t = await askAI({
            system: aiContext(),
            user: 'Write one opening paragraph (max 3 sentences) for a Discord help message: what this project is for and when to use it. No command list.',
            maxTokens: 200,
          });
          helpCache = { at: Date.now(), text: t };
        } catch {}
      }
      intro = helpCache.text ? `💡 ${helpCache.text}\n\n` : '';
    }
    return say(
      msg,
      `${intro}**Available commands**\n\n${base}\n\nAsk anything: \`${prefix}help <question>\`${aiConfigured() ? ' (answered by AI)' : ' (needs AI_API_URL)'}`,
    );
  }

  async function handleMessage(msg) {
    const content = (msg.content || '').trim();
    if (!content.toLowerCase().startsWith(prefix)) return;
    const isSelf = msg.author?.id && msg.author.id === client.user?.id;
    if (!isSelf && !allowOtherUsers) return;
    if (onlyChannels.size && !onlyChannels.has(String(msg.channelId))) return;

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

  return {
    prefix,
    handleMessage,
    /** used by CLI mode: run a single command without Discord */
    _internals: { findTrack, voiceTarget },
  };
}
