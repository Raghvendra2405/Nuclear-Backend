#!/usr/bin/env bash
# One-shot setup for the Nuclear backend on an Oracle Cloud "Always Free"
# ARM (aarch64) Ubuntu 22.04 VM. Installs Node + yt-dlp, builds the backend,
# runs it as a systemd service, and puts it behind Caddy with automatic HTTPS
# via a free DuckDNS domain.
#
# Since metadata now runs on-device in the app, this backend only serves
# /resolve-stream and /stream (audio proxy) — it just needs yt-dlp + cookies.
#
# USAGE (run on the VM as the default `ubuntu` user):
#   sudo bash oracle-setup.sh <duckdns-subdomain> <duckdns-token>
#   e.g. sudo bash oracle-setup.sh nuclearmusic 8f3c...your-token
#
# Before running, put your YouTube cookies in /opt/nuclear-backend/cookies.txt
# (the script creates the dir and will remind you if it's missing).
set -euo pipefail

DUCK_SUB="${1:-}"
DUCK_TOKEN="${2:-}"
REPO="https://github.com/Raghvendra2405/Nuclear-Backend.git"
APP_DIR="/opt/nuclear-backend"
COOKIES="$APP_DIR/cookies.txt"
YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64"

if [[ -z "$DUCK_SUB" || -z "$DUCK_TOKEN" ]]; then
  echo "Usage: sudo bash oracle-setup.sh <duckdns-subdomain> <duckdns-token>"
  echo "  (subdomain is just the name, e.g. 'nuclearmusic' for nuclearmusic.duckdns.org)"
  exit 1
fi
DOMAIN="${DUCK_SUB}.duckdns.org"

echo "==> [1/9] System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg iptables-persistent

echo "==> [2/9] Node.js 22 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> [3/9] yt-dlp (aarch64 standalone)"
curl -fsSL "$YTDLP_URL" -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
/usr/local/bin/yt-dlp --version

echo "==> [4/9] Fetch + build backend"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  mkdir -p "$APP_DIR"
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci
npm run build

echo "==> [5/9] Cookies check"
if [[ ! -s "$COOKIES" ]]; then
  echo "!! WARNING: $COOKIES is missing/empty."
  echo "   Playback will fail until you create it (paste your youtube cookies.txt there),"
  echo "   then: sudo systemctl restart nuclear-backend"
fi

echo "==> [6/9] systemd service"
cat >/etc/systemd/system/nuclear-backend.service <<UNIT
[Unit]
Description=Nuclear backend (yt-dlp stream resolver)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/dist/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=4000
Environment=YTDLP_PATH=/usr/local/bin/yt-dlp
Environment=YTDLP_JS_RUNTIME=node
Environment=YTDLP_COOKIES_FILE=$COOKIES

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable nuclear-backend
systemctl restart nuclear-backend

echo "==> [7/9] Point DuckDNS ($DOMAIN) at this VM"
IP=$(curl -fsSL https://api.ipify.org || true)
curl -fsSL "https://www.duckdns.org/update?domains=${DUCK_SUB}&token=${DUCK_TOKEN}&ip=${IP}" || true
echo "  DuckDNS -> $DOMAIN = $IP"

echo "==> [8/9] Caddy (automatic HTTPS reverse proxy)"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
cat >/etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    reverse_proxy localhost:4000
}
CADDY
systemctl restart caddy

echo "==> [9/9] Firewall (Ubuntu iptables — Oracle images block everything but SSH)"
iptables -I INPUT -p tcp --dport 80 -j ACCEPT
iptables -I INPUT -p tcp --dport 443 -j ACCEPT
netfilter-persistent save || true

# Weekly yt-dlp self-update so YouTube player changes don't rot the resolver.
cat >/etc/cron.weekly/yt-dlp-update <<'CRON'
#!/bin/sh
/usr/local/bin/yt-dlp -U >/var/log/yt-dlp-update.log 2>&1 || true
systemctl restart nuclear-backend || true
CRON
chmod +x /etc/cron.weekly/yt-dlp-update

echo ""
echo "=================================================================="
echo " DONE. Backend URL:  https://$DOMAIN"
echo ""
echo " Check it:   curl https://$DOMAIN/health"
echo " Logs:       journalctl -u nuclear-backend -f"
echo ""
echo " STILL TO DO in the Oracle web console:"
echo "   VCN > Security List > add Ingress rules for TCP 80 and 443 (0.0.0.0/0)."
echo " And if you haven't yet: put cookies in $COOKIES then"
echo "   sudo systemctl restart nuclear-backend"
echo "=================================================================="
