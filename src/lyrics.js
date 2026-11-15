import fs from 'node:fs';

/**
 * LRC parser plus the synced-lyrics fetcher for lrclib.net.
 */

const TS_RE = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const WORD_TS_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function toSeconds(mm, rest) {
  return parseInt(mm, 10) * 60 + parseFloat(String(rest).replace(':', '.'));
}

/**
 * @param {string} text contents of an .lrc file
 * @returns {{meta: Record<string,string>, lines: {time:number,text:string}[]}}
 */
export function parseLrc(text) {
  const meta = {};
  const out = [];
  let offset = 0;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const withoutWordTags = line.replace(WORD_TS_RE, '');

    // metadata tags, e.g. [ti:Title] [ar:Artist] [offset:-250]
    let stripped = withoutWordTags;
    for (const m of withoutWordTags.matchAll(/\[([a-zA-Z_#]+):([^\]]*)\]/g)) {
      const key = m[1].toLowerCase();
      if (key === 'offset') offset = parseFloat(m[2]) || 0;
      else meta[key] = m[2].trim();
      stripped = stripped.split(m[0]).join('');
    }

    // collect every numeric timestamp, wherever it sits on the line
    const stamps = [];
    for (const m of stripped.matchAll(TS_RE)) {
      stamps.push(toSeconds(m[1], m[2]));
    }
    const lyricText = stripped.replace(TS_RE, '').trim();
    if (!stamps.length) continue;

    for (const s of stamps) {
      out.push({ time: s, text: lyricText });
    }
  }

  out.sort((a, b) => a.time - b.time);
  const delta = offset / 1000;
  if (delta) for (const l of out) l.time = Math.max(0, l.time + delta);

  return { meta, lines: out };
}

export function loadLrcFile(file) {
  return parseLrc(fs.readFileSync(file, 'utf8'));
}

const LRCLIB_HEADERS = {
  'User-Agent': 'discord-lyrics-stream/1.0.0 (https://github.com/local)',
  'Lrclib-Client': 'discord-lyrics-stream/1.0.0 (https://github.com/local)',
};

async function lrclibJson(url) {
  const res = await fetch(url, { headers: LRCLIB_HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lrclib ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Fetch synced lyrics from lrclib.net.
 * @param {{artist?:string,title:string,album?:string,duration?:number}} q
 */
export async function fetchSyncedLyrics(q) {
  const params = new URLSearchParams();
  if (q.artist) params.set('artist_name', q.artist);
  params.set('track_name', q.title);
  if (q.album) params.set('album_name', q.album);
  if (q.duration) params.set('duration', String(Math.round(q.duration)));

  let hit = null;
  try {
    hit = await lrclibJson(`https://lrclib.net/api/get?${params}`);
  } catch {
    hit = null;
  }

  if (!hit || !hit.syncedLyrics) {
    const sParams = new URLSearchParams();
    if (q.artist) sParams.set('artist_name', q.artist);
    sParams.set('track_name', q.title);
    let results = [];
    try {
      results = (await lrclibJson(`https://lrclib.net/api/search?${sParams}`)) || [];
    } catch {
      results = [];
    }
    const synced = results.filter((r) => r && r.syncedLyrics);
    if (synced.length) {
      synced.sort((a, b) => {
        const da = q.duration ? Math.abs(a.duration - q.duration) : 0;
        const db = q.duration ? Math.abs(b.duration - q.duration) : 0;
        return da - db;
      });
      hit = synced[0];
    }
  }

  if (!hit) return null;
  if (!hit.syncedLyrics) {
    throw new Error(
      `lrclib only has unsynced lyrics for "${hit.trackName}" (${hit.artistName}). Use a manual .lrc file instead.`,
    );
  }

  const parsed = parseLrc(hit.syncedLyrics);
  parsed.meta.ti = parsed.meta.ti || hit.trackName || q.title;
  parsed.meta.ar = parsed.meta.ar || hit.artistName || q.artist || '';
  parsed.meta.al = parsed.meta.al || hit.albumName || '';
  parsed.source = `lrclib:${hit.id}`;
  return parsed;
}

/** Drop consecutive duplicates and trim every line. */
export function sanitize(lines) {
  const cleaned = lines
    .map((l) => ({ time: Math.max(0, Number(l.time) || 0), text: String(l.text ?? '').trim() }))
    .filter((l) => l.text.length > 0);
  const dedup = [];
  for (const l of cleaned) {
    const last = dedup[dedup.length - 1];
    if (last && last.time === l.time && last.text === l.text) continue;
    dedup.push(l);
  }
  return dedup;
}
