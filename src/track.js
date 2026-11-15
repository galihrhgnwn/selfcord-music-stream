import crypto from 'node:crypto';
import { searchTracks, spotifyConfigured } from './spotify.js';

/** Placeholder track used when no Spotify credentials are available. */
export function syntheticTrack(query) {
  const id = 'q' + crypto.createHash('sha1').update(String(query).toLowerCase()).digest('hex').slice(0, 12);
  const parts = String(query).split(/\s+-\s+/);
  const hasArtist = parts.length > 1;
  return {
    id,
    title: hasArtist ? parts.slice(1).join(' - ') : String(query),
    artist: hasArtist ? parts[0] : '',
    artists: hasArtist ? [parts[0]] : [],
    album: null,
    durationMs: 0,
    duration: 0,
    cover: null,
    previewUrl: null,
    url: null,
    popularity: 0,
    synthetic: true,
  };
}

/**
 * The same title can match a live version, a cover, a remix or the original.
 * "Most listened" is the tie breaker: the highest Spotify popularity wins.
 */
export function pickMostPopular(results) {
  if (!Array.isArray(results) || !results.length) return null;
  return results.reduce((best, cur) => ((cur?.popularity || 0) > (best?.popularity || 0) ? cur : best), results[0]);
}

/**
 * Free-form query -> track. Spotify is used when configured (and the most
 * popular match wins), otherwise we fall back to a synthetic track so the
 * query still reaches lrclib and yt-dlp.
 */
export async function trackFromQuery(query, { limit = 10 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('empty song query');
  if (spotifyConfigured()) {
    const results = await searchTracks(q, limit).catch(() => []);
    const best = pickMostPopular(results);
    if (best) return { ...best, pickedBy: 'popularity' };
  }
  return syntheticTrack(q);
}
