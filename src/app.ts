import './env.js'; // must be first — loads .env before providers read keys

import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController } from 'fastify';

import { cached } from './cache.js';
import { envInteger } from './env.js';
import { fetchT } from './http.js';
import type { SearchCategory, SearchResults, Track } from './nuclear-model.js';
import { youtubeVideoUrl } from './playback-urls.js';
import { getPlaylist, getTopPlaylists } from './providers/deezer.js';
// iTunes is the metadata backbone (consistent ids for artist/album pages).
import {
  getAlbum,
  getArtist,
  getDashboard,
  getDiscovery,
  lookupArtwork,
  search,
} from './providers/itunes.js';
import { getArtistTopTracks, getSimilarTracks, lastfmEnabled } from './providers/lastfm.js';
import { getLyrics } from './providers/lyrics.js';
import {
  getMusicBrainzAlbum,
  getMusicBrainzArtist,
  isMbid,
  searchMusicBrainzAlbums,
  searchMusicBrainzArtists,
  searchMusicBrainzTracks,
} from './providers/musicbrainz.js';
import { searchSpotifyTracks, spotifyEnabled } from './providers/spotify.js';
import { checkYtDlp, resolveStream, StreamNotFoundError } from './providers/ytdlp.js';
import { proxyAudio } from './stream-proxy.js';

const SUPPORTED_TYPES: SearchCategory[] = ['artists', 'albums', 'tracks'];

const trustProxyHops = envInteger('TRUST_PROXY_HOPS', 0, 0, 8);
export const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  logController: new LogController({ disableRequestLogging: true }),
  requestTimeout: 15_000,
  connectionTimeout: 30_000,
  forceCloseConnections: 'idle',
  trustProxy: trustProxyHops > 0 ? (_address, hop) => hop < trustProxyHops : false,
  ajv: { customOptions: { coerceTypes: false } },
});

await app.register(rateLimit, {
  max: 240,
  timeWindow: '1 minute',
});

app.addHook('onSend', async (request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  const route = request.routeOptions.url;
  if (route === '/resolve-stream' || route === '/stream' || route === '/ready') {
    reply.header('Cache-Control', 'no-store');
  }
});

app.addHook('onResponse', async (request, reply) => {
  const route = request.routeOptions.url;
  if ((route === '/health' || route === '/ready') && reply.statusCode === 200) return;
  request.log.info({ method: request.method, route, status: reply.statusCode, ms: reply.elapsedTime }, 'request completed');
});

const textQuery = (maxLength: number) => ({ type: 'string', maxLength });
const querySchema = (properties: Record<string, ReturnType<typeof textQuery>>) => ({
  querystring: { type: 'object', properties },
});

function parseLimit(raw: string | undefined, max: number): number {
  return Math.min(Math.max(Math.trunc(Number(raw)) || 20, 1), max);
}

const probeOptions = { config: { rateLimit: false } } as const;
let ytdlpReady = false;
app.addHook('onReady', async () => {
  try {
    await checkYtDlp();
    ytdlpReady = true;
  } catch (err) {
    app.log.error({ err }, 'yt-dlp startup check failed');
  }
});

app.get('/ready', probeOptions, async (_request, reply) => {
  let providerReady = true;
  const provider = process.env.POT_PROVIDER_BASE_URL;
  if (ytdlpReady && provider) {
    try {
      const response = await fetchT(`${provider.replace(/\/$/, '')}/ping`, { redirect: 'error' }, 2000);
      providerReady = response.ok;
      await response.body?.cancel();
    } catch {
      providerReady = false;
    }
  }
  const ok = ytdlpReady && providerReady;
  return reply.code(ok ? 200 : 503).send({ ok });
});

app.get('/health', probeOptions, async () => ({
  ok: true,
  service: 'nuclear-backend',
  providers: {
    itunes: true,
    ytdlp: ytdlpReady,
    musicbrainz: true,
    deezerPlaylists: true,
    lyrics: true,
    spotify: spotifyEnabled(),
    lastfm: lastfmEnabled(),
  },
}));

