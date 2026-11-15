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
