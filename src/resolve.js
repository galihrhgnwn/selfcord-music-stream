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
  const query = `ytsearch1:${[track.artist, track.title].filter(Boolean).join(' ')} audio`;
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
    query,
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
  return dest;
}

/**
 * @returns {Promise<{file:string, source:string, duration:number|null}>}
 */
export async function resolveAudio(track, cfg, onStatus) {
  const dir = path.resolve(cfg.__dir, cfg.cache?.audio || 'cache/audio');
  fs.mkdirSync(dir, { recursive: true });

  const cached = findCached(dir, track.id);
  if (cached) return { file: cached, source: 'cache', duration: ffprobeDuration(cached) };

  // an audio file picked manually
  if (cfg.audio && !track.id) {
    const local = path.isAbsolute(cfg.audio) ? cfg.audio : path.resolve(cfg.__dir, cfg.audio);
    if (fs.existsSync(local)) return { file: local, source: 'local', duration: ffprobeDuration(local) };
  }

  const mode = cfg.audioSource || 'ytdlp';
  if (mode === 'preview') {
    if (!track.previewUrl) throw new Error('Spotify has no preview for this track, set audioSource to "ytdlp"');
    onStatus?.('downloading the 30s Spotify preview');
    const file = await downloadPreview(track, dir);
    return { file, source: 'spotify-preview', duration: ffprobeDuration(file) };
  }

  onStatus?.(`downloading the full song (yt-dlp)`);
  const file = await downloadWithYtdlp(track, dir, cfg);
  return { file, source: 'yt-dlp', duration: ffprobeDuration(file) };
}