type SearchQuery = { q?: string; types?: string; limit?: string };

// "song by artist" query. Left of the last standalone " by " is the title,
// right is the artist — so titles that themselves contain "by" still work
// (e.g. "Stand By Me by Ben E. King"). Returns null when the syntax isn't used.
function parseByQuery(q: string): { title: string; artist: string } | null {
  const m = q.match(/^(.+)\s+by\s+(.+)$/i);
  if (!m) return null;
  const title = (m[1] ?? '').trim();
  const artist = (m[2] ?? '').trim();
  return title && artist ? { title, artist } : null;
}

const includesCI = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

// Drop duplicate tracks (same title + first artist), keeping the first seen —
// iTunes is merged before MusicBrainz so its artwork wins.
function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const t of tracks) {
    const key = `${(t.title ?? '').toLowerCase()}|${(t.artists?.[0]?.name ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// For a "song by artist" query, float exact title+artist matches to the top so
// the intended (possibly low-ranked) track leads instead of popular namesakes.
function rerankByTitleArtist(tracks: Track[], title: string, artist: string): Track[] {
  const score = (t: Track): number =>
    (includesCI(t.title ?? '', title) ? 2 : 0) +
    ((t.artists ?? []).some((a) => includesCI(a.name, artist)) ? 1 : 0);
  return tracks
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}

app.get('/search', { schema: querySchema({ q: textQuery(300), types: textQuery(80), limit: textQuery(16) }) }, async (request, reply) => {
  const { q, types, limit } = request.query as SearchQuery;

  const query = q?.trim();
  if (!query) {
    return reply.code(400).send({ error: 'Missing required query param "q"' });
  }

  const parsedLimit = parseLimit(limit, 100);
  const spotifyLimit = Math.min(parsedLimit, 50); // Spotify caps search at 50

  const requestedTypes = types
    ? types
        .split(',')
        .map((t) => t.trim())
        .filter((t): t is SearchCategory =>
          (SUPPORTED_TYPES as string[]).includes(t),
        )
    : SUPPORTED_TYPES;

  const effectiveTypes = requestedTypes.length ? requestedTypes : SUPPORTED_TYPES;

  // "song by artist" syntax: tracks search on the combined "title artist" and
  // are augmented with a fielded MusicBrainz lookup, so an exact but low-ranked
  // track surfaces; artists/albums search on just the artist name.
  const by = parseByQuery(query);
  const trackTerm = by ? `${by.title} ${by.artist}` : query;
  const entityTerm = by ? by.artist : query;

  // Cache merged results for 60s. Each source is best-effort so a hiccup in one
  // (e.g. iTunes timeout) doesn't fail the whole search.
  const results = await cached(
    JSON.stringify(['search', query, effectiveTypes, parsedLimit]),
    60_000,
    async () => {
      const merged: SearchResults = {};
      const wantTracks = effectiveTypes.includes('tracks');
      const entityTypes = effectiveTypes.filter((t) => t !== 'tracks');

      // iTunes (metadata backbone). With "by", tracks and artists/albums use
      // different terms, so run them as separate searches.
      try {
        if (by) {
          const [trackRes, entityRes] = await Promise.all([
            wantTracks ? search(trackTerm, ['tracks'], parsedLimit) : Promise.resolve({}),
            entityTypes.length ? search(entityTerm, entityTypes, parsedLimit) : Promise.resolve({}),
          ]);
          Object.assign(merged, entityRes, trackRes);
        } else {
          Object.assign(merged, await search(query, effectiveTypes, parsedLimit));
        }
      } catch (err) {
        request.log.warn({ err }, 'iTunes search failed; falling back to other sources');
      }

      // Spotify (when the app owner has Premium) — more accurate tracks.
      if (spotifyEnabled() && wantTracks) {
        try {
          const spotifyTracks = await searchSpotifyTracks(trackTerm, spotifyLimit);
          if (spotifyTracks.length) merged.tracks = spotifyTracks;
        } catch {
          // best-effort
        }
      }

      // MusicBrainz. For a "by" query, always merge a fielded lookup (obscure
      // exact matches iTunes ranks away); otherwise only fill an empty type.
      if (wantTracks) {
        try {
          if (by) {
            const mbTracks = await searchMusicBrainzTracks(
              `recording:"${by.title}" AND artist:"${by.artist}"`,
              parsedLimit,
            );
            merged.tracks = dedupeTracks([...(merged.tracks ?? []), ...mbTracks]);
          } else if ((merged.tracks?.length ?? 0) === 0) {
            merged.tracks = await searchMusicBrainzTracks(query, parsedLimit);
          }
        } catch {
          // best-effort
        }
      }
      if (effectiveTypes.includes('artists') && (merged.artists?.length ?? 0) === 0) {
        try {
          merged.artists = await searchMusicBrainzArtists(entityTerm, parsedLimit);
        } catch {
          // best-effort
        }
      }
      if (effectiveTypes.includes('albums') && (merged.albums?.length ?? 0) === 0) {
        try {
          merged.albums = await searchMusicBrainzAlbums(entityTerm, parsedLimit);
        } catch {
          // best-effort
        }
      }

      // Surface the intended track first for a "by" query.
      if (by && merged.tracks?.length) {
        merged.tracks = rerankByTitleArtist(merged.tracks, by.title, by.artist);
      }
      return merged;
    },
  );

  return results;
});

type ResolveStreamQuery = {
  q?: string;
  title?: string;
  artist?: string;
  url?: string;
  duration?: string;
};

const resolveConcurrency = envInteger('RESOLVE_CONCURRENCY', 2, 1, 16);
let activeResolutions = 0;
class ResolverBusyError extends Error {}

// Resolve a playable audio stream for a track. Accepts a free-text `q`, or a
// `title` (+ optional `artist`) which are combined into a search query, or a
// direct `url`. Returns a StreamCandidate (with a nested Stream).
app.get('/resolve-stream', {
  schema: querySchema({ q: textQuery(300), title: textQuery(200), artist: textQuery(200), url: textQuery(2048), duration: textQuery(16) }),
  config: { rateLimit: { max: 30 } },
}, async (request, reply) => {
  const { q, title, artist, url, duration } = request.query as ResolveStreamQuery;

  const query =
    q?.trim() || [artist?.trim(), title?.trim()].filter(Boolean).join(' ') || undefined;
  const directUrl = url?.trim() ? youtubeVideoUrl(url.trim()) : undefined;
  const durationSec = duration ? Number(duration) : undefined;

  if (url?.trim() && !directUrl) {
    return reply.code(400).send({ error: 'Provide a YouTube video URL' });
  }
  if (durationSec !== undefined && (!Number.isFinite(durationSec) || durationSec < 0)) {
    return reply.code(400).send({ error: 'Duration must be a non-negative number of seconds' });
  }

  if (!query && !directUrl) {
    return reply
      .code(400)
      .send({ error: 'Provide "q" (or "title" [+ "artist"]) or a "url"' });
  }
  if (!ytdlpReady) return reply.code(503).send({ error: 'Stream resolver is unavailable' });

  try {
    // Cache the resolution (the slow yt-dlp step) for 2h — under the ~6h
    // googlevideo URL lifetime — so repeat plays are instant.
    const candidate = await cached(
      JSON.stringify(['resolve', directUrl, query, durationSec]),
      2 * 60 * 60 * 1000,
      async () => {
        if (activeResolutions >= resolveConcurrency) throw new ResolverBusyError();
        activeResolutions++;
        try {
          return await resolveStream({ query, url: directUrl, durationSec });
        } finally {
          activeResolutions--;
        }
      },
    );
    return candidate;
  } catch (err) {
    if (err instanceof ResolverBusyError) {
      return reply.header('Retry-After', '2').code(503).send({ error: 'Stream resolver is busy' });
    }
    if (err instanceof StreamNotFoundError) {
      return reply.code(404).send({ error: err.message });
    }
    const reason = err instanceof SyntaxError ? 'Invalid yt-dlp response' : (err as Error).message;
    request.log.error({ reason }, 'resolve-stream failed');
    return reply.code(502).send({ error: 'Stream resolution failed' });
  }
});

// Artist detail: top tracks + albums for an iTunes artist id.
app.get('/artist', { schema: querySchema({ id: textQuery(80) }) }, async (request, reply) => {
  const { id } = request.query as { id?: string };
  if (!id?.trim()) {
    return reply.code(400).send({ error: 'Missing required query param "id"' });
  }
  const trimmed = id.trim();
  try {
    // MusicBrainz ids (UUIDs) → MusicBrainz; numeric ids → iTunes.
    const artist = await cached(`artist:${trimmed}`, 10 * 60 * 1000, () =>
      isMbid(trimmed) ? getMusicBrainzArtist(trimmed) : getArtist(trimmed),
    );
    if (!artist) return reply.code(404).send({ error: 'Artist not found' });
    return artist;
  } catch (err) {
    request.log.error({ err }, 'artist failed');
    return reply.code(502).send({ error: 'Failed to load artist' });
  }
});

// Album detail: metadata + track listing for an iTunes collection id.
app.get('/album', { schema: querySchema({ id: textQuery(80) }) }, async (request, reply) => {
  const { id } = request.query as { id?: string };
  if (!id?.trim()) {
    return reply.code(400).send({ error: 'Missing required query param "id"' });
  }
  const trimmed = id.trim();
  try {
    const album = await cached(`album:${trimmed}`, 10 * 60 * 1000, () =>
      isMbid(trimmed) ? getMusicBrainzAlbum(trimmed) : getAlbum(trimmed),
    );
    if (!album) return reply.code(404).send({ error: 'Album not found' });
    return album;
  } catch (err) {
    request.log.error({ err }, 'album failed');
    return reply.code(502).send({ error: 'Failed to load album' });
  }
});

// Home dashboard: chart sections (region-aware via `country`).
app.get('/dashboard', { schema: querySchema({ country: textQuery(2) }) }, async (request, reply) => {
  const { country } = request.query as { country?: string };
  try {
    // No country → provider default (India).
    const key = `dashboard:${country ? country.toLowerCase() : 'default'}`;
    const sections = await cached(key, 10 * 60 * 1000, () =>
      getDashboard(country ? country.toLowerCase() : undefined),
    );
    return { sections };
  } catch (err) {
    request.log.error({ err }, 'dashboard failed');
    return reply.code(502).send({ error: 'Failed to load dashboard' });
  }
});

// Discovery: "more like this" tracks for a seed artist.
app.get('/discovery', { schema: querySchema({ artist: textQuery(200), limit: textQuery(16) }) }, async (request, reply) => {
  const { artist, limit } = request.query as { artist?: string; limit?: string };
  if (!artist?.trim()) {
    return reply.code(400).send({ error: 'Missing required query param "artist"' });
  }
  const parsedLimit = parseLimit(limit, 50);
  try {
    const tracks = await getDiscovery(artist.trim(), parsedLimit);
    return { tracks };
  } catch (err) {
    request.log.error({ err }, 'discovery failed');
    return reply.code(502).send({ error: 'Failed to load discovery' });
  }
});

// Top / editorial playlists (Deezer, keyless).
app.get('/playlists', { schema: querySchema({ limit: textQuery(16) }) }, async (request, reply) => {
  const { limit } = request.query as { limit?: string };
  const parsedLimit = parseLimit(limit, 50);
  try {
    const playlists = await cached(`playlists:${parsedLimit}`, 30 * 60 * 1000, () =>
      getTopPlaylists(parsedLimit),
    );
    return { playlists };
  } catch (err) {
    request.log.error({ err }, 'playlists failed');
    return reply.code(502).send({ error: 'Failed to load playlists' });
  }
});

// Playlist detail (track listing) — playable via yt-dlp.
app.get('/playlist', { schema: querySchema({ id: textQuery(80) }) }, async (request, reply) => {
  const { id } = request.query as { id?: string };
  if (!id?.trim()) {
    return reply.code(400).send({ error: 'Missing required query param "id"' });
  }
  try {
    const playlist = await cached(`playlist:${id.trim()}`, 10 * 60 * 1000, () =>
      getPlaylist(id.trim()),
    );
    if (!playlist) return reply.code(404).send({ error: 'Playlist not found' });
    return playlist;
  } catch (err) {
    request.log.error({ err }, 'playlist failed');
    return reply.code(502).send({ error: 'Failed to load playlist' });
  }
});

// Recommendations ("more like this"): Last.fm similar tracks when a seed track
// is given, else the artist's top tracks, falling back to iTunes discovery.
app.get('/recommendations', {
  schema: querySchema({ artist: textQuery(200), track: textQuery(200), limit: textQuery(16) }),
}, async (request, reply) => {
  const { artist, track, limit } = request.query as {
    artist?: string;
    track?: string;
    limit?: string;
  };
  if (!artist?.trim()) {
    return reply.code(400).send({ error: 'Missing required query param "artist"' });
  }
  const parsedLimit = parseLimit(limit, 50);
  try {
    const tracks = await cached(
      JSON.stringify(['rec', artist.trim().toLowerCase(), track?.trim().toLowerCase(), parsedLimit]),
      5 * 60 * 1000,
      async () => {
        let result = [] as Awaited<ReturnType<typeof getSimilarTracks>>;
        if (track?.trim() && lastfmEnabled()) {
          result = await getSimilarTracks(artist.trim(), track.trim(), parsedLimit);
        }
        if (result.length === 0 && lastfmEnabled()) {
          result = await getArtistTopTracks(artist.trim(), parsedLimit);
        }
        if (result.length === 0) {
          result = await getDiscovery(artist.trim(), parsedLimit);
        }
        // Last.fm tracks ship no usable cover art, so recommendation tiles and
        // the now-playing/skip UI fall back to a placeholder. Enrich any track
        // missing artwork with an iTunes cover (best-effort, in parallel).
        await Promise.all(
          result.map(async (t) => {
            if (t.artwork?.items?.length) return;
            const art = await lookupArtwork(t.title, t.artists[0]?.name ?? '');
            if (art) t.artwork = art;
          }),
        );
        return result;
      },
    );
    return { tracks };
  } catch (err) {
    request.log.error({ err }, 'recommendations failed');
    return reply.code(502).send({ error: 'Failed to load recommendations' });
  }
});

// Lyrics (plain + synced) for a track.
app.get('/lyrics', {
  schema: querySchema({ title: textQuery(200), artist: textQuery(200), duration: textQuery(16) }),
}, async (request, reply) => {
  const { title, artist, duration } = request.query as {
    title?: string;
    artist?: string;
    duration?: string;
  };
  if (!title?.trim() || !artist?.trim()) {
    return reply
      .code(400)
      .send({ error: 'Provide both "title" and "artist"' });
  }
  const durationSec = duration ? Number(duration) : undefined;
  if (durationSec !== undefined && (!Number.isFinite(durationSec) || durationSec < 0)) {
    return reply.code(400).send({ error: 'Duration must be a non-negative number of seconds' });
  }
  try {
    const lyrics = await cached(
      JSON.stringify(['lyrics', title.trim().toLowerCase(), artist.trim().toLowerCase(), durationSec]),
      60 * 60 * 1000,
      () => getLyrics(title.trim(), artist.trim(), durationSec),
    );
    if (!lyrics) return reply.code(404).send({ error: 'No lyrics found' });
    return lyrics;
  } catch (err) {
    request.log.error({ err }, 'lyrics failed');
    return reply.code(502).send({ error: 'Failed to load lyrics' });
  }
});

app.route({
  method: ['GET', 'HEAD'],
  url: '/stream',
  schema: querySchema({ url: textQuery(12_000) }),
  config: { rateLimit: { max: 120 } },
  handler: proxyAudio,
});
