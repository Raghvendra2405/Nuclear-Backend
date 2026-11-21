import { Readable } from 'node:stream';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { envInteger } from './env.js';
import { googleVideoUrl } from './playback-urls.js';

const maxStreams = envInteger('STREAM_CONCURRENCY', 32, 1, 256);
let activeStreams = 0;

async function fetchAudio(url: URL, method: string, range: string | undefined, signal: AbortSignal) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    const headers = new Headers({ 'Accept-Encoding': 'identity' });
    if (range) headers.set('Range', range);
    const upstream = await fetch(url, { method, headers, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(upstream.status)) return upstream;

    await upstream.body?.cancel();
    const location = upstream.headers.get('location');
    const next = location && googleVideoUrl(location, url);
    if (!next) throw new Error('Media redirect destination was rejected');
    url = next;
  }
  throw new Error('Media redirect limit reached');
}

export async function proxyAudio(request: FastifyRequest, reply: FastifyReply) {
  const { url } = request.query as { url?: string };
  if (!url) return reply.code(400).send({ error: 'Missing required query param "url"' });
  const allowedUrl = googleVideoUrl(url);
  if (!allowedUrl) return reply.code(400).send({ error: 'URL host not allowed' });

  const range = request.headers.range;
  if (range && !/^bytes=(?:\d{1,20}-\d{0,20}|-\d{1,20})$/i.test(range)) {
    return reply.code(400).send({ error: 'Provide a single byte range' });
  }
  if (activeStreams >= maxStreams) {
    return reply.header('Retry-After', '2').code(503).send({ error: 'Stream proxy is busy' });
  }

  activeStreams++;
  const controller = new AbortController();
  const headersTimeout = setTimeout(() => controller.abort(), 10_000).unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reply.raw.removeListener('close', release);
    controller.abort();
    activeStreams--;
  };
  reply.raw.once('close', release);
  let streaming = false;

  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);
    const upstream = await fetchAudio(allowedUrl, request.method, range, signal);
    clearTimeout(headersTimeout);
    if (!upstream.ok) {
      const contentRange = upstream.headers.get('content-range');
      if (upstream.status === 416 && contentRange) reply.header('Content-Range', contentRange);
      await upstream.body?.cancel();
      return reply.code(upstream.status).send({ error: 'Upstream stream error' });
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    if (!/^(audio\/|video\/|application\/(octet-stream|vnd\.apple\.mpegurl|x-mpegurl)\b)/i.test(contentType)) {
      await upstream.body?.cancel();
      return reply.code(502).send({ error: 'Upstream returned an unexpected media type' });
    }

    reply.code(upstream.status).type(contentType);
    const encoding = upstream.headers.get('content-encoding');
    for (const header of ['content-length', 'content-range']) {
      const value = upstream.headers.get(header);
      if (value && (!encoding || encoding === 'identity')) reply.header(header, value);
    }
    reply.header('Accept-Ranges', upstream.headers.get('accept-ranges') ?? 'bytes');

    if (!upstream.body) return reply.send();
    const audio = Readable.fromWeb(upstream.body);
    reply.send(audio);
    streaming = true;
    return reply;
  } catch (err) {
    if (reply.raw.destroyed) return reply;
    request.log.error({ reason: (err as Error).name }, 'stream proxy failed');
    return reply.code(502).send({ error: 'Stream proxy failed' });
  } finally {
    clearTimeout(headersTimeout);
    if (!streaming) release();
  }
}
