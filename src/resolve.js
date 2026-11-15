import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ffprobeDuration } from './slides.js';

/**
 * Turn a track (a Spotify search result) into a local audio file.
 *
 * Order:
 *  1. local cache  cache/audio/<id>.<ext>
 *  2. Spotify preview_url (30s, official) when audioSource = "preview"
 *  3. yt-dlp (default) for the full song
 */

function run(cmd, args, { timeoutMs = 300000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${path.basename(cmd)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    p.stdout.on('data', (d) => {
      out += d.toString();
      onLine?.(d.toString());
    });
    p.stderr.on('data', (d) => {
      err += d.toString();
      onLine?.(d.toString());
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(cmd)} exit ${code}: ${err.slice(-600) || out.slice(-300)}`));
    });
  });
}

function findCached(dir, id) {
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${id}.`) && !f.endsWith('.part'));
  return hit ? path.join(dir, hit) : null;
}

async function downloadPreview(track, dir) {
  const res = await fetch(track.previewUrl);
  if (!res.ok) throw new Error(`preview download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(dir, `${track.id}.mp3`);
  fs.writeFileSync(file, buf);
  return file;
}

async function downloadWithYtdlp(track, dir, cfg) {
  const bin = cfg.ytdlpPath || process.env.YTDLP_PATH || 'yt-dlp';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const label = [track.artist, track.title].filter(Boolean).join(' ');
  const picked = await pickBestMatch(track, cfg, bin);
  const target = picked ? `https://www.youtube.com/watch?v=${picked.id}` : `ytsearch1:${label} audio`;
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--no-progress',
    '--socket-timeout',
    '25',
    '--retries',
    '2',
    '-f',
    'bestaudio[ext=m4a]/bestaudio',
    '--max-filesize',
    String(cfg.maxAudioMb || 60) + 'M',
    '-o',
    path.join(tmp, 'audio.%(ext)s'),
    target,
  ];
  await run(bin, args, { timeoutMs: cfg.downloadTimeoutMs || 240000 });

  const produced = fs.readdirSync(tmp).filter((f) => f.startsWith('audio.'));
  if (!produced.length) throw new Error('yt-dlp produced no audio file');
  const src = path.join(tmp, produced[0]);
  const ext = path.extname(src) || '.webm';
  const dest = path.join(dir, `${track.id}${ext}`);
  fs.copyFileSync(src, dest);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  return { file: dest, match: picked };
}

/**
 * "Most listened" for the audio side: list the top YouTube matches and keep the
 * one with the most views. When Spotify already knows the song length, matches
 * that are far off it are dropped first, so a 10 hour loop or a 40s teaser does
 * not win just because it has views.
 */
export async function pickBestMatch(track, cfg, bin = cfg.ytdlpPath || process.env.YTDLP_PATH || 'yt-dlp') {
  const label = [track.artist, track.title].filter(Boolean).join(' ');
  const fields = '%(id)s\t%(view_count)s\t%(duration)s\t%(title)s';
  let out = '';
  try {
    ({ out } = await run(
      bin,
      [
        '--no-warnings',
        '--no-playlist',
        '--flat-playlist',
        '--socket-timeout',
        '20',
        '--retries',
        '1',
        '--print',
        fields,
        `ytsearch10:${label} audio`,
      ],
      { timeoutMs: cfg.searchTimeoutMs || 90000 },
    ));
  } catch (e) {
    onError(cfg, `yt-dlp search failed (${e.message}), using its top result`);
    return null;
  }

  const candidates = out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((r) => r[0] && r[0] !== 'NA')
    .map(([id, views, duration, title]) => ({
      id,
      views: Number(views) || 0,
      duration: Number(duration) || 0,
      title: title || '',
    }));
  if (!candidates.length) return null;

  const want = Number(track.duration) || 0;
  let pool = candidates;
  if (want > 30) {
    const win = Math.max(20, want * 0.25);
    const close = candidates.filter((c) => c.duration > 0 && Math.abs(c.duration - want) <= win);
    if (close.length) pool = close;
  }
  pool.sort((a, b) => b.views - a.views);
  return pool[0];
}

function onError(cfg, message) {
  (cfg.log || console.log)(message);
}

/**
 * @returns {Promise<{file:string, source:string, duration:number|null, match:object|null}>}
 */
export async function resolveAudio(track, cfg, onStatus) {
  const dir = path.resolve(cfg.__dir, cfg.cache?.audio || 'cache/audio');
  fs.mkdirSync(dir, { recursive: true });

  const cached = findCached(dir, track.id);
  if (cached) return { file: cached, source: 'cache', duration: ffprobeDuration(cached), match: null };

  // an audio file picked manually
  if (cfg.audio && !track.id) {
    const local = path.isAbsolute(cfg.audio) ? cfg.audio : path.resolve(cfg.__dir, cfg.audio);
    if (fs.existsSync(local)) return { file: local, source: 'local', duration: ffprobeDuration(local), match: null };
  }

  const mode = cfg.audioSource || 'ytdlp';
  if (mode === 'preview') {
    if (!track.previewUrl) throw new Error('Spotify has no preview for this track, set audioSource to "ytdlp"');
    onStatus?.('downloading the 30s Spotify preview');
    const file = await downloadPreview(track, dir);
    return { file, source: 'spotify-preview', duration: ffprobeDuration(file), match: null };
  }

  onStatus?.(`picking the most listened match on YouTube`);
  const { file, match } = await downloadWithYtdlp(track, dir, cfg);
  if (match) onStatus?.(`matched "${match.title}" (${match.views.toLocaleString('en-US')} views)`);
  return { file, source: 'yt-dlp', duration: ffprobeDuration(file), match: match || null };
}
