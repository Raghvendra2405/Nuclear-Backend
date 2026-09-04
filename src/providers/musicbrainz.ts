// MusicBrainz provider — keyless, authoritative metadata used to broaden search
// coverage (obscure/regional tracks iTunes misses). Cover art comes from the
// Cover Art Archive via a constructed URL (no extra request; may 404 silently).
// Rate limit: ~1 req/sec, and a descriptive User-Agent is required.

import type {
  Album,
  AlbumRef,
  ArtistDetails,
  ArtistRef,
  ArtworkSet,
  ProviderRef,
  Track,
} from '../nuclear-model.js';

import { fetchT } from '../http.js';

const API = 'https://musicbrainz.org/ws/2';
const UA = 'NuclearMobile/0.1 (https://github.com/nukeop/nuclear)';
const PROVIDER = 'musicbrainz';

type MbArtistCredit = { name: string; artist?: { id: string; name: string } };
type MbRelease = {
  id: string;
  title?: string;
  'release-group'?: { id: string; 'primary-type'?: string };
};
type MbRecording = {
  id: string;
  title: string;
  length?: number; // ms
  'artist-credit'?: MbArtistCredit[];
  releases?: MbRelease[];
};

const ref = (id: string, url?: string): ProviderRef => ({ provider: PROVIDER, id, url });

const coverArt = (releaseGroupId?: string): ArtworkSet | undefined => {
  if (!releaseGroupId) return undefined;
  const url = `https://coverartarchive.org/release-group/${releaseGroupId}/front-500`;
  return { items: [{ url, width: 500, height: 500, purpose: 'cover' }] };
};

const toTrack = (r: MbRecording): Track => {
  const credits = r['artist-credit'] ?? [];
  const release = r.releases?.[0];
  const rgid = release?.['release-group']?.id;
  const artwork = coverArt(rgid);
  return {
    title: r.title,
    artists: credits.map((c) => ({
      name: c.artist?.name ?? c.name,
      roles: ['main'],
      source: ref(c.artist?.id ?? ''),
    })),
    album: release
      ? {
          title: release.title ?? '',
          artwork,
          source: ref(rgid ?? release.id),
        }
      : undefined,
    durationMs: r.length,
    artwork,
    source: ref(r.id, `https://musicbrainz.org/recording/${r.id}`),
  };
};

export const searchMusicBrainzTracks = async (
  query: string,
  limit: number,
): Promise<Track[]> => {
  const params = new URLSearchParams({
    query,
    fmt: 'json',
    limit: String(limit),
  });
  const json = await mbFetch<{ recordings?: MbRecording[] }>(
    `recording?${params.toString()}`,
  );
  return (json?.recordings ?? [])
    .filter((r) => !/\b(mashup|megamix|medley|nonstop|jukebox)\b/i.test(r.title))
    .filter((r) => {
      const artist = r['artist-credit']?.[0]?.artist?.name ?? r['artist-credit']?.[0]?.name ?? '';
      return artist.toLowerCase() !== 'various artists';
    })
    .map(toTrack);
};

// --- Artists & albums (fallback for artist/album pages) -----------------------

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isMbid = (id: string): boolean => MBID_RE.test(id);

// MusicBrainz rate-limits to ~1 req/sec and returns 503 when exceeded;
// retry once after a short wait.
const mbFetch = async <T>(path: string, retries = 2): Promise<T | null> => {
  try {
    const res = await fetchT(`${API}/${path}`, { headers: { 'User-Agent': UA } }, 7000);
    if (res.status === 503 && retries > 0) {
      await new Promise((r) => setTimeout(r, 1300));
      return mbFetch<T>(path, retries - 1);
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // network/timeout — one retry
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 800));
      return mbFetch<T>(path, retries - 1);
    }
    return null;
  }
};

type MbArtist = { id: string; name: string; disambiguation?: string };
type MbReleaseGroup = {
  id: string;
  title: string;
  'artist-credit'?: MbArtistCredit[];
  'first-release-date'?: string;
  'primary-type'?: string;
};

const artistToRef = (a: MbArtist): ArtistRef => ({
  name: a.name,
  disambiguation: a.disambiguation || undefined,
  source: ref(a.id, `https://musicbrainz.org/artist/${a.id}`),
});

const rgToAlbumRef = (rg: MbReleaseGroup): AlbumRef => ({
  title: rg.title,
  artists: (rg['artist-credit'] ?? []).map((c) => ({
    name: c.artist?.name ?? c.name,
    source: ref(c.artist?.id ?? ''),
  })),
  artwork: coverArt(rg.id),
  source: ref(rg.id, `https://musicbrainz.org/release-group/${rg.id}`),
});

