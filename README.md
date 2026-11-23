# Nuclear Backend

Content-resolution service for the **Nuclear Mobile** app. It handles search,
metadata, discovery, lyrics, and — critically — turning a track into a playable
audio stream (via `yt-dlp`). The mobile app is a thin client that renders the
JSON this service returns and plays the stream URL, so nothing that can't run on
a phone (binaries, dynamic code) has to.

- **Runtime:** Node 22.12+ / TypeScript, [Fastify 5](https://fastify.dev/) (ESM, NodeNext)
- **Data shapes:** mirror `@nuclearplayer/model` (see `src/nuclear-model.ts`)
- **Everything keyless works out of the box**; Spotify/Last.fm are optional keys.

---

## Running locally

```bash
npm ci
npm run dev      # tsx watch — http://localhost:4000
```

Compiled:

```bash
npm run build    # tsc -> dist/
npm start        # node dist/server.js
```

`npm run type-check` type-checks without emitting. `npm test` builds and checks
the API with simulated providers.

### Configuration

Copy `.env.example` to `.env` (auto-loaded via `process.loadEnvFile`). All keys
are optional — providers no-op gracefully when a key is absent.

| Var | Purpose | Default |
|---|---|---|
| `HOST` | Bind address. Use `127.0.0.1` when the reverse proxy runs on the same host | `0.0.0.0` |
| `PORT` | Listen port | `4000` |
| `LOG_LEVEL` | Structured log level | `info` |
| `NUCLEAR_COUNTRY` | iTunes storefront / charts region (ISO 3166-1 alpha-2) | `in` |
| `LASTFM_API_KEY` | Recommendations ("You might like") | — |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Better track search (needs the app owner to have Spotify Premium; otherwise falls back to iTunes) | — |
| `YTDLP_PATH` | Path to the `yt-dlp` binary | auto-detect |
| `YTDLP_JS_RUNTIME` | yt-dlp JavaScript runtime, for example `node` | `node` in Docker |
| `YTDLP_FORCE_IPV4` | Set to `1` to use IPv4 for yt-dlp | off |
| `YTDLP_COOKIES_FILE` / `YTDLP_COOKIES_B64` | Optional Netscape-format yt-dlp cookie secret. The base64 value takes precedence | unset |
| `POT_PROVIDER_BASE_URL` | URL of the existing PO-token provider | `http://127.0.0.1:4416` in Docker |
| `TRUST_PROXY_HOPS` | Number of trusted reverse proxies that append the client IP | `0` |
| `RESOLVE_CONCURRENCY` | Concurrent uncached yt-dlp resolutions per process | `2` |
| `STREAM_CONCURRENCY` | Concurrent proxied audio responses per process | `32` |

`yt-dlp` must be reachable: set `YTDLP_PATH`, or have `yt-dlp` on `PATH`
(the Docker image bundles it). On Windows it also auto-detects the Nuclear
desktop copy under `%APPDATA%`.

---

## Endpoints

Metadata and resolver responses use `@nuclearplayer/model` shapes.

| Endpoint | Params | Returns |
|---|---|---|
| `GET /health` | — | Process liveness and configured provider status |
| `GET /ready` | — | `200` when yt-dlp passed startup and the configured token provider responds, otherwise `503` |
| `GET /search` | `q` (required), `types` (`artists,albums,tracks`), `limit` (1–100) | `SearchResults` |
| `GET /resolve-stream` | `q` **or** `title` (+`artist`), optional `duration`; **or** `url` (YouTube video) | `StreamCandidate` with a temporary media URL |
| `GET /stream` | `url` (HTTPS googlevideo CDN) | Proxied media bytes with single-range support |
| `GET /artist` | `id` (iTunes numeric or MusicBrainz UUID) | Artist detail (top tracks + albums) |
| `GET /album` | `id` | `Album` with full track listing |
| `GET /dashboard` | `country?` | `{ sections: [{ id, title, tracks }] }` — region-aware charts |
| `GET /discovery` | `artist`, `limit?` | `{ tracks }` |
| `GET /recommendations` | `artist` (required), `track?`, `limit?` | `{ tracks }` (artwork-enriched) |
| `GET /playlists` | `limit?` | `{ playlists }` (Deezer editorial) |
| `GET /playlist` | `id` | Playlist detail with tracks |
| `GET /lyrics` | `title`, `artist`, `duration?` | `{ plain?, synced?: [{ timeMs, text }], source }` |

### The `by` search syntax

`q=red by seedhe maut` is parsed as *title* `red` + *artist* `seedhe maut`. Tracks
are searched on the combined term **and** a fielded MusicBrainz lookup, then
re-ranked so the exact title+artist match leads — this surfaces songs that a
plain search ranks away.

```bash
curl "http://localhost:4000/search?q=red%20by%20seedhe%20maut&types=tracks"
```

### Sources

iTunes (search / artist / album / charts), YouTube via **yt-dlp** (streams),
MusicBrainz (keyless search breadth), Deezer (editorial playlists), Last.fm
(recommendations), Spotify (optional track search), lrclib.net (lyrics).

---

## Production release

Use the [EC2 deployment guide](deploy/ec2/README.md) for instance setup,
HTTPS, playback verification, and rollback.

The root `Dockerfile` supports Linux amd64 and arm64, verifies the bundled
yt-dlp and plugin downloads, and runs both processes as the `node` user. The
token provider listens on `127.0.0.1:4416` inside the container. The EC2 stack
keeps the backend on the Compose network. Caddy publishes ports `80` and `443`
for HTTPS on a domain, or `4000` for HTTP by public IP.

### Verify the release candidate

GitHub Actions runs the build, regression tests, dependency audit, and EC2
stack checks for HTTP and HTTPS readiness and clean shutdown. For a local
container smoke check, run the following commands.

```bash
docker build -t nuclear-backend .
docker run --detach --rm --init --name nuclear-check -p 127.0.0.1:4000:4000 nuclear-backend
curl --fail --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:4000/ready
docker stop nuclear-check
```

## Notes

- **Caching** (`src/cache.ts`, up to 500 entries per process): search 60s, artist/album/dashboard
  10m, playlists 30m, recommendations 5m, lyrics 1h, **resolve-stream 2h** (avoids
  re-running yt-dlp; under the ~6h googlevideo URL lifetime).
- **Provider timeouts** cover response bodies. iTunes is skipped for 30s after
  a failure and search can fall back to MusicBrainz. That fallback uses a short
  queue and starts at most one MusicBrainz request per second per instance.
  [MusicBrainz API limits](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)
- **Playback can vary by host.** YouTube can return sign-in or media errors
  from some networks. Verify extraction and byte-range playback from the chosen
  production host before directing clients to it.
