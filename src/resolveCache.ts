// Persistent (SQLite-backed) cache for resolved stream candidates. A song's
// resolved googlevideo URL is reusable for its whole signed lifetime
// (~6h) — without this, that reuse window was limited to the in-memory
// cache's 2h TTL and reset to nothing on every restart/redeploy, forcing a
// fresh yt-dlp extraction (and another round of outbound requests to
// YouTube) for every popular song after each deploy. Persisting it means a
// song only costs one extraction per signed-URL lifetime, across restarts.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DB_PATH =
  process.env.RESOLVE_CACHE_DB_PATH || path.join(process.cwd(), 'data', 'resolve-cache.db');

mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS resolve_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const getStmt = db.prepare('SELECT value, expires_at FROM resolve_cache WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO resolve_cache (key, value, expires_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
);
const deleteExpiredStmt = db.prepare('DELETE FROM resolve_cache WHERE expires_at <= ?');

// In-flight dedup so concurrent requests for the same not-yet-cached song
// share one yt-dlp extraction instead of each starting their own.
const pending = new Map<string, Promise<unknown>>();

export async function cachedPersistent<T>(
  key: string,
  ttlMs: number,
  produce: () => Promise<T>,
): Promise<T> {
  const row = getStmt.get(key) as { value: string; expires_at: number } | undefined;
  if (row && row.expires_at > Date.now()) {
    return JSON.parse(row.value) as T;
  }

  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;

  const work = Promise.resolve().then(produce);
  pending.set(key, work);
  try {
    const value = await work;
    setStmt.run(key, JSON.stringify(value), Date.now() + ttlMs);
    return value;
  } finally {
    pending.delete(key);
  }
}

// Periodic sweep so the file doesn't grow unbounded with stale rows.
setInterval(() => {
  try {
    deleteExpiredStmt.run(Date.now());
  } catch {
    // best-effort
  }
}, 15 * 60 * 1000).unref();
