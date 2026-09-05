# Nuclear Backend

Content-resolution service for the **Nuclear Mobile** app. It handles search,
metadata, discovery, lyrics, and — critically — turning a track into a playable
audio stream (via `yt-dlp`). The mobile app is a thin client that renders the
JSON this service returns and plays the stream URL, so nothing that can't run on
a phone (binaries, dynamic code) has to.

- **Runtime:** Node 22+ / TypeScript, [Fastify 5](https://fastify.dev/) (ESM, NodeNext)
- **Data shapes:** mirror `@nuclearplayer/model` (see `src/nuclear-model.ts`)
- **Everything keyless works out of the box**; Spotify/Last.fm are optional keys.

---

## Running locally

```bash
npm install
npm run dev      # tsx watch — http://localhost:4000
```

Compiled:

```bash
npm run build    # tsc -> dist/
npm start        # node dist/server.js
```

`npm run type-check` type-checks without emitting.

### Configuration

Copy `.env.example` to `.env` (auto-loaded via `process.loadEnvFile`). All keys
are optional — providers no-op gracefully when a key is absent.

| Var | Purpose | Default |
|---|---|---|
| `PORT` | Listen port | `4000` |
| `NUCLEAR_COUNTRY` | iTunes storefront / charts region (ISO 3166-1 alpha-2) | `in` |
| `LASTFM_API_KEY` | Recommendations ("You might like") | — |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Better track search (needs the app owner to have Spotify Premium; otherwise falls back to iTunes) | — |
| `YTDLP_PATH` | Path to the `yt-dlp` binary | auto-detect |

`yt-dlp` must be reachable: set `YTDLP_PATH`, or have `yt-dlp` on `PATH`
(the Docker image bundles it). On Windows it also auto-detects the Nuclear
desktop copy under `%APPDATA%`.

---

## Endpoints

All responses are `@nuclearplayer/model`-shaped JSON.

| Endpoint | Params | Returns |
|---|---|---|
| `GET /health` | — | `{ ok, service, providers: {...} }` |
| `GET /search` | `q` (required), `types` (`artists,albums,tracks`), `limit` (1–100) | `SearchResults` |
| `GET /resolve-stream` | `q` **or** `title`(+`artist`), optional `duration`; **or** `url` | `StreamCandidate` (playable stream) |
| `GET /stream` | `url` (googlevideo only) | Proxied audio bytes (Range-aware) |
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

## Deployment (Docker)

The included `Dockerfile` builds the app and bundles the standalone `yt-dlp`
Linux binary (no system Python needed). The server binds `0.0.0.0:$PORT` and
reads secrets from the environment, so it runs on any container host.

**PO-token provider (built in):** the runtime image is based on
`brainicism/bgutil-ytdlp-pot-provider` and starts that provider on
`127.0.0.1:4416` alongside the server (see `docker-entrypoint.sh`); the matching
yt-dlp plugin is dropped in `/etc/yt-dlp/plugins`. This lets yt-dlp mint WebPO
tokens so YouTube doesn't bot-block resolution from a datacenter IP — the reason
`/resolve-stream` fails on cloud hosts but works from a home connection. The
backend passes the provider address to yt-dlp via `POT_PROVIDER_BASE_URL` (set in
the image; unset locally, so local dev is unaffected).

**Render** (via `render.yaml` blueprint): push this repo to GitHub → Render →
*New + → Blueprint* → select the repo → set the secret env vars when prompted →
deploy. You get an HTTPS URL; point the app's `EXPO_PUBLIC_BACKEND_URL` at it.

Any Docker host works the same way (`docker build -t nuclear-backend . && docker
run -p 4000:4000 --env-file .env nuclear-backend`).

---

## Notes

- **Caching** (`src/cache.ts`, in-memory TTL): search 60s, artist/album/dashboard
  10m, playlists 30m, recommendations 5m, lyrics 1h, **resolve-stream 2h** (avoids
  re-running yt-dlp; under the ~6h googlevideo URL lifetime).
- **`/stream` is host-restricted** to `*.googlevideo.com` so it can't be used as
  an open proxy / SSRF vector.
- **Timeouts + circuit breaker** (`src/http.ts`): every provider call is bounded;
  iTunes is skipped for 30s after a failure and search falls back to MusicBrainz,
  so one slow source never fails the whole request.
- **datacenter-IP bot-check:** YouTube shows a bot-check to cloud IPs that doesn't
  happen from a home connection, which breaks `/resolve-stream` on cloud hosts.
  Mitigated by the built-in **PO-token provider** (see Deployment). If it ever
  regresses, the fallbacks are YouTube cookies (`--cookies`) or a residential
  proxy. Verify a deploy with `yt-dlp -v <url>` showing a `[pot]` provider line,
  or just hit `/resolve-stream` and confirm a stream URL comes back.
