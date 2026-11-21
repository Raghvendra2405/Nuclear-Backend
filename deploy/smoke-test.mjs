import assert from 'node:assert/strict';

const [baseUrl, videoUrl, title, artist] = process.argv.slice(2);
if (!baseUrl || !videoUrl) {
  console.error('Usage: node deploy/smoke-test.mjs <backend-base-url> <public-youtube-video-url> [track-title] [track-artist]');
  process.exit(1);
}

async function request(path, { query, headers, timeout = 10_000 } = {}) {
  const url = new URL(path, baseUrl);
  if (query) url.search = new URLSearchParams(query).toString();
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response;
}

async function checkPlayback(query, description, timeout) {
  const result = await (await request('/resolve-stream', { query, timeout })).json();
  assert.ok(result.stream?.url, `/resolve-stream returned no media URL for ${description}`);
  console.log(`/resolve-stream returned a media URL for ${description}`);

  const media = await request('/stream', {
    query: { url: result.stream.url },
    headers: { Range: 'bytes=0-1023' },
  });
  const reader = media.body?.getReader();
  try {
    assert.equal(media.status, 206, '/stream did not return partial content');
    assert.match(media.headers.get('content-range') ?? '', /^bytes 0-\d+\/\d+$/);
    assert.ok((await reader?.read())?.value?.byteLength, '/stream returned no media bytes');
  } finally {
    await reader?.cancel();
  }
  console.log(`/stream returned a byte range for ${description}`);
}

try {
  for (const endpoint of ['/health', '/ready']) {
    const result = await (await request(endpoint)).json();
    assert.equal(result.ok, true, `${endpoint} reported a failed check`);
    console.log(`${endpoint} passed`);
  }

  const search = await (await request('/search', {
    query: { q: 'Radiohead', types: 'tracks', limit: '5' },
    timeout: 30_000,
  })).json();
  assert.ok(search.tracks?.length, '/search returned no tracks');
  console.log('/search returned tracks');

  await checkPlayback({ url: videoUrl }, 'the video link', 130_000);
  if (title) await checkPlayback({ title, artist: artist ?? '' }, 'the track search', 160_000);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
