import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Minimal .env loader, no dependencies. */
export function loadEnv(file) {
  const p = file || process.env.ENV_FILE || path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return false;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

export const ENV_KEYS = [
  ['DISCORD_TOKEN', 'Discord account token (optional, can also live in config.json)'],
  ['SPOTIFY_CLIENT_ID', 'needed for Spotify search and metadata'],
  ['SPOTIFY_CLIENT_SECRET', 'needed for Spotify search and metadata'],
  ['AI_API_URL', 'OpenAI-compatible endpoint used by w/help'],
  ['AI_API_KEY', 'API key for the AI endpoint (optional)'],
  ['AI_MODEL', 'defaults to gpt-4o-mini'],
  ['YTDLP_PATH', 'path to the yt-dlp binary (default: found on PATH)'],
];

export function envStatus() {
  return ENV_KEYS.map(([k, desc]) => {
    const v = process.env[k];
    const secret = k.toLowerCase().includes('key') || k.includes('SECRET') || k.includes('TOKEN');
    const shown = !v ? 'empty' : secret ? 'set (hidden)' : 'set';
    return `- ${k}: ${shown} - ${desc}`;
  }).join('\n');
}
