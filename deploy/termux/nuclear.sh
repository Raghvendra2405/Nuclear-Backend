#!/data/data/com.termux/files/usr/bin/bash
# Starts the Nuclear backend and ngrok tunnel and keeps them running.
# Works when run manually AND as a Termux:Boot script (survives reboots).
#   Manual:  bash ~/Nuclear-Backend/deploy/termux/nuclear.sh
PREFIX_BIN="/data/data/com.termux/files/usr/bin"
export PATH="$PREFIX_BIN:$PATH"

# Keep the CPU awake so Android doesn't suspend the backend in the background.
termux-wake-lock 2>/dev/null || true

# Force IPv4 for yt-dlp. Many home/mobile Wi-Fi networks advertise IPv6 but
# black-hole it to YouTube, so yt-dlp hangs at "Downloading webpage" until it
# times out and /resolve-stream fails — while iTunes/MusicBrainz (IPv4) still
# work, making it look like "only YouTube is broken". A yt-dlp config file is
# auto-loaded by *every* yt-dlp call (including the backend's), so this fixes it
# without touching the backend code. Harmless where IPv6 works (googlevideo is
# dual-stack). Written idempotently on every start so a fresh install self-heals.
mkdir -p ~/.config/yt-dlp
grep -qxF -- '--force-ipv4' ~/.config/yt-dlp/config 2>/dev/null \
  || echo '--force-ipv4' >> ~/.config/yt-dlp/config

# Self-heal the Termux:Boot auto-start entry so a reboot always brings us back
# (SETUP step 6 is easy to skip). The boot script just re-invokes this file.
mkdir -p ~/.termux/boot
BOOT_SCRIPT=~/.termux/boot/start-nuclear.sh
if [ ! -f "$BOOT_SCRIPT" ]; then
  printf '#!%s/bash\nbash ~/Nuclear-Backend/deploy/termux/nuclear.sh\n' "$PREFIX_BIN" > "$BOOT_SCRIPT"
  chmod +x "$BOOT_SCRIPT"
fi

# yt-dlp needs a JS runtime for nsig; node is installed.
export YTDLP_JS_RUNTIME=node
export YTDLP_PATH="$(command -v yt-dlp)"
export PORT=4000

# YouTube now bot-blocks even this residential phone IP ("Sign in to confirm
# you're not a bot") — the old "residential IP -> no cookies needed" assumption
# no longer holds. The fix is a local bgutil PO-token (WebPO) provider: a small
# HTTP server on :4416 that mints proof-of-origin tokens, paired with the yt-dlp
# plugin (pip: bgutil-ytdlp-pot-provider) that fetches them. yt-dlp auto-uses a
# provider on the default 127.0.0.1:4416; we also export POT_PROVIDER_BASE_URL so
# the backend passes it explicitly (see src/providers/ytdlp.ts). Install/build is
# a one-time step documented in deploy/termux/SETUP.md.
export POT_PROVIDER_BASE_URL=http://127.0.0.1:4416

LOG=~/nuclear.log
: > "$LOG"

# Start the bgutil PO-token provider (auto-restart if it exits). Without it
# YouTube extraction fails with the bot-check above. The build/ dir is produced
# by the one-time SETUP; warn (don't fail) if it's missing so the rest still runs.
POT_SERVER=~/bgutil-ytdlp-pot-provider/server/build/main.js
if [ -f "$POT_SERVER" ]; then
  echo "[nuclear] starting bgutil PO-token provider on :4416" | tee -a "$LOG"
  ( while true; do node "$POT_SERVER" >>"$LOG" 2>&1; echo "[nuclear] pot-provider exited, restarting" >>"$LOG"; sleep 3; done ) &
else
  echo "[nuclear] WARNING: PO-token provider not built ($POT_SERVER missing) — YouTube will bot-block. See deploy/termux/SETUP.md" | tee -a "$LOG"
fi

echo "[nuclear] starting backend on :$PORT" | tee -a "$LOG"
cd ~/Nuclear-Backend
# auto-restart the backend if it ever exits
( while true; do node dist/server.js >>"$LOG" 2>&1; echo "[nuclear] backend exited, restarting" >>"$LOG"; sleep 2; done ) &

echo "[nuclear] starting ngrok tunnel" | tee -a "$LOG"
cd ~
# Free ngrok reuses your account's single static domain (pass it with --url so
# the public URL is the same one baked into the app -> no rebuild needed).
# The ngrok binary is a foreign (non-Termux) Go build that reads /etc/resolv.conf
# for DNS, which does not exist on Android -> it fails with "lookup ... on
# [::1]:53: connection refused". proot bind-mounts Termux's resolv.conf (real
# nameservers) onto /etc/resolv.conf so ngrok can resolve.
RESOLV=/data/data/com.termux/files/usr/etc/resolv.conf
# proot's seccomp filter deadlocks multithreaded Go programs (ngrok connects but
# never establishes a session); disabling it makes ngrok work under proot.
export PROOT_NO_SECCOMP=1
( while true; do proot -b "$RESOLV":/etc/resolv.conf ./ngrok http --url=marcell-phototopographical-nonhypnotically.ngrok-free.dev 4000 --log=stdout >>"$LOG" 2>&1; echo "[nuclear] ngrok exited, restarting" >>"$LOG"; sleep 3; done ) &

echo "[nuclear] up. Logs: tail -f ~/nuclear.log"
