# Nuclear Backend

Backend service for **Nuclear Mobile** (the React Native app). It does content
resolution — search, metadata, and (later) stream-URL resolution — so the mobile
app can stay a thin, App-Store-safe client that just renders results and plays a
returned stream URL. See `mobile.md` in the nuclear monorepo for the full
architecture.

- **Runtime:** Node + TypeScript (Fastify)
- **Data shapes:** mirror `@nuclearplayer/model` (see `src/nuclear-model.ts`)
- **First provider:** Deezer public API (keyless) for search

## Getting started

```bash
pnpm install      # or npm install
pnpm dev          # tsx watch — http://localhost:4000
```

Build / run compiled:

```bash
pnpm build
pnpm start
```

## Endpoints

### `GET /health`
Liveness check → `{ "ok": true, "service": "nuclear-backend" }`.

### `GET /search`
Search Deezer, returns `@nuclearplayer/model`-shaped `SearchResults`.

| Query param | Default | Notes |
|---|---|---|
| `q` (required) | — | Search query |
| `types` | `artists,albums,tracks` | Comma-separated subset of `artists`, `albums`, `tracks` |
| `limit` | `20` | Clamped to 1–50 |

Example:

```bash
curl "http://localhost:4000/search?q=radiohead&types=artists,tracks&limit=5"
```

### Other endpoints

| Endpoint | Params | Returns |
|---|---|---|
| `GET /resolve-stream` | `q` or `title`(+`artist`) or `url` | `StreamCandidate` (playable URL via yt-dlp/YouTube) |
| `GET /artist` | `id` (iTunes artist id) | `{ name, artwork, genres, topTracks, albums }` |
| `GET /album` | `id` (iTunes collection id) | `Album` with full `tracks` |
| `GET /dashboard` | `country` (default `us`) | `{ sections: [{ id, title, tracks }] }` — region-aware charts |
| `GET /discovery` | `artist`, `limit` | `{ tracks }` — "more like this" |
| `GET /lyrics` | `title`, `artist`, `duration?` | `{ plain?, synced?: [{timeMs,text}], source }` (lrclib) |

Sources: **iTunes** (search/metadata/charts), **YouTube via yt-dlp** (streams), **lrclib.net** (lyrics).

## Roadmap (next)

- Stream caching (googlevideo URLs expire); response caching for metadata
- Region-aware provider routing / selection
- Decide hosting model (shared vs. self-hostable) — see `mobile.md`
