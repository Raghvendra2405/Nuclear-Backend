// Tiny in-memory TTL cache to make repeat requests instant (search, dashboard,
// artist/album, playlists, and — importantly — resolved streams so we don't
// re-run yt-dlp on every play).
type Entry = { value: unknown; expiresAt: number };
const MAX_ENTRIES = 500;
const store = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  produce: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    store.delete(key);
    store.set(key, hit);
    return hit.value as T;
  }
  store.delete(key);

  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;

  const work = Promise.resolve().then(produce);
  pending.set(key, work);
  try {
    const value = await work;
    if (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next();
      if (!oldest.done) store.delete(oldest.value);
    }
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  } finally {
    pending.delete(key);
  }
}
