// fetch with a hard timeout so a slow/unreachable upstream fails fast instead of
// hanging on the ~10s default connect timeout (keeps search/metadata snappy).
export function fetchT(
  url: string,
  opts: RequestInit = {},
  ms = 5000,
): Promise<Response> {
  const timeout = AbortSignal.timeout(ms);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  return fetch(url, { ...opts, signal });
}
