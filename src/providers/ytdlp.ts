// yt-dlp provider — powers the /resolve-stream endpoint.
//
// Given a query (e.g. "Radiohead Let Down") or a direct URL, it uses yt-dlp to
// find the best match on YouTube and extract a direct, playable audio stream URL.
// The mobile app plays that URL directly (native fetch has no CORS, so the
// desktop's stream-proxy machinery isn't needed).
//
// Returns a StreamCandidate (with a nested Stream) matching @nuclearplayer/model.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProviderRef, Stream, StreamCandidate } from '../nuclear-model.js';
import { youtubeVideoUrl } from '../playback-urls.js';

const PROVIDER = 'youtube';

// When a bgutil PO-token provider is reachable (set via POT_PROVIDER_BASE_URL in
// the Docker image), tell yt-dlp where to mint WebPO tokens. YouTube bot-blocks
// plain yt-dlp from datacenter IPs (Render) with "Sign in to confirm you're not
// a bot"; a WebPO token gets past that. Empty in local dev (residential IP needs
// no token), so the yt-dlp commands there are byte-for-byte unchanged.
const POT_ARGS = process.env.POT_PROVIDER_BASE_URL
  ? ['--extractor-args', `youtubepot-bgutilhttp:base_url=${process.env.POT_PROVIDER_BASE_URL}`]
  : [];

// Recent yt-dlp needs an external JavaScript runtime to execute YouTube's player
// JS (signature / nsig); the standalone binary bundles none and only enables
// deno by default. In the container node is present, so point yt-dlp at it via
// YTDLP_JS_RUNTIME=node. Unset in local dev, so nothing changes there.
const JS_RUNTIME_ARGS = process.env.YTDLP_JS_RUNTIME
  ? ['--js-runtimes', process.env.YTDLP_JS_RUNTIME]
  : [];

// YouTube blocks unauthenticated extraction from datacenter IPs ("Sign in to
// confirm you're not a bot"), which no client or PO token gets past — only a
// logged-in cookie jar does. Load cookies (from a burner account) from, in order:
//   1. YTDLP_COOKIES_B64  — base64 of a Netscape cookies.txt (env/secret),
//   2. YTDLP_COOKIES_FILE — explicit path to a cookies.txt,
//   3. /etc/secrets/cookies.txt — Render "Secret File" default mount.
function loadCookies(): string | undefined {
  if (process.env.YTDLP_COOKIES_B64) {
    return Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf8');
  }
  const configured = process.env.YTDLP_COOKIES_FILE;
  const file = configured || '/etc/secrets/cookies.txt';
  return configured || existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

let cookieContent: string | undefined;
function configureCookies(): void {
  const content = loadCookies();
  if (content !== undefined && !/^# (?:Netscape )?HTTP Cookie File\r?\n/.test(content)) {
    throw new Error('Expected a Netscape cookies.txt file');
  }
  cookieContent = content;
}

// Args shared by every YouTube-hitting yt-dlp call.
const COMMON_ARGS = [
  ...(process.env.NODE_ENV === 'production' ? ['--ignore-config'] : []),
  ...(process.env.YTDLP_FORCE_IPV4 === '1' ? ['--force-ipv4'] : []),
  ...JS_RUNTIME_ARGS,
  ...POT_ARGS,
];
const shutdown = new AbortController();

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

const runYtDlp = (args: string[], timeout: number): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(resolveYtDlpPath(), args, {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout,
      killSignal: 'SIGKILL',
      signal: shutdown.signal,
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(new Error('yt-dlp executable is missing'));
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return reject(new Error('yt-dlp exceeded its output limit'));
      }
      if (err.code === 'ABORT_ERR') return reject(new Error('yt-dlp stopped during shutdown'));
      if (err.killed) return reject(new Error('yt-dlp timed out'));
      if (/confirm you.re not a bot|sign in to confirm your age/i.test(stderr)) {
        return reject(new Error('YouTube requested sign-in'));
      }
      if (/video unavailable|private video/i.test(stderr)) return reject(new StreamNotFoundError());
      reject(new Error('yt-dlp extraction failed'));
    });
  });

export async function checkYtDlp(): Promise<void> {
  configureCookies();
  await runYtDlp(['--ignore-config', '--version'], 10_000);
}

export function stopYtDlp(): void {
  shutdown.abort();
}

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

type ResolveInput = {
  query?: string;
  url?: string;
  durationSec?: number;
};

export async function resolveStream(input: ResolveInput): Promise<StreamCandidate> {
  if (!cookieContent) return resolveVideo(input, COMMON_ARGS);

  // yt-dlp can rewrite cookies during extraction. Give each resolution a private
  // writable copy shared by its search and extraction steps.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nuclear-yt-'));
  try {
    const file = path.join(dir, 'cookies.txt');
    await writeFile(file, cookieContent, { mode: 0o600 });
    return await resolveVideo(input, [...COMMON_ARGS, '--cookies', file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function resolveVideo(input: ResolveInput, args: string[]): Promise<StreamCandidate> {
  let videoUrl = input.url && youtubeVideoUrl(input.url);
  if (input.url && !videoUrl) throw new StreamNotFoundError();

  if (!videoUrl) {
    // Step 1: fast flat search for the top few candidates, then rank them.
    const flatOut = await runYtDlp([
      '--flat-playlist',
      '-J',
      '--no-warnings',
      ...args,
      '--',
      `ytsearch6:${input.query}`,
    ], 30_000);
    const flat = JSON.parse(flatOut) as { entries?: FlatEntry[] };
    const candidates = (flat.entries ?? []).filter((e) => e.id);
    if (candidates.length === 0) throw new StreamNotFoundError();

    const best = candidates.reduce((a, b) =>
      scoreCandidate(b, input.query ?? '', input.durationSec) >
      scoreCandidate(a, input.query ?? '', input.durationSec)
        ? b
        : a,
    );
    videoUrl = youtubeVideoUrl(`https://www.youtube.com/watch?v=${best.id}`);
    if (!videoUrl) throw new StreamNotFoundError();
  }

  // Step 2: full extraction of the chosen video for its audio formats.
  const out = await runYtDlp([
    '-J',
    '--no-warnings',
    '--no-playlist',
    ...args,
    '--',
    videoUrl,
  ], 120_000);

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
}
