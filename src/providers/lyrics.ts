// Lyrics provider — lrclib.net (keyless, provides both plain and synced lyrics).

import type { Lyrics, LyricLine } from '../nuclear-model.js';

const API = 'https://lrclib.net/api';
const UA = 'NuclearMobile/0.1 (https://github.com/nukeop/nuclear)';

type LrclibResult = {
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  instrumental?: boolean;
};

// Parse LRC ("[mm:ss.xx] text") into timestamped lines.
const parseLrc = (lrc: string): LyricLine[] => {
  const stampRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const matches = [...raw.matchAll(stampRe)];
    if (matches.length === 0) continue;
    const text = raw.replace(stampRe, '').trim();
    for (const m of matches) {
      const min = parseInt(m[1]!, 10);
      const sec = parseInt(m[2]!, 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      out.push({ timeMs: min * 60000 + sec * 1000 + frac, text });
    }
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
};

const hasLyrics = (r: LrclibResult | null): r is LrclibResult =>
  !!r && (!!r.syncedLyrics || !!r.plainLyrics);

export const getLyrics = async (
  title: string,
  artist: string,
  durationSec?: number,
): Promise<Lyrics | null> => {
  const headers = { 'User-Agent': UA };

  // 1) Exact match (best chance of synced lyrics).
  let result: LrclibResult | null = null;
  try {
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    if (durationSec) params.set('duration', String(Math.round(durationSec)));
    const res = await fetch(`${API}/get?${params.toString()}`, { headers });
    if (res.ok) result = (await res.json()) as LrclibResult;
  } catch {
    // fall through to search
  }

  // 2) Fallback: fuzzy search.
  if (!hasLyrics(result)) {
    try {
      const params = new URLSearchParams({ track_name: title, artist_name: artist });
      const res = await fetch(`${API}/search?${params.toString()}`, { headers });
      if (res.ok) {
        const arr = (await res.json()) as LrclibResult[];
        result = arr.find(hasLyrics) ?? null;
      }
    } catch {
      // ignore
    }
  }

  if (!hasLyrics(result)) return null;
  return {
    plain: result.plainLyrics ?? undefined,
    synced: result.syncedLyrics ? parseLrc(result.syncedLyrics) : undefined,
    source: 'lrclib',
  };
};
