#!/bin/sh
set -eu

(
  cd /app
  unset SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET LASTFM_API_KEY YTDLP_COOKIES_B64
  exec node build/main.js --host 127.0.0.1 --port 4416
) &
provider_pid=$!

"$@" &
backend_pid=$!

stop_backend() {
  kill -TERM "$backend_pid" 2>/dev/null || true
}
trap stop_backend TERM INT

status=0
wait "$backend_pid" || status=$?
# Synchronous wait can be interrupted by the trap while Node is still draining.
if kill -0 "$backend_pid" 2>/dev/null; then
  status=0
  wait "$backend_pid" || status=$?
fi

kill -TERM "$provider_pid" 2>/dev/null || true
wait "$provider_pid" 2>/dev/null || true
exit "$status"
