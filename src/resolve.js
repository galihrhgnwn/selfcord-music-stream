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

function run(cmd, args, { timeoutMs = 300000, onLine, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
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

/**
 * Where yt-dlp lives. A bare name is looked up on PATH, and the name people
 * actually type varies ("ytdlp", "yt-dlp.exe", a Python install), so the
 * configured value is tried first and the usual names after it. Nothing in
 * .env or config.json is rewritten: a wrong value is reported and worked
 * around, never silently overridden on disk.
 */
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

const installDir = (cfg) => path.resolve(cfg.ytdlpInstallDir || path.join(cfg.__dir || process.cwd(), 'bin'));

const localBins = (cfg) => {
  const dir = installDir(cfg);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('yt-dlp') || f === 'ytdlp')
    .map((f) => path.join(dir, f))
    .filter((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    })
    .map((f) => {
      // a build uploaded by hand arrives without the executable bit
      try {
        if (!(fs.statSync(f).mode & 0o100)) fs.chmodSync(f, 0o755);
      } catch {
        /* read-only mount: let the probe report it */
      }
      return { cmd: f, args: [] };
    });
};

const YTDLP_CANDIDATES = (configured, cfg = {}) => {
  const list = [
    configured ? { cmd: configured, args: [] } : null,
    ...localBins(cfg),
    { cmd: 'yt-dlp', args: [] },
    { cmd: 'yt-dlp.exe', args: [] },
    { cmd: 'ytdlp', args: [] },
    { cmd: 'youtube-dl', args: [] },
    { cmd: process.env.PYTHON || 'python3', args: ['-m', 'yt_dlp'] },
    { cmd: 'python', args: ['-m', 'yt_dlp'] },
    { cmd: process.env.PYTHON || 'python3', args: ['-m', 'yt_dlp'], env: { PYTHONPATH: path.join(cfg.__dir || process.cwd(), 'vendor') } },
  ].filter(Boolean);

  const seen = new Set();
  return list.filter((t) => {
    const key = `${t.cmd} ${t.args.join(' ')} ${JSON.stringify(t.env || {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Standalone builds ship one asset per platform; the name decides which. */
function releaseAssets(cfg) {
  if (cfg.ytdlpReleaseAsset) return [cfg.ytdlpReleaseAsset];
  if (process.platform === 'win32') return ['yt-dlp.exe'];
  if (process.platform === 'darwin') return ['yt-dlp_macos'];
  if (process.arch === 'arm64') return ['yt-dlp_linux_aarch64'];
  return ['yt-dlp_linux', 'yt-dlp_linux_x86'];
}

async function probe(tool) {
  const { out } = await run(tool.cmd, [...tool.args, '--version'], { timeoutMs: 30000, env: tool.env });
  return out.trim().split('\n')[0];
}

let ytdlpTool = null;
let installing = null;

/**
 * Get yt-dlp onto this machine when it is not there at all.
 *
 * A container that never had it (a game panel image, a slim distro) reports
 * ENOENT for every name and "No module named yt_dlp" for python, so both
 * routes are tried: a private pip install into ./vendor, then the standalone
 * build from the release page into ./bin. The result is a normal file on
 * disk, so the next start finds it without downloading anything.
 */
export async function installYtdlp(cfg = {}) {
  const root = cfg.__dir || process.cwd();
  const dir = installDir(cfg);
  const attempts = [];
  const py = process.env.PYTHON || 'python3';
  const vendor = path.join(root, 'vendor');

  if (cfg.ytdlpPythonInstall !== false) {
    try {
      await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--target', vendor, 'yt-dlp'], {
        timeoutMs: 300000,
      });
      const tool = { cmd: py, args: ['-m', 'yt_dlp'], env: { PYTHONPATH: vendor } };
      const version = await probe(tool);
      onError(cfg, `yt-dlp: installed the python module into vendor/ (${version})`);
      return tool;
    } catch (e) {
      attempts.push(`pip: ${e.code || e.message.split('\n')[0]}`);
    }
  }

  const base = (cfg.ytdlpReleaseBase || RELEASE_BASE).replace(/\/+$/, '');
  // a host that cannot reach github can still reach one of the plain proxies
  const mirrors = cfg.ytdlpReleaseMirrors || ['', 'https://gh-proxy.com/', 'https://ghfast.top/'];

  for (const asset of releaseAssets(cfg)) {
    const file = path.join(dir, asset.replace(/\.exe$/i, ''));
    const direct = `${base}/${asset}`;
    for (const mirror of mirrors) {
      const url = mirror ? `${mirror}${direct}` : direct;
      try {
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100000) throw new Error(`only ${buf.length} bytes`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${file}.part`, buf, { mode: 0o755 });
        fs.renameSync(`${file}.part`, file);
        fs.chmodSync(file, 0o755);
        const version = await probe({ cmd: file, args: [] });
        onError(cfg, `yt-dlp: downloaded ${asset} to ${path.relative(root, file)} (${version})`);
        return { cmd: file, args: [] };
      } catch (e) {
        attempts.push(`${mirror ? new URL(mirror).host + ': ' : ''}${asset}: ${e.code || e.message.split('\n')[0]}`);
      }
    }
  }

  throw new Error(
    `yt-dlp could not be installed automatically (${attempts.join('; ')}). Drop the standalone build at ${path.join(dir, 'yt-dlp')} or set ytdlpPath in config.json / YTDLP_PATH in .env.`,
  );
}

