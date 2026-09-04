// yt-dlp provider — powers the /resolve-stream endpoint.
//
// Given a query (e.g. "Radiohead Let Down") or a direct URL, it uses yt-dlp to
// find the best match on YouTube and extract a direct, playable audio stream URL.
// The mobile app plays that URL directly (native fetch has no CORS, so the
// desktop's stream-proxy machinery isn't needed).
//
// Returns a StreamCandidate (with a nested Stream) matching @nuclearplayer/model.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderRef, Stream, StreamCandidate } from '../nuclear-model.js';

const PROVIDER = 'youtube';

export class StreamNotFoundError extends Error {
  constructor(message = 'No playable stream found') {
    super(message);
    this.name = 'StreamNotFoundError';
  }
}

// Resolve the yt-dlp binary: explicit env override, then the Nuclear desktop
// app's auto-downloaded copy on Windows, then rely on PATH.
const resolveYtDlpPath = (): string => {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  if (process.platform === 'win32') {
    const nuclearPath = path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'com.nuclearplayer',
      'ytdlp',
      'yt-dlp.exe',
    );
    if (existsSync(nuclearPath)) return nuclearPath;
  }
  return 'yt-dlp';
};

const runYtDlp = (args: string[], timeoutMs = 30000): Promise<string> =>
  new Promise((resolve, reject) => {
    const proc = spawn(resolveYtDlpPath(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('yt-dlp timed out'));
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });

// yt-dlp info-dict format entry (subset we use).
type YtFormat = {
  url?: string;
  acodec?: string;
  vcodec?: string;
  abr?: number;
  ext?: string;
  protocol?: string;
  filesize?: number;
  filesize_approx?: number;
};

type YtEntry = {
  id?: string;
  title?: string;
  duration?: number; // seconds
  thumbnail?: string;
  webpage_url?: string;
  formats?: YtFormat[];
};

const mimeForExt = (ext?: string): string | undefined => {
  switch (ext) {
    case 'webm':
      return 'audio/webm';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'mp3':
      return 'audio/mpeg';
    default:
      return undefined;
  }
};

const pickBestAudio = (formats: YtFormat[]): YtFormat | undefined => {
  const audioOnly = formats.filter(
    (f) => f.url && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'),
  );
  const pool = audioOnly.length
    ? audioOnly
    : formats.filter((f) => f.url && f.acodec && f.acodec !== 'none');
  if (!pool.length) return undefined;
  return pool.reduce((best, f) => ((f.abr ?? 0) > (best.abr ?? 0) ? f : best));
};

// Flat search result (fast; no format extraction).
type FlatEntry = {
  id?: string;
  title?: string;
  duration?: number;
  channel?: string;
  uploader?: string;
};

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const JUNK = [
  'live',
  'cover',
  'remix',
  'reaction',
  'sped up',
  'slowed',
  'karaoke',
  'instrumental',
  '8d',
  'nightcore',
  'mashup',
];

// Rank YouTube candidates so we pick the real, clean audio for the right song:
// YouTube Music "- Topic" uploads and official channels first, matching the
// expected duration and title, avoiding live/cover/remix junk.
const scoreCandidate = (
  e: FlatEntry,
  query: string,
  durationSec?: number,
): number => {
  let score = 0;
  const channel = (e.channel ?? e.uploader ?? '').toLowerCase();
  if (channel.endsWith('- topic')) score += 50; // auto-generated clean audio
  if (channel.includes('vevo') || channel.includes('official')) score += 20;

  const title = norm(e.title ?? '');
  const q = norm(query);
  const words = q.split(' ').filter(Boolean);
  const overlap = words.filter((w) => title.includes(w)).length / Math.max(1, words.length);
  score += overlap * 30;

  for (const bad of JUNK) {
    if (title.includes(bad) && !q.includes(bad)) score -= 25;
  }

  if (durationSec && e.duration) {
    const diff = Math.abs(e.duration - durationSec);
    if (diff <= 3) score += 40;
    else if (diff <= 8) score += 20;
    else score -= Math.min(30, diff);
  }
  return score;
};

export const resolveStream = async (input: {
  query?: string;
  url?: string;
  durationSec?: number;
}): Promise<StreamCandidate> => {
  let videoUrl = input.url;

  if (!videoUrl) {
    // Step 1: fast flat search for the top few candidates, then rank them.
    const flatOut = await runYtDlp([
      '--flat-playlist',
      '-J',
      '--no-warnings',
      `ytsearch6:${input.query}`,
    ]);
    const flat = JSON.parse(flatOut) as { entries?: FlatEntry[] };
    const candidates = (flat.entries ?? []).filter((e) => e.id);
    if (candidates.length === 0) throw new StreamNotFoundError();

    const best = candidates.reduce((a, b) =>
      scoreCandidate(b, input.query ?? '', input.durationSec) >
      scoreCandidate(a, input.query ?? '', input.durationSec)
        ? b
        : a,
    );
    videoUrl = `https://www.youtube.com/watch?v=${best.id}`;
  }

  // Step 2: full extraction of the chosen video for its audio formats.
  const out = await runYtDlp(['-J', '--no-warnings', '--no-playlist', videoUrl]);

  const json = JSON.parse(out) as YtEntry & { entries?: YtEntry[] };
  const entry: YtEntry | undefined = json.entries ? json.entries[0] : json;
  if (!entry || !entry.formats?.length) {
    throw new StreamNotFoundError();
  }

  const best = pickBestAudio(entry.formats);
  if (!best?.url) {
    throw new StreamNotFoundError('No audio format available');
  }

  const durationMs =
    typeof entry.duration === 'number' ? Math.round(entry.duration * 1000) : undefined;

  const source: ProviderRef = {
    provider: PROVIDER,
    id: entry.id ?? '',
    url: entry.webpage_url,
  };

  const stream: Stream = {
    url: best.url,
    protocol: best.protocol?.includes('m3u8') ? 'hls' : 'https',
    mimeType: mimeForExt(best.ext),
    bitrateKbps: best.abr ? Math.round(best.abr) : undefined,
    codec: best.acodec,
    container: best.ext,
    durationMs,
    contentLengthBytes: best.filesize ?? best.filesize_approx,
    source,
  };

  return {
    id: entry.id ?? '',
    title: entry.title ?? input.query ?? 'Unknown',
    durationMs,
    thumbnail: entry.thumbnail,
    stream,
    lastResolvedAtIso: new Date().toISOString(),
    failed: false,
    source,
  };
};
