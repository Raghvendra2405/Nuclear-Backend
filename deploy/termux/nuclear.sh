#!/data/data/com.termux/files/usr/bin/bash
# Starts the Nuclear backend + ngrok tunnel and keeps them running.
# Works when run manually AND as a Termux:Boot script (survives reboots).
#   Manual:  bash ~/Nuclear-Backend/deploy/termux/nuclear.sh
PREFIX_BIN="/data/data/com.termux/files/usr/bin"
export PATH="$PREFIX_BIN:$PATH"

# Keep the CPU awake so Android doesn't suspend the backend in the background.
termux-wake-lock 2>/dev/null || true

# yt-dlp needs a JS runtime for nsig; node is installed.
export YTDLP_JS_RUNTIME=node
export YTDLP_PATH="$(command -v yt-dlp)"
export PORT=4000
# Residential phone IP -> no YouTube bot-block -> no cookies needed.

LOG=~/nuclear.log
: > "$LOG"

echo "[nuclear] starting backend on :$PORT" | tee -a "$LOG"
cd ~/Nuclear-Backend
# auto-restart the backend if it ever exits
( while true; do node dist/server.js >>"$LOG" 2>&1; echo "[nuclear] backend exited, restarting" >>"$LOG"; sleep 2; done ) &

echo "[nuclear] starting ngrok tunnel" | tee -a "$LOG"
cd ~
# Free ngrok reuses your account's single static domain, so the public URL is
# the same one baked into the app -> no rebuild needed.
( while true; do ./ngrok http 4000 --log=stdout >>"$LOG" 2>&1; echo "[nuclear] ngrok exited, restarting" >>"$LOG"; sleep 3; done ) &

echo "[nuclear] up. Logs: tail -f ~/nuclear.log"
