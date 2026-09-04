// iTunes Search API provider — powers the /search endpoint.
//
// Keyless JSON API (https://itunes.apple.com/search). Chosen as the first working
// provider because Deezer's public API withholds track/album `data` (returns only
// `total`) from some regions — see ./deezer.ts. iTunes returns full results with
// artwork globally. We map its shapes onto the @nuclearplayer/model shapes
// mirrored in ../nuclear-model.ts.

import type {
  Album,
  AlbumRef,
  ArtistDetails,
  ArtistRef,
  ArtworkSet,
  DashboardSection,
  ProviderRef,
  SearchCategory,
  SearchResults,
  Track,
} from '../nuclear-model.js';

import { fetchT } from '../http.js';

const ITUNES_API = 'https://itunes.apple.com/search';
const PROVIDER = 'itunes';

// Storefront/region for iTunes (search, lookup, charts). Defaults to India;
// override with NUCLEAR_COUNTRY (ISO 3166-1 alpha-2, e.g. "us", "gb").
const COUNTRY = (process.env.NUCLEAR_COUNTRY ?? 'in').toLowerCase();

// Circuit breaker: iTunes' CDN is intermittently unreachable from some networks.
// After a failure, skip iTunes for 30s so requests fail instantly (and fall back
// to MusicBrainz) instead of waiting on a timeout every time.
let itunesDownUntil = 0;
const ITUNES_TIMEOUT_MS = 4000;

const itunesGet = async (url: string): Promise<Response> => {
  if (Date.now() < itunesDownUntil) {
    throw new Error('iTunes circuit open');
  }
  try {
    const res = await fetchT(url, {}, ITUNES_TIMEOUT_MS);
    if (!res.ok) throw new Error(`iTunes ${res.status} ${res.statusText}`);
    return res;
  } catch (err) {
    itunesDownUntil = Date.now() + 30_000;
    throw err;
  }
};

type ItunesResult = {
  wrapperType?: string;
  artistId?: number;
  artistName?: string;
  artistViewUrl?: string;
  artistLinkUrl?: string;
  collectionId?: number;
  collectionName?: string;
  collectionViewUrl?: string;
  trackId?: number;
  trackName?: string;
  trackViewUrl?: string;
  trackTimeMillis?: number;
  trackNumber?: number;
  artworkUrl60?: string;
  artworkUrl100?: string;
  primaryGenreName?: string;
  releaseDate?: string;
};

type ItunesResponse = {
  resultCount: number;
  results: ItunesResult[];
};

const ref = (id: number | string, url?: string): ProviderRef => ({
  provider: PROVIDER,
  id: String(id),
  url,
});

// iTunes artwork URLs look like ".../100x100bb.jpg"; swap the dimensions to
// request larger sizes from the same CDN.
const artworkAt = (url: string, size: number): string =>
  url.replace(/\/\d+x\d+bb\.(jpg|png)/i, `/${size}x${size}bb.$1`);

const artwork = (
  url: string | undefined,
  purpose: 'cover' | 'avatar',
): ArtworkSet | undefined => {
  if (!url) return undefined;
  const sizes = [100, 300, 600];
  return {
    items: sizes.map((size) => ({
      url: artworkAt(url, size),
      width: size,
      height: size,
      purpose,
    })),
  };
};

const toArtistRef = (r: ItunesResult): ArtistRef => ({
  name: r.artistName ?? 'Unknown artist',
  source: ref(r.artistId ?? '', r.artistLinkUrl ?? r.artistViewUrl),
});

const toAlbumRef = (r: ItunesResult): AlbumRef => ({
  title: r.collectionName ?? 'Unknown album',
  artists: r.artistName
    ? [{ name: r.artistName, source: ref(r.artistId ?? '', r.artistViewUrl) }]
    : undefined,
  artwork: artwork(r.artworkUrl100, 'cover'),
  source: ref(r.collectionId ?? '', r.collectionViewUrl),
});

const toTrack = (r: ItunesResult): Track => ({
  title: r.trackName ?? 'Unknown track',
  artists: r.artistName
    ? [{ name: r.artistName, roles: ['main'], source: ref(r.artistId ?? '', r.artistViewUrl) }]
    : [],
  album: r.collectionName ? toAlbumRef(r) : undefined,
  durationMs: r.trackTimeMillis,
  trackNumber: r.trackNumber,
  artwork: artwork(r.artworkUrl100, 'cover'),
  source: ref(r.trackId ?? '', r.trackViewUrl),
});

const itunesSearch = async (
  query: string,
  entity: 'song' | 'album' | 'musicArtist',
  limit: number,
): Promise<ItunesResult[]> => {
  const url = `${ITUNES_API}?term=${encodeURIComponent(query)}&entity=${entity}&limit=${limit}&country=${COUNTRY}`;
  const res = await itunesGet(url);
  const json = (await res.json()) as ItunesResponse;
  return json.results ?? [];
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
      itunesSearch(query, 'musicArtist', limit).then((data) => {
        results.artists = data.map(toArtistRef);
      }),
    );
  }
  if (wanted.has('albums')) {
    tasks.push(
      itunesSearch(query, 'album', limit).then((data) => {
        results.albums = data.map(toAlbumRef);
      }),
    );
  }
  if (wanted.has('tracks')) {
    tasks.push(
      itunesSearch(query, 'song', limit).then((data) => {
        results.tracks = data.map(toTrack);
      }),
    );
  }

  await Promise.all(tasks);
  return results;
};

// --- Lookup-based detail endpoints ---------------------------------------------

const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';

