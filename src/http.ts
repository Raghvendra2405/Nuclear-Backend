// fetch with a hard timeout so a slow/unreachable upstream fails fast instead of
// hanging on the ~10s default connect timeout (keeps search/metadata snappy).
export async function fetchT(
  url: string,
  opts: RequestInit = {},
  ms = 5000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
