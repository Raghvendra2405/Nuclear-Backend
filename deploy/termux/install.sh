#!/data/data/com.termux/files/usr/bin/bash
# One-time install of the Nuclear backend on a spare Android phone via Termux.
# Run once:  bash install.sh
set -e

echo "==> Updating Termux packages"
pkg update -y && pkg upgrade -y

echo "==> Installing node, git, python, ffmpeg"
pkg install -y nodejs git python ffmpeg

echo "==> Installing/updating yt-dlp (latest, so YouTube changes don't break it)"
pip install -U yt-dlp
yt-dlp --version

echo "==> Fetching + building the backend"
cd ~
if [ -d Nuclear-Backend/.git ]; then
  git -C Nuclear-Backend pull --ff-only
else
  git clone https://github.com/Raghvendra2405/Nuclear-Backend.git
fi
cd ~/Nuclear-Backend
npm ci
npm run build

echo "==> Installing ngrok (arm64)"
cd ~
if [ ! -x ./ngrok ]; then
  curl -Lo ngrok.tgz https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz
  tar xzf ngrok.tgz && rm ngrok.tgz
fi
./ngrok --version || true

echo ""
echo "=================================================================="
echo " Installed. Next:"
echo "   1) ./ngrok config add-authtoken <YOUR_NGROK_TOKEN>"
echo "      (use the SAME ngrok account as before -> same static domain,"
echo "       so the app needs no rebuild)"
echo "   2) bash ~/Nuclear-Backend/deploy/termux/nuclear.sh"
echo "=================================================================="
