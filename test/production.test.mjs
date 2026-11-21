import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { after, mock, test } from 'node:test';

process.env.LOG_LEVEL = 'silent';
process.env.POT_PROVIDER_BASE_URL = 'http://127.0.0.1:4416';
process.env.YTDLP_COOKIES_B64 = '';
process.env.YTDLP_COOKIES_FILE = '';
process.env.SPOTIFY_CLIENT_ID = '';
process.env.SPOTIFY_CLIENT_SECRET = '';
process.env.LASTFM_API_KEY = '';
process.env.RESOLVE_CONCURRENCY = '1';
process.env.STREAM_CONCURRENCY = '1';

const mediaUrl = 'https://audio.googlevideo.com/videoplayback';
const videoUrl = 'https://www.youtube.com/watch?v=abcdefghijk';

let extractionCount = 0;
let completeExtraction;
const extractionStarted = Promise.withResolvers();
mock.method(childProcess, 'execFile', (_file, args, _options, callback) => {
  if (args.includes('--version')) {
    queueMicrotask(() => callback(null, '2026.10.26', ''));
    return;
  }
  extractionCount++;
  completeExtraction = () => callback(null, JSON.stringify({
    id: 'abcdefghijk',
    title: 'Example track',
    formats: [{ url: mediaUrl, acodec: 'aac', vcodec: 'none', ext: 'm4a' }],
  }), '');
  extractionStarted.resolve();
});
syncBuiltinESMExports();

const { app } = await import('../dist/app.js');
const { cached } = await import('../dist/cache.js');

after(async () => {
  await app.close();
  mock.restoreAll();
  syncBuiltinESMExports();
});

test('liveness stays available when a configured provider is down', async (t) => {
  const ping = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  assert.equal((await app.inject('/health')).json().ok, true);
  const unavailable = await app.inject('/ready');
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { ok: false });
  ping.mock.mockImplementation(async () => new Response('pong'));
  assert.deepEqual((await app.inject('/ready')).json(), { ok: true });
});

test('playback validates query inputs and the diagnostics route is absent', async () => {
  assert.equal((await app.inject('/search?q=first&q=second')).statusCode, 400);
  assert.equal((await app.inject(`/resolve-stream?url=${encodeURIComponent('https://example.com/music')}`)).statusCode, 400);
  assert.equal((await app.inject('/resolve-stream?title=Example&duration=unknown')).statusCode, 400);
  assert.equal((await app.inject('/debug/ytdlp')).statusCode, 404);
  assert.equal(extractionCount, 0);
});

test('Deezer playlist routes still map editorial items and tracks', async (t) => {
  const playlist = { id: 42, title: 'Example playlist', nb_tracks: 1 };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/chart/0/playlists') return Response.json({ data: [playlist] });
    assert.equal(pathname, '/playlist/42');
    return Response.json({ ...playlist, tracks: { data: [{ id: 99, title: 'Example track' }] } });
  });

  const summaries = await app.inject('/playlists');
  assert.equal(summaries.statusCode, 200);
  assert.equal(summaries.json().playlists[0].id, '42');
  const detail = await app.inject('/playlist?id=42');
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().tracks[0].title, 'Example track');
});

test('equivalent video links share one extraction while distinct work is capped', { timeout: 5000 }, async () => {
  const first = app.inject({ url: '/resolve-stream', query: { url: videoUrl } }).then((response) => response);
  await extractionStarted.promise;
  const second = app.inject({ url: '/resolve-stream', query: { url: 'https://youtu.be/abcdefghijk' } }).then((response) => response);
  const saturated = await app.inject({ url: '/resolve-stream', query: { url: 'https://youtube.com/shorts/lmnopqrstuv' } });
  assert.equal(saturated.statusCode, 503);
  assert.equal(saturated.headers['retry-after'], '2');
  completeExtraction();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.statusCode, 200);
  assert.equal(a.headers['cache-control'], 'no-store');
  assert.equal(a.json().stream.url, mediaUrl);
  assert.deepEqual(b.json(), a.json());
  assert.equal(extractionCount, 1);
});

test('audio follows CDN redirects and preserves single-range responses', async (t) => {
  const fetchMedia = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.get('Range'), 'bytes=0-2');
    if (url.hostname === 'audio.googlevideo.com') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://alternate.googlevideo.com/videoplayback' },
      });
    }
    assert.equal(url.hostname, 'alternate.googlevideo.com');
    return new Response('abc', {
      status: 206,
      headers: { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-2/9', 'Content-Length': '3' },
    });
  });
  const request = { url: '/stream', query: { url: mediaUrl }, headers: { range: 'bytes=0-2' } };
  for (let i = 0; i < 2; i++) {
    const playback = await app.inject(request);
    assert.equal(playback.statusCode, 206);
    assert.equal(playback.headers['content-range'], 'bytes 0-2/9');
    assert.equal(playback.headers['content-length'], '3');
    assert.equal(playback.body, 'abc');
  }
  assert.equal(fetchMedia.mock.callCount(), 4);
});

test('audio HEAD returns metadata and leaves the proxy slot available', async (t) => {
  const fetchMedia = t.mock.method(globalThis, 'fetch', async (_url, { method }) => {
    assert.equal(method, 'HEAD');
    return new Response(null, { headers: { 'Content-Type': 'audio/mp4', 'Content-Length': '9' } });
  });
  for (let i = 0; i < 2; i++) {
    const playback = await app.inject({ method: 'HEAD', url: '/stream', query: { url: mediaUrl } });
    assert.equal(playback.statusCode, 200);
    assert.equal(playback.headers['content-length'], '9');
    assert.equal(playback.body, '');
  }
  assert.equal(fetchMedia.mock.callCount(), 2);
});

test('resolver rate limiting leaves liveness available', async () => {
  const client = { url: '/resolve-stream', remoteAddress: '192.0.2.20' };
  for (let i = 0; i < 30; i++) {
    assert.equal((await app.inject(client)).statusCode, 400);
  }
  assert.equal((await app.inject(client)).statusCode, 429);
  assert.equal((await app.inject({ ...client, url: '/health' })).statusCode, 200);
});

test('cache evicts old entries and retries failed work', async () => {
  const fill = (key) => cached(`test:${key}`, 10_000, async () => key);
  await fill(0);
  for (let key = 1; key <= 500; key++) await fill(key);
  assert.equal(await cached('test:0', 10_000, async () => 'replacement'), 'replacement');
  await assert.rejects(cached('test:failure', 10_000, async () => { throw new Error('temporary failure'); }));
  assert.equal(await cached('test:failure', 10_000, async () => 'recovered'), 'recovered');
});
