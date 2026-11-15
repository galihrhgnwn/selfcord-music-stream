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
    synthetic: true,
  };
}

/**
 * Free-form query -> track. Spotify is used when configured, otherwise we fall
 * back to a synthetic track (the query is passed through to lrclib + yt-dlp).
 */
export async function trackFromQuery(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('empty song query');
  if (spotifyConfigured()) {
    const results = await searchTracks(q, 5).catch(() => []);
    if (results.length) return results[0];
  }
  return syntheticTrack(q);
}
