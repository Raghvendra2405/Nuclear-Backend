// Deezer public API provider — powers the /search endpoint.
// Keyless JSON API (https://api.deezer.com). We map Deezer's shapes onto the
// @nuclearplayer/model shapes mirrored in ../nuclear-model.ts so the mobile app
// receives exactly what the desktop plugin/provider system would return.

import type {
  AlbumRef,
  ArtistRef,
  ArtworkSet,
  ProviderRef,
  SearchCategory,
  SearchResults,
  Track,
} from '../nuclear-model.js';

import { fetchT } from '../http.js';

const DEEZER_API = 'https://api.deezer.com';
const PROVIDER = 'deezer';

type DeezerArtist = {
  id: number;
  name: string;
  picture_small?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
  link?: string;
};

type DeezerAlbum = {
  id: number;
  title: string;
  cover_small?: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
  link?: string;
  artist?: DeezerArtist;
};

type DeezerTrack = {
  id: number;
  title: string;
  duration?: number; // seconds
  link?: string;
  artist?: DeezerArtist;
  album?: DeezerAlbum;
};

type DeezerSearchResponse<T> = {
  data?: T[];
  total?: number;
  error?: { type: string; message: string; code: number };
};

const ref = (id: number | string, url?: string): ProviderRef => ({
  provider: PROVIDER,
  id: String(id),
  url,
});

const artistArtwork = (a?: DeezerArtist): ArtworkSet | undefined => {
  if (!a) return undefined;
  const sizes: Array<[string | undefined, number]> = [
    [a.picture_small, 56],
    [a.picture_medium, 250],
    [a.picture_big, 500],
    [a.picture_xl, 1000],
  ];
  const items = sizes
    .filter(([url]) => Boolean(url))
    .map(([url, size]) => ({
      url: url as string,
      width: size,
      height: size,
      purpose: 'avatar' as const,
    }));
  return items.length ? { items } : undefined;
};

const albumArtwork = (al?: DeezerAlbum): ArtworkSet | undefined => {
  if (!al) return undefined;
  const sizes: Array<[string | undefined, number]> = [
    [al.cover_small, 56],
    [al.cover_medium, 250],
    [al.cover_big, 500],
    [al.cover_xl, 1000],
  ];
  const items = sizes
    .filter(([url]) => Boolean(url))
    .map(([url, size]) => ({
      url: url as string,
      width: size,
      height: size,
      purpose: 'cover' as const,
    }));
  return items.length ? { items } : undefined;
};

const toArtistRef = (a: DeezerArtist): ArtistRef => ({
  name: a.name,
  artwork: artistArtwork(a),
  source: ref(a.id, a.link),
});

const toAlbumRef = (al: DeezerAlbum): AlbumRef => ({
  title: al.title,
  artists: al.artist ? [toArtistRef(al.artist)] : undefined,
  artwork: albumArtwork(al),
  source: ref(al.id, al.link),
});

const toTrack = (t: DeezerTrack): Track => ({
  title: t.title,
  artists: t.artist
    ? [{ name: t.artist.name, roles: ['main'], source: ref(t.artist.id, t.artist.link) }]
    : [],
  album: t.album ? toAlbumRef(t.album) : undefined,
  durationMs: typeof t.duration === 'number' ? t.duration * 1000 : undefined,
  artwork: albumArtwork(t.album),
  source: ref(t.id, t.link),
});

const deezerSearch = async <T>(
  path: string,
  query: string,
  limit: number,
): Promise<T[]> => {
  const url = `${DEEZER_API}/${path}?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetchT(url);
  if (!res.ok) {
    throw new Error(`Deezer ${path} failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as DeezerSearchResponse<T>;
  if (json.error) {
    throw new Error(`Deezer ${path} error: ${json.error.message}`);
  }
  return json.data ?? [];
};

export const search = async (
  query: string,
  types: SearchCategory[],
  limit: number,
): Promise<SearchResults> => {
  const wanted = new Set(types);
  const results: SearchResults = {};
  const tasks: Array<Promise<void>> = [];

  if (wanted.has('artists')) {
    tasks.push(
      deezerSearch<DeezerArtist>('search/artist', query, limit).then((data) => {
        results.artists = data.map(toArtistRef);
      }),
    );
  }
  if (wanted.has('albums')) {
    tasks.push(
      deezerSearch<DeezerAlbum>('search/album', query, limit).then((data) => {
        results.albums = data.map(toAlbumRef);
      }),
    );
  }
  if (wanted.has('tracks')) {
    tasks.push(
      deezerSearch<DeezerTrack>('search/track', query, limit).then((data) => {
        results.tracks = data.map(toTrack);
      }),
    );
  }

  await Promise.all(tasks);
  return results;
};

// --- Playlists (keyless; works from regions where Deezer track search doesn't) --

export type PlaylistSummary = {
  id: string;
  name: string;
  artwork?: ArtworkSet;
  trackCount?: number;
  source: ProviderRef;
};

export type PlaylistDetail = {
  name: string;
  artwork?: ArtworkSet;
  tracks: Track[];
  source: ProviderRef;
};

type DeezerPlaylist = {
  id: number;
  title: string;
  nb_tracks?: number;
  link?: string;
  picture_small?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
  tracks?: { data?: DeezerTrack[] };
  error?: unknown;
};

const playlistArtwork = (p: DeezerPlaylist): ArtworkSet | undefined => {
  const sizes: Array<[string | undefined, number]> = [
    [p.picture_small, 56],
    [p.picture_medium, 250],
    [p.picture_big, 500],
    [p.picture_xl, 1000],
  ];
  const items = sizes
    .filter(([url]) => Boolean(url))
    .map(([url, size]) => ({
      url: url as string,
      width: size,
      height: size,
      purpose: 'cover' as const,
    }));
  return items.length ? { items } : undefined;
};

export const getTopPlaylists = async (limit = 20): Promise<PlaylistSummary[]> => {
  const res = await fetchT(`${DEEZER_API}/chart/0/playlists?limit=${limit}`);
  if (!res.ok) return [];
  const json = (await res.json()) as DeezerSearchResponse<DeezerPlaylist>;
  return (json.data ?? []).map((p) => ({
    id: String(p.id),
    name: p.title,
    artwork: playlistArtwork(p),
    trackCount: p.nb_tracks,
    source: ref(p.id, p.link),
  }));
};

export const getPlaylist = async (id: string): Promise<PlaylistDetail | null> => {
  const res = await fetchT(`${DEEZER_API}/playlist/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const json = (await res.json()) as DeezerPlaylist;
  if (json.error) return null;
  return {
    name: json.title,
    artwork: playlistArtwork(json),
    tracks: (json.tracks?.data ?? []).map(toTrack),
    source: ref(json.id, json.link),
  };
};
