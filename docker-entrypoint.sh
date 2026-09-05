#!/bin/sh
# Runs two processes in one container:
#   1. the bgutil PO-token provider (binds 127.0.0.1:4416), used by yt-dlp to
#      mint WebPO tokens so YouTube doesn't bot-block resolution from this IP;
#   2. the Nuclear backend (binds 0.0.0.0:$PORT).
# The provider lives at /app (from the base image) with its own node_modules;
# node resolves those relative to the script's dir, so we cd there to run it.
set -e

( cd /app && exec node build/main.js --host 127.0.0.1 ) &

# Hand PID 1 to the backend so Render's SIGTERM reaches it for graceful shutdown.
cd /srv
exec node dist/server.js
