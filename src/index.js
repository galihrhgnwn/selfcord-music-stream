#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, envStatus, ENV_KEYS } from './env.js';
import { Client } from '@lng2004/discord.js-selfbot-v13';
import { Streamer } from '@dank074/discord-video-stream';
import { Player } from './player.js';
import { attachCommands } from './commands.js';
import { commandsText } from './features.js';
import { resolvePlayable } from './track.js';
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
  node src/index.js                              # auto: serve when a token exists, otherwise build
  node src/index.js serve                        # log in and listen for w/* commands
  node src/index.js build "<song | Spotify link>"  # render the lyric video only, no Discord
  node src/index.js play  "<song | Spotify link>"  # stream it once in the configured channel
  node src/index.js help

The lyrics always belong to the song being played: build, play and w/play all
resolve the song first, then look up its lyrics.

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

/** One-line description used in the logs. */
function describe(track) {
  return `${track.title}${track.artist ? ` - ${track.artist}` : ''}${track.synthetic ? ' (without Spotify)' : ''}`;
}

/** Resolve the CLI argument the same way w/play does. */
async function trackFromArgs(cfg, args, { cap = 30 } = {}) {
  const query = args._.slice(1).join(' ').trim() || (typeof args.song === 'string' ? args.song.trim() : '');
  if (!query) die('Give it a song: node src/index.js build "Tulus - Monokrom" (a title or a Spotify link)');
  const req = await resolvePlayable(query, { cap });
  for (const t of req.tracks) log(`Track: ${describe(t)}`);
  if (req.collection) log(`Collection: ${req.collection}`);
  return req;
}

/**
 * Render the lyric video for one song and stop there: no Discord, no stream.
 * The song is resolved first, so the rendered lyrics are the ones of that
 * song, exactly like the live path.
 */
async function buildOnly(cfg, args) {
  const req = await trackFromArgs(cfg, args, { cap: 1 });
  const track = req.tracks[0];
  const player = new Player({ client: null, streamer: null, cfg, log });
  const { audio, lyrics, video } = await player.renderOnly(track, (m) => log(m));

  const out = resolvePath(cfg.render?.out || 'out/lyrics.mp4', cfg);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (path.resolve(video.file) !== path.resolve(out)) fs.copyFileSync(video.file, out);
  log(`${lyrics.lines.length} lyric lines for "${track.title}", ${Math.round(video.duration || 0)}s of audio via ${audio.source}`);
  log(`Video: ${out}${video.cached ? ' (reused a cached build)' : ''}`);
  return out;
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
  const req = await trackFromArgs(cfg, args, { cap: Number(cfg.commands?.playlistLimit) || 30 });

  const { client, streamer } = await makeClient(cfg);
  const player = new Player({ client, streamer, cfg, log });
  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) die(`Channel ${cfg.channelId} was not found / not reachable by this account`);

  for (const track of req.tracks) {
    const res = await player.play({
      track,
      channelId: channel.id,
      guildId: channel.guildId || cfg.guildId,
      onStatus: (m) => log(m),
    });
    log('Finished:', JSON.stringify(res));
    if (!res.ok) break;
  }

  try {
    await player.stop();
  } catch {}
  try {
    client.destroy();
  } catch {}
  process.exit(0);
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