const itunesLookup = async (
  id: string,
  entity: 'song' | 'album',
  limit: number,
): Promise<ItunesResult[]> => {
  const url = `${ITUNES_LOOKUP}?id=${encodeURIComponent(id)}&entity=${entity}&limit=${limit}&country=${COUNTRY}`;
  const res = await itunesGet(url);
  const json = (await res.json()) as ItunesResponse;
  return json.results ?? [];
};

const releaseDateOf = (iso?: string): Album['releaseDate'] =>
  iso ? { precision: 'day', dateIso: iso } : undefined;

export const getArtist = async (
  id: string,
  limit = 20,
): Promise<ArtistDetails | null> => {
  // Two lookups: the artist + its top songs, and the artist + its albums.
  const [songRes, albumRes] = await Promise.all([
    itunesLookup(id, 'song', limit),
    itunesLookup(id, 'album', limit),
  ]);

  const artistRow =
    songRes.find((r) => r.wrapperType === 'artist') ??
    albumRes.find((r) => r.wrapperType === 'artist');
  if (!artistRow && songRes.length === 0 && albumRes.length === 0) return null;

  const songs = songRes.filter((r) => r.wrapperType === 'track');
  const albums = albumRes.filter((r) => r.wrapperType === 'collection');

  // iTunes has no artist artwork; fall back to the newest album cover.
  const fallbackArt = albums[0] ? artwork(albums[0].artworkUrl100, 'avatar') : undefined;

  return {
    name: artistRow?.artistName ?? songs[0]?.artistName ?? 'Unknown artist',
    artwork: fallbackArt,
    genres: artistRow?.primaryGenreName ? [artistRow.primaryGenreName] : undefined,
    topTracks: songs.map(toTrack),
    albums: albums.map(toAlbumRef),
    source: ref(id, artistRow?.artistLinkUrl ?? artistRow?.artistViewUrl),
  };
};

export const getAlbum = async (
  id: string,
): Promise<Album | null> => {
  const rows = await itunesLookup(id, 'song', 200);
  const collection = rows.find((r) => r.wrapperType === 'collection');
  if (!collection) return null;

  const tracks = rows
    .filter((r) => r.wrapperType === 'track')
    .sort((a, b) => (a.trackNumber ?? 0) - (b.trackNumber ?? 0))
    .map(toTrack);

  return {
    title: collection.collectionName ?? 'Unknown album',
    artists: collection.artistName
      ? [
          {
            name: collection.artistName,
            roles: ['main'],
            source: ref(collection.artistId ?? '', collection.artistViewUrl),
          },
        ]
      : [],
    tracks,
    releaseDate: releaseDateOf(collection.releaseDate),
    genres: collection.primaryGenreName ? [collection.primaryGenreName] : undefined,
    artwork: artwork(collection.artworkUrl100, 'cover'),
    source: ref(id, collection.collectionViewUrl),
  };
};

// --- Dashboard (Apple Marketing RSS charts) -----------------------------------

// Legacy iTunes RSS feed entry (the newer marketing-tools RSS is region-blocked
// from some locations, so we use the classic feed).
type RssEntry = {
  'im:name'?: { label?: string };
  'im:artist'?: { label?: string };
  'im:image'?: { label?: string }[];
  id?: { label?: string; attributes?: { 'im:id'?: string } };
};

const legacyRss = async (
  country: string,
  kind: string,
  limit: number,
): Promise<RssEntry[]> => {
  if (Date.now() < itunesDownUntil) return [];
  const url = `https://itunes.apple.com/${country}/rss/${kind}/limit=${limit}/json`;
  try {
    const res = await fetchT(url, {}, ITUNES_TIMEOUT_MS);
    if (!res.ok) return [];
    const json = (await res.json()) as { feed?: { entry?: RssEntry[] } };
    return json.feed?.entry ?? [];
  } catch {
    itunesDownUntil = Date.now() + 30_000;
    return [];
  }
};

const rssToTrack = (e: RssEntry): Track => {
  const images = e['im:image'] ?? [];
  const image = images[images.length - 1]?.label;
  return {
    title: e['im:name']?.label ?? 'Unknown',
    artists: [{ name: e['im:artist']?.label ?? 'Unknown', roles: ['main'], source: ref('') }],
    artwork: artwork(image, 'cover'),
    source: ref(e.id?.attributes?.['im:id'] ?? '', e.id?.label),
  };
};

export const getDashboard = async (
  country = COUNTRY,
  limit = 25,
): Promise<DashboardSection[]> => {
  const songs = await legacyRss(country, 'topsongs', limit);
  const sections: DashboardSection[] = [];
  if (songs.length) {
    sections.push({ id: 'top-songs', title: 'Top Songs', tracks: songs.map(rssToTrack) });
  }
  return sections;
};

// --- Discovery ----------------------------------------------------------------

// "More like this" — keyless approximation: top songs matching the seed artist.
export const getDiscovery = async (
  artistName: string,
  limit = 20,
): Promise<Track[]> => {
  const rows = await itunesSearch(artistName, 'song', limit);
  return rows.map(toTrack);
};

// Best-effort cover-art lookup for a track known only by name (e.g. Last.fm
// recommendations, which ship no usable image). Returns undefined on any miss
// (empty result, or iTunes circuit open) so callers can fall back gracefully.
export const lookupArtwork = async (
  title: string,
  artistName: string,
): Promise<ArtworkSet | undefined> => {
  try {
    const term = [artistName, title].filter(Boolean).join(' ').trim();
    if (!term) return undefined;
    const rows = await itunesSearch(term, 'song', 1);
    return artwork(rows[0]?.artworkUrl100, 'cover');
  } catch {
    return undefined;
  }
};