/** The first candidate that answers --version, remembered for this process. */
export async function resolveYtdlp(cfg = {}) {
  if (ytdlpTool) return ytdlpTool;

  const configured = cfg.ytdlpPath || process.env.YTDLP_PATH || null;
  const tried = [];

  const scan = async () => {
    for (const tool of YTDLP_CANDIDATES(configured, cfg)) {
      try {
        const version = await probe(tool);
        return { tool, version };
      } catch (e) {
        tried.push(`${tool.cmd}${tool.args.length ? ' ' + tool.args.join(' ') : ''} -> ${e.code || e.message.split('\n')[0]}`);
      }
    }
    return null;
  };

  let found = await scan();
  if (!found && cfg.ytdlpAutoInstall !== false) {
    installing = installing || installYtdlp(cfg).catch((e) => ({ error: e }));
    const result = await installing;
    installing = null;
    if (result.error) throw new Error(`${result.error.message} | also tried: ${tried.join('; ')}`);
    ytdlpTool = result;
    return ytdlpTool;
  }

  if (found) {
    ytdlpTool = found.tool;
    if (configured && found.tool.cmd !== configured) {
      onError(cfg, `yt-dlp: "${configured}" did not run, using "${[found.tool.cmd, ...found.tool.args].join(' ')}" (${found.version})`);
    }
    return ytdlpTool;
  }

  throw new Error(
    `yt-dlp was not found and could not be installed. Tried: ${tried.join('; ')}. Install it (pip install -U yt-dlp), drop the standalone build next to the project, or point ytdlpPath in config.json / YTDLP_PATH in .env at the binary.`,
  );
}

/** For tests and diagnostics: forget the cached tool. */
export function resetYtdlpCache() {
  ytdlpTool = null;
  installing = null;
}

const asTool = (bin) => (typeof bin === 'string' ? { cmd: bin, args: [] } : bin);

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
  const tool = await resolveYtdlp(cfg);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  const label = [track.artist, track.title].filter(Boolean).join(' ');
  const picked = await pickBestMatch(track, cfg, tool);
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
  await run(tool.cmd, [...tool.args, ...args], { timeoutMs: cfg.downloadTimeoutMs || 240000 });

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
export async function pickBestMatch(track, cfg, bin) {
  const tool = bin ? asTool(bin) : await resolveYtdlp(cfg);
  const label = [track.artist, track.title].filter(Boolean).join(' ');
  const fields = '%(id)s\t%(view_count)s\t%(duration)s\t%(title)s';
  let out = '';
  try {
    ({ out } = await run(
      tool.cmd,
      [
        ...tool.args,
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
    // a missing binary is not a search miss: report it instead of falling back
    if (e.code === 'ENOENT') {
      throw new Error(
        `yt-dlp could not be started: "${tool.cmd}" is not on PATH. Install it, or point ytdlpPath in config.json / YTDLP_PATH in .env at the binary.`,
      );
    }
    onError(cfg, `${path.basename(tool.cmd)} search failed (${e.message}), using its top result`);
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
