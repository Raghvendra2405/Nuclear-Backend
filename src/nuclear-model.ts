// Minimal mirror of the types the backend produces from @nuclearplayer/model (v0.0.10).
//
// This backend is a SEPARATE repo, so it can't consume the model package via the
// pnpm workspace protocol. For now these types are hand-kept in sync with
// packages/model/src in the nuclear monorepo. When @nuclearplayer/model is
// published (or we set up a shared-types mechanism), replace this file with a
// real import so app + backend share one source of truth.

export type ProviderRef = {
  provider: string;
  id: string;
  url?: string;
};

export type ArtworkPurpose = 'avatar' | 'cover' | 'background' | 'thumbnail';

export type Artwork = {
  url: string;
  width?: number;
  height?: number;
  purpose?: ArtworkPurpose;
  source?: ProviderRef;
};

export type ArtworkSet = {
  items: Artwork[];
};

export type ArtistCredit = {
  name: string;
  roles: string[];
  source?: ProviderRef;
};

export type ArtistRef = {
  name: string;
  disambiguation?: string;
  artwork?: ArtworkSet;
  source: ProviderRef;
};

export type AlbumRef = {
  title: string;
  artists?: ArtistRef[];
  artwork?: ArtworkSet;
  source: ProviderRef;
};

export type Track = {
  title: string;
  artists: ArtistCredit[];
  album?: AlbumRef;
  durationMs?: number;
  trackNumber?: number;
  artwork?: ArtworkSet;
  source: ProviderRef;
};

export type PlaylistRef = {
  id: string;
  name: string;
  artwork?: ArtworkSet;
  source: ProviderRef;
};

export type TrackRef = {
  title: string;
  artists: ArtistRef[];
  artwork?: ArtworkSet;
  source: ProviderRef;
};

export type Album = {
  title: string;
  artists: ArtistCredit[];
  tracks?: Track[];
  releaseDate?: { precision: 'year' | 'month' | 'day'; dateIso: string };
  genres?: string[];
  artwork?: ArtworkSet;
  source: ProviderRef;
};

// Artist detail page payload (not a single @nuclearplayer/model type — composed
// from what the metadata provider can supply).
export type ArtistDetails = {
  name: string;
  artwork?: ArtworkSet;
  genres?: string[];
  topTracks: Track[];
  albums: AlbumRef[];
  source: ProviderRef;
};

export type DashboardSection = {
  id: string;
  title: string;
  tracks: Track[];
};

export type LyricLine = {
  timeMs: number;
  text: string;
};

export type Lyrics = {
  plain?: string;
  synced?: LyricLine[];
  source: string;
};

export type SearchCategory = 'artists' | 'albums' | 'tracks' | 'playlists';

export type SearchParams = {
  query: string;
  types?: SearchCategory[];
  limit?: number;
};

export type SearchResults = {
  artists?: ArtistRef[];
  albums?: AlbumRef[];
  tracks?: Track[];
  playlists?: PlaylistRef[];
};

export type Stream = {
  url: string;
  protocol: 'file' | 'http' | 'https' | 'hls';
  mimeType?: string;
  bitrateKbps?: number;
  codec?: string;
  container?: string;
  qualityLabel?: string;
  durationMs?: number;
  contentLengthBytes?: number;
  source: ProviderRef;
};

export type StreamCandidate = {
  id: string;
  title: string;
  durationMs?: number;
  thumbnail?: string;
  stream?: Stream;
  lastResolvedAtIso?: string;
  failed: boolean;
  source: ProviderRef;
};
