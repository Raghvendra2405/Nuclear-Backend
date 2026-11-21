const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeVideoUrl(raw: string): string | undefined {
  const url = URL.parse(raw);
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    return undefined;
  }

  let id: string | null | undefined;
  if (url.hostname === 'youtu.be') {
    id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  } else if (YOUTUBE_HOSTS.has(url.hostname)) {
    id = url.pathname === '/watch'
      ? url.searchParams.get('v')
      : /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }
  return id && VIDEO_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : undefined;
}

export function googleVideoUrl(raw: string, base?: URL): URL | undefined {
  const url = URL.parse(raw, base?.href);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  if (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) return url;
  return undefined;
}
