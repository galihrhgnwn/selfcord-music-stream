import crypto from 'node:crypto';
import {
  searchTracks,
  spotifyConfigured,
  isSpotifyUrl,
  spotifyRefFromUrl,
  getTrack,
  getCollectionTracks,
} from './spotify.js';

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

/**
 * A command argument (a title or a Spotify link) -> the tracks to play.
 *
 *  - a Spotify track link      -> that one track
 *  - a Spotify album/playlist  -> every playable track, in order, capped
 *  - any other text            -> the most popular match for that text
 *
 * The returned track list is what the lyrics are looked up for, so whatever
 * comes back here is what the stream shows.
 */
export async function resolvePlayable(arg, { cap = 30 } = {}) {
  const raw = String(arg || '').trim();
  if (!raw) throw new Error('empty song query');

  if (isSpotifyUrl(raw)) {
    if (!spotifyConfigured()) {
      throw new Error('a Spotify link needs SPOTIFY_CLIENT_ID & SPOTIFY_CLIENT_SECRET in .env');
    }
    const ref = spotifyRefFromUrl(raw);
    if (!ref) throw new Error('unrecognized Spotify link, use a track, album or playlist link');
    if (ref.type === 'track') return { tracks: [await getTrack(ref.id)] };

    const collection = await getCollectionTracks(raw, { cap: Number(cap) || 30 });
    if (!collection.tracks.length) throw new Error(`that ${collection.kind} has no playable tracks`);
    return {
      tracks: collection.tracks,
      collection: `${collection.kind} "${collection.name}" (${collection.tracks.length} tracks)`,
    };
  }

  const track = await trackFromQuery(raw);
  return { tracks: [track], synthetic: Boolean(track.synthetic) };
}
