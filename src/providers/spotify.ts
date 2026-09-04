// Spotify provider — high-accuracy track search/metadata via the Web API
// (client-credentials). Spotify can't provide playable audio, so tracks are
// still streamed through yt-dlp by title + artist. Enabled when
// SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET are set.

import type { ArtworkSet, ProviderRef, Track } from '../nuclear-model.js';

import { fetchT } from '../http.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const MARKET = (process.env.NUCLEAR_COUNTRY ?? 'in').toUpperCase();
const PROVIDER = 'spotify';

// Spotify's 2025 policy requires the app owner to have Premium for Web API
// access; a 403 means this app can't be used, so we stop trying after the first.
let blocked = false;

export const spotifyEnabled = (): boolean =>
  !blocked && !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);

let cached: { token: string; expiresAt: number } | null = null;

const getToken = async (): Promise<string | null> => {
  if (!spotifyEnabled()) return null;
  if (cached && cached.expiresAt > Date.now() + 5000) return cached.token;

  const creds = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
  ).toString('base64');
  const res = await fetchT(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
};

type SpotifyImage = { url: string; width?: number; height?: number };
type SpotifyArtist = { id: string; name: string; external_urls?: { spotify?: string } };
type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms?: number;
  track_number?: number;
  artists?: SpotifyArtist[];
  album?: {
    id: string;
    name: string;
    images?: SpotifyImage[];
    external_urls?: { spotify?: string };
  };
  external_urls?: { spotify?: string };
};

const ref = (id: string, url?: string): ProviderRef => ({ provider: PROVIDER, id, url });

const imagesToArtwork = (
  images: SpotifyImage[] | undefined,
  purpose: 'cover' | 'avatar',
): ArtworkSet | undefined => {
  if (!images?.length) return undefined;
  return {
    items: images.map((img) => ({
      url: img.url,
      width: img.width,
      height: img.height,
      purpose,
    })),
  };
};

const toTrack = (t: SpotifyTrack): Track => ({
  title: t.name,
  artists: (t.artists ?? []).map((a) => ({
    name: a.name,
    roles: ['main'],
    source: ref(a.id, a.external_urls?.spotify),
  })),
  album: t.album
    ? {
        title: t.album.name,
        artwork: imagesToArtwork(t.album.images, 'cover'),
        source: ref(t.album.id, t.album.external_urls?.spotify),
      }
    : undefined,
  durationMs: t.duration_ms,
  trackNumber: t.track_number,
  artwork: imagesToArtwork(t.album?.images, 'cover'),
  source: ref(t.id, t.external_urls?.spotify),
});

export const searchSpotifyTracks = async (
  query: string,
  limit: number,
): Promise<Track[]> => {
  const token = await getToken();
  if (!token) return [];
  const params = new URLSearchParams({
    q: query,
    type: 'track',
    limit: String(limit),
    market: MARKET,
  });
  const res = await fetchT(`${API}/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // 403 = app owner lacks Premium (Spotify policy); disable to avoid retries.
    if (res.status === 403) blocked = true;
    return [];
  }
  const json = (await res.json()) as { tracks?: { items?: SpotifyTrack[] } };
  return (json.tracks?.items ?? []).map(toTrack);
};
