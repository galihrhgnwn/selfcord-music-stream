#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, envStatus, ENV_KEYS } from './env.js';
import { Client } from '@lng2004/discord.js-selfbot-v13';
import { Streamer } from '@dank074/discord-video-stream';
import { loadLrcFile, fetchSyncedLyrics, sanitize } from './lyrics.js';
import { renderLyricVideo, ffprobeDuration } from './render.js';
import { Player } from './player.js';
import { attachCommands } from './commands.js';
import { commandsText } from './features.js';
import { trackFromQuery } from './track.js';
import { spotifyConfigured } from './spotify.js';
import { aiConfigured } from './ai.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

loadEnv();

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const die = (msg) => {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
};

// keep the stream alive even when the library leaks a stray promise
process.on('unhandledRejection', (e) => console.error('⚠️ unhandledRejection:', e?.message || e));

function parseArgs(argv) {
  const out = { _: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) out[k] = argv[++i];
      else out.flags.add(k);
    } else out._.push(a);
  }
  return out;
}

function loadConfig(args) {
  const file = path.resolve(ROOT, args.config || 'config.json');
  if (!fs.existsSync(file)) die(`Config not found: ${file}\n   Copy it first: cp config.example.json config.json`);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`config.json is not valid JSON: ${e.message}`);
  }
  cfg.__dir = path.dirname(file);
  if (process.env.DISCORD_TOKEN) cfg.token = process.env.DISCORD_TOKEN;
  if (typeof cfg.token === 'string' && (!cfg.token.trim() || /PUT_YOUR_ACCOUNT_TOKEN_HERE|ISI_TOKEN|TOKEN_AKUN|^TOKEN$/i.test(cfg.token))) cfg.token = null;
  if (args.channel) cfg.channelId = args.channel;
  if (args.offset) cfg.lyricOffsetMs = Number(args.offset) || 0;
  return cfg;
}

/** relative paths in the config are resolved against the config folder */
function resolvePath(p, cfg) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(cfg.__dir, p);
}

function printHelpCli() {
  console.log(`
discord-lyrics-stream - Discord selfbot: Go Live lyric video + song audio

Usage:
  node src/index.js                    # auto: serve when a token exists, otherwise render a preview
  node src/index.js serve              # log in and listen for w/* commands
  node src/index.js play "artist - title"
  node src/index.js build              # render the lyric video only (to inspect the result)
  node src/index.js help

Options: --config <file>  --channel <voiceChannelId>  --offset <ms>  --render-only

Commands in Discord:
${commandsText().replace(/\*\*/g, '')}

Service status:
- Spotify: ${spotifyConfigured() ? 'ready' : 'not configured'}
- AI help: ${aiConfigured() ? 'ready' : 'not configured'}

Environment:
${envStatus()}

What each variable is for:
${ENV_KEYS.map(([k, d]) => `- ${k}: ${d}`).join('\n')}
`);
}

async function resolveLyrics(cfg) {
  const lyrFile = resolvePath(cfg.lyricsFile, cfg);
  if (lyrFile) {
    if (!fs.existsSync(lyrFile)) die(`lyricsFile does not exist: ${lyrFile}`);
    log(`Lyrics from file: ${path.basename(lyrFile)}`);
    const parsed = loadLrcFile(lyrFile);
    parsed.lines = sanitize(parsed.lines);
    if (!parsed.lines.length) die('The .lrc file has no timestamped lines. Use the [mm:ss.xx]text format.');
    return parsed;
  }

  const song = cfg.song || {};
  if (!song.title) die('Set song.title or lyricsFile in config.json');
  log(`Looking for synced lyrics on lrclib: ${song.artist ? song.artist + ' - ' : ''}${song.title}`);
  try {
    const parsed = await fetchSyncedLyrics({
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: cfg.audio ? ffprobeDuration(resolvePath(cfg.audio, cfg)) : song.duration,
    });
    if (!parsed) die(`No synced lyrics found for "${song.title}". Use a manual lyricsFile (.lrc).`);
    parsed.lines = sanitize(parsed.lines);
    if (!parsed.lines.length) die('The lyrics returned by lrclib were empty after cleanup.');
    log(`Got ${parsed.lines.length} lines (${parsed.source})`);
    return parsed;
  } catch (e) {
    die(`Failed to fetch lyrics: ${e.message}`);
  }
}