export const searchMusicBrainzArtists = async (
  query: string,
  limit: number,
): Promise<ArtistRef[]> => {
  const params = new URLSearchParams({ query, fmt: 'json', limit: String(limit) });
  const json = await mbFetch<{ artists?: MbArtist[] }>(`artist?${params.toString()}`);
  return (json?.artists ?? []).map(artistToRef);
};

export const searchMusicBrainzAlbums = async (
  query: string,
  limit: number,
): Promise<AlbumRef[]> => {
  const params = new URLSearchParams({ query, fmt: 'json', limit: String(limit) });
  const json = await mbFetch<{ 'release-groups'?: MbReleaseGroup[] }>(
    `release-group?${params.toString()}`,
  );
  return (json?.['release-groups'] ?? [])
    .filter((rg) => !rg['primary-type'] || /album|ep|single/i.test(rg['primary-type']))
    .map(rgToAlbumRef);
};

export const getMusicBrainzArtist = async (
  mbid: string,
): Promise<ArtistDetails | null> => {
  const artist = await mbFetch<MbArtist & { 'release-groups'?: MbReleaseGroup[] }>(
    `artist/${mbid}?inc=release-groups&fmt=json`,
  );
  if (!artist) return null;

  const albums = (artist['release-groups'] ?? [])
    .filter((rg) => !rg['primary-type'] || /album|ep/i.test(rg['primary-type']))
    .sort((a, b) => (b['first-release-date'] ?? '').localeCompare(a['first-release-date'] ?? ''))
    .map(rgToAlbumRef);

  // MusicBrainz has no popularity ranking, so we surface albums (its strength)
  // rather than an arbitrary, duplicative "top tracks" list.
  return {
    name: artist.name,
    artwork: albums[0]?.artwork,
    genres: undefined,
    topTracks: [],
    albums,
    source: ref(mbid, `https://musicbrainz.org/artist/${mbid}`),
  };
};

type MbTrack = {
  title?: string;
  number?: string;
  position?: number;
  length?: number;
  recording?: { id: string; title?: string; length?: number };
  'artist-credit'?: MbArtistCredit[];
};
type MbFullRelease = {
  id: string;
  title?: string;
  date?: string;
  'artist-credit'?: MbArtistCredit[];
  media?: { tracks?: MbTrack[] }[];
};

export const getMusicBrainzAlbum = async (
  releaseGroupMbid: string,
): Promise<Album | null> => {
  const json = await mbFetch<{ releases?: MbFullRelease[] }>(
    `release?release-group=${releaseGroupMbid}&inc=recordings+artist-credits&limit=25&fmt=json`,
  );
  const releases = json?.releases ?? [];
  if (releases.length === 0) return null;
  // Prefer the release with the most tracks (usually the standard edition).
  const release = releases.reduce((best, r) => {
    const count = (r.media ?? []).reduce((n, m) => n + (m.tracks?.length ?? 0), 0);
    const bestCount = (best.media ?? []).reduce((n, m) => n + (m.tracks?.length ?? 0), 0);
    return count > bestCount ? r : best;
  });

  const artwork = coverArt(releaseGroupMbid);
  const albumArtists = (release['artist-credit'] ?? []).map((c) => ({
    name: c.artist?.name ?? c.name,
    roles: ['main'],
    source: ref(c.artist?.id ?? ''),
  }));

  const tracks: Track[] = (release.media ?? []).flatMap((m) =>
    (m.tracks ?? []).map((t) => ({
      title: t.title ?? t.recording?.title ?? 'Unknown',
      artists: (t['artist-credit'] ?? release['artist-credit'] ?? []).map((c) => ({
        name: c.artist?.name ?? c.name,
        roles: ['main'],
        source: ref(c.artist?.id ?? ''),
      })),
      album: { title: release.title ?? '', artwork, source: ref(releaseGroupMbid) },
      durationMs: t.length ?? t.recording?.length,
      trackNumber: t.position ?? (t.number ? Number(t.number) : undefined),
      artwork,
      source: ref(t.recording?.id ?? '', undefined),
    })),
  );

  return {
    title: release.title ?? 'Unknown album',
    artists: albumArtists,
    tracks,
    releaseDate: release.date ? { precision: 'day', dateIso: release.date } : undefined,
    artwork,
    source: ref(releaseGroupMbid, `https://musicbrainz.org/release-group/${releaseGroupMbid}`),
  };
};
