// Last.fm provider — recommendations ("similar tracks"). Enabled when
// LASTFM_API_KEY is set. Returned tracks are streamed via yt-dlp by title+artist.

import type { ArtworkSet, ProviderRef, Track } from '../nuclear-model.js';

import { fetchT } from '../http.js';

const API = 'https://ws.audioscrobbler.com/2.0/';
const PROVIDER = 'lastfm';

export const lastfmEnabled = (): boolean => !!process.env.LASTFM_API_KEY;

type LastfmImage = { '#text'?: string; size?: string };
type LastfmSimilar = {
  name: string;
  artist?: { name: string };
  image?: LastfmImage[];
};

const ref = (id: string): ProviderRef => ({ provider: PROVIDER, id });

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Last.fm serves this hash as its "no image" placeholder — treat as no artwork.
const PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

const imageToArtwork = (images?: LastfmImage[]): ArtworkSet | undefined => {
  const url = images?.[images.length - 1]?.['#text'];
  if (!url || url.includes(PLACEHOLDER)) return undefined;
  return { items: [{ url, purpose: 'cover' }] };
};

const toTrack = (t: LastfmSimilar): Track => {
  const artist = t.artist?.name ?? '';
  // Last.fm has no stable track ids; derive one so queue/dedup/keys stay unique.
  const id = `${slug(artist)}--${slug(t.name)}`;
  return {
    title: t.name,
    artists: artist ? [{ name: artist, roles: ['main'], source: ref(slug(artist)) }] : [],
    artwork: imageToArtwork(t.image),
    source: ref(id),
  };
};

export const getSimilarTracks = async (
  artist: string,
  track: string,
  limit = 20,
): Promise<Track[]> => {
  if (!lastfmEnabled()) return [];
  const params = new URLSearchParams({
    method: 'track.getsimilar',
    artist,
    track,
    api_key: process.env.LASTFM_API_KEY!,
    format: 'json',
    limit: String(limit),
    autocorrect: '1',
  });
  const res = await fetchT(`${API}?${params.toString()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { similartracks?: { track?: LastfmSimilar[] } };
  return (json.similartracks?.track ?? []).map(toTrack).filter((t) => t.artists.length > 0);
};

// Fallback when there's no seed track: top tracks for an artist.
export const getArtistTopTracks = async (
  artist: string,
  limit = 20,
): Promise<Track[]> => {
  if (!lastfmEnabled()) return [];
  const params = new URLSearchParams({
    method: 'artist.gettoptracks',
    artist,
    api_key: process.env.LASTFM_API_KEY!,
    format: 'json',
    limit: String(limit),
    autocorrect: '1',
  });
  const res = await fetchT(`${API}?${params.toString()}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { toptracks?: { track?: LastfmSimilar[] } };
  return (json.toptracks?.track ?? []).map(toTrack).filter((t) => t.artists.length > 0);
};
