/**
 * Spotify Web API (client credentials flow).
 * Important: the Spotify API does NOT allow streaming full tracks.
 * It only exposes metadata plus a 30 second preview_url (and that is often null).
 * Full audio is therefore fetched by another resolver (yt-dlp), see resolve.js.
 */

const API = 'https://api.spotify.com/v1';
let cachedToken = null;
let tokenExpiry = 0;

export function spotifyConfigured() {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

export function spotifyIdFromUrl(url) {
  const m = String(url).match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/** Any Spotify collection link: track, album or playlist. */
export function spotifyRefFromUrl(url) {
  const m = String(url).match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/);
  return m ? { type: m[1], id: m[2] } : null;
}

export function isSpotifyUrl(url) {
  return /open\.spotify\.com\//.test(String(url));
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30000) return cachedToken;
  if (!spotifyConfigured()) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set');
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`spotify token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function api(pathname, params) {
  const token = await getToken();
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) throw new Error('spotify rate limit, try again in a moment');
  if (!res.ok) throw new Error(`spotify ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export function mapTrack(t) {
  return {
    id: t.id,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    artists: (t.artists || []).map((a) => a.name),
    album: t.album?.name || null,
    durationMs: t.duration_ms,
    duration: (t.duration_ms || 0) / 1000,
    cover: t.album?.images?.[0]?.url || null,
    previewUrl: t.preview_url || null,
    url: t.external_urls?.spotify || null,
    explicit: Boolean(t.explicit),
    popularity: Number(t.popularity) || 0,
  };
}

export async function searchTracks(query, limit = 6) {
  const data = await api('/search', { q: query, type: 'track', limit });
  return (data.tracks?.items || []).map(mapTrack);
}

export async function getTrack(id) {
  const data = await api(`/tracks/${id}`);
  return mapTrack(data);
}

/** Look up by title + artist only (used by local resolvers without Spotify). */
export async function searchTrackLoose({ title, artist, limit = 5 }) {
  const q = [title, artist].filter(Boolean).join(' ');
  return searchTracks(q, limit);
}

/** Walk a paged track collection (/albums/{id}/tracks, /playlists/{id}/tracks). */
async function pagedTracks(pathname, params, { cap = 50, albumMeta = null } = {}) {
  const tracks = [];
  let offset = 0;
  while (tracks.length < cap) {
    const limit = Math.min(50, cap - tracks.length);
    const data = await api(pathname, { ...params, limit, offset });
    const items = data.items || [];
    if (!items.length) break;
    for (const item of items) {
      const raw = item?.track || item;
      if (!raw?.id) continue;
      // album tracks come back as simplified objects, so the cover is borrowed from the album
      tracks.push(mapTrack(albumMeta ? { ...raw, album: raw.album?.name ? raw.album : albumMeta } : raw));
      if (tracks.length >= cap) break;
    }
    if (!data.next) break;
    offset += items.length;
  }
  return tracks;
}

/**
 * A Spotify link -> the tracks it points at.
 * A track link gives one track, an album or playlist gives its whole track list.
 *
 * @returns {Promise<{kind:string, name:string|null, tracks:object[]}>}
 */
export async function getCollectionTracks(url, { cap = 50 } = {}) {
  const ref = spotifyRefFromUrl(url);
  if (!ref) throw new Error('unrecognized Spotify link, use a track, album or playlist link');

  if (ref.type === 'track') return { kind: 'track', name: null, tracks: [await getTrack(ref.id)] };

  if (ref.type === 'album') {
    const album = await api(`/albums/${ref.id}`, { fields: 'name,images' });
    const albumMeta = { name: album.name, images: album.images || [] };
    const tracks = await pagedTracks(`/albums/${ref.id}/tracks`, { fields: 'items(id,name,artists(name),duration_ms,external_urls,preview_url,explicit),next' }, { cap, albumMeta });
    return { kind: 'album', name: album.name, tracks };
  }

  const playlist = await api(`/playlists/${ref.id}`, { fields: 'name,images' });
  const tracks = await pagedTracks(`/playlists/${ref.id}/tracks`, {}, { cap });
  return { kind: 'playlist', name: playlist.name, tracks };
}
