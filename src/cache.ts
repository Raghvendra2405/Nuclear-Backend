// Tiny in-memory TTL cache to make repeat requests instant (search, dashboard,
// artist/album, playlists, and — importantly — resolved streams so we don't
// re-run yt-dlp on every play).
type Entry = { value: unknown; expiresAt: number };
const store = new Map<string, Entry>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  produce: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }
  const value = await produce();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (store.size > 500) {
    const now = Date.now();
    for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
  }
  return value;
}