async function buildOnly(cfg, args) {
  const lyrics = await resolveLyrics(cfg);
  const out = resolvePath(cfg.render?.out || 'out/lyrics.mp4', cfg);
  const audio = resolvePath(cfg.audio, cfg);
  const cover = resolvePath(cfg.cover, cfg);
  const force = cfg.render?.force === true || args._.includes('build');

  if (audio && !fs.existsSync(audio)) die(`audio does not exist: ${audio}`);
  if (cover && !fs.existsSync(cover)) die(`cover does not exist: ${cover}`);

  if (!force && fs.existsSync(out)) {
    const st = fs.statSync(out);
    const lrcFile = resolvePath(cfg.lyricsFile, cfg);
    const fresh = lrcFile ? st.mtimeMs >= fs.statSync(lrcFile).mtimeMs : true;
    if (fresh && st.size > 10000) {
      log(`Using the cached video: ${path.relative(ROOT, out)} (${(st.size / 1048576).toFixed(1)} MB)`);
      return out;
    }
  }

  const meta = lyrics.meta || {};
  log(`Rendering the lyric video ${cfg.video?.width || 1280}x${cfg.video?.height || 720} @${cfg.video?.fps || 30}fps -> ${path.relative(ROOT, out)}`);
  const t0 = Date.now();
  const res = await renderLyricVideo({
    lines: lyrics.lines,
    out,
    title: cfg.song?.title || meta.ti || '',
    artist: cfg.song?.artist || meta.ar || '',
    cover,
    audio,
    width: cfg.video?.width || 1280,
    height: cfg.video?.height || 720,
    fps: cfg.video?.fps || 30,
    font: cfg.font ? resolvePath(cfg.font, cfg) : undefined,
    accent: cfg.accent || '8b5cf6',
    offsetMs: Number(cfg.lyricOffsetMs || 0),
    crf: cfg.video?.crf,
    preset: cfg.video?.preset,
    concurrency: cfg.video?.concurrency,
  });
  log(`Render finished in ${((Date.now() - t0) / 1000).toFixed(1)}s, duration ${res.duration.toFixed(1)}s -> ${path.relative(ROOT, res.out)}`);
  return res.out;
}

async function makeClient(cfg) {
  const client = new Client({ checkUpdate: false });
  const streamer = new Streamer(client);
  client.on('error', (e) => console.error('client error:', e?.message || e));
  log('Logging in to Discord...');
  await client.login(cfg.token);
  log(`Logged in as ${client.user.tag}`);
  return { client, streamer };
}

async function serve(cfg) {
  if (!cfg.token) die('Discord token is empty. Put DISCORD_TOKEN in .env, or "token" in config.json');
  const { client, streamer } = await makeClient(cfg);
  const player = new Player({ client, streamer, cfg, log });
  const commands = attachCommands({ client, player, cfg, log });

  log(`Ready. Prefix ${commands.prefix} - type ${commands.prefix}listcmd in Discord.`);
  if (cfg.commands?.channels?.length) log(`Only responding in channels: ${cfg.commands.channels.join(', ')}`);
  else log('Responding in every channel this account can read');
  if (cfg.channelId) log(`Default voice channel: ${cfg.channelId}`);
  log('Waiting for commands... (Ctrl+C to quit)');

  const shutdown = async () => {
    log('Shutting down...');
    try {
      await player.stop();
    } catch {}
    try {
      client.destroy();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

async function playOnce(cfg, args) {
  if (!cfg.token) die('Play mode needs DISCORD_TOKEN (or "token" in config.json)');
  if (!cfg.channelId) die('channelId is empty in config.json');
  const query = args._.slice(1).join(' ').trim() || [cfg.song?.artist, cfg.song?.title].filter(Boolean).join(' ');
  if (!query) die('Give it a song: node src/index.js play "Tulus - Monokrom"');
  const track = await trackFromQuery(query);
  log(`Track: ${track.title}${track.artist ? ' - ' + track.artist : ''}${track.synthetic ? ' (without Spotify)' : ''}`);

  const { client, streamer } = await makeClient(cfg);
  const player = new Player({ client, streamer, cfg, log });
  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) die(`Channel ${cfg.channelId} was not found / not reachable by this account`);

  const res = await player.play({
    track,
    channelId: channel.id,
    guildId: channel.guildId || cfg.guildId,
    onStatus: (m) => log(m),
  });
  log('Finished:', JSON.stringify(res));
  try {
    await player.stop();
  } catch {}
  try {
    client.destroy();
  } catch {}
  process.exit(res?.ok ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = (args._[0] || '').toLowerCase();
  if (mode === 'help' || mode === '-h') return printHelpCli();

  const cfg = loadConfig(args);
  if (mode === 'build') return buildOnly(cfg, args);
  if (mode === 'play') return playOnce(cfg, args);
  if (mode === 'serve') return serve(cfg);
  if (mode && !['build', 'play', 'serve'].includes(mode)) log(`Unknown mode "${mode}", falling back to auto.`);

  if (!cfg.token || args.flags.has('render-only')) {
    await buildOnly(cfg, args);
    log('Render-only mode. Set DISCORD_TOKEN if you want to go live / listen for commands.');
    return;
  }
  return serve(cfg);
}

main().catch((e) => {
  console.error('\n❌ Fatal:', e?.stack || e?.message || e);
  process.exit(1);
});
