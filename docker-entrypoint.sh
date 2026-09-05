#!/bin/sh
# Runs two processes in one container:
#   1. the bgutil PO-token provider (binds 0.0.0.0:4416), used by yt-dlp to mint
#      WebPO tokens so YouTube doesn't bot-block resolution from this IP;
#   2. the Nuclear backend (binds 0.0.0.0:$PORT).
# The provider lives at /app (from the base image) with its own node_modules;
# node resolves those relative to the script's dir, so we cd there to run it.
# Its output is captured to a file that /debug/ytdlp can tail for diagnosis.
set -e

echo "[entrypoint] starting bgutil PO-token provider on :4416..."
# The provider CLI takes --port (it binds all interfaces by default); it rejects
# --host. Default port is already 4416; pass it explicitly for clarity.
( cd /app && node build/main.js --port 4416 ) > /tmp/pot-provider.log 2>&1 &
echo "[entrypoint] provider PID $!"

# Wait (best-effort) for the provider to accept connections, and log the result
# so the Render logs immediately show whether it came up.
i=0
while [ "$i" -lt 15 ]; do
  if node -e "fetch('http://127.0.0.1:4416/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "[entrypoint] PO-token provider is UP on :4416"
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ "$i" -ge 15 ] && echo "[entrypoint] WARNING: PO-token provider did not come up in 15s; see /tmp/pot-provider.log"

# Hand PID 1 to the backend so Render's SIGTERM reaches it for graceful shutdown.
cd /srv
exec node dist/server.js
