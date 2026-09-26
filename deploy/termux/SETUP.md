# Run the Nuclear backend on a spare Android phone (Termux)

A spare phone on a charger is a perfect free, always-on, residential server:
it runs 24/7 on ~2 W and yt-dlp stays **auto-updatable** (so YouTube changes
never need an app rebuild). YouTube used to trust the residential IP without any
auth, but it now bot-blocks it too ("Sign in to confirm you're not a bot"), so
we run a small local **bgutil PO-token provider** (step 3b) instead of cookies.

If you use your **existing ngrok account/token**, the public URL stays the same
one already baked into the app → **you don't rebuild the app at all.** You just
move the backend from your PC to the spare phone.

> ⚠️ Only one ngrok agent per free account at a time — **stop ngrok on your PC**
> before starting it on the phone (otherwise the domain conflicts).

---

## On the SPARE phone

### 1. Install Termux + Termux:Boot from **F-Droid** (not the Play Store)
The Play Store versions are outdated/broken. Get both from https://f-droid.org:
- **Termux**
- **Termux:Boot** (for auto-start on reboot)

Open **Termux:Boot** once (so it registers), then Termux.

### 2. Make Android leave it running
- Settings → Apps → **Termux** → Battery → **Unrestricted** (disable optimization).
- Do the same for **Termux:Boot**.
- Keep the phone **plugged in** and on **Wi-Fi**.

#### ⚠️ Disable the phantom-process killer (Android 12+ — required)
On Android 12+ the OS silently kills an app's *child* processes (yt-dlp, and
even `node`/`ngrok`) after a while — Termux stays open but your backend dies.
Battery "Unrestricted" does **not** stop this. It must be disabled over **adb
from a PC** (one-time, survives reboots); it can't be done from Termux alone:
```bash
adb shell "settings put global settings_enable_monitor_phantom_procs false"
adb shell "device_config set_sync_disabled_for_tests persistent"
adb shell "device_config put activity_manager max_phantom_processes 2147483647"
```
Symptom if skipped: after ~a day (or a reboot) the ngrok URL 404s even though
Termux is still on screen.

### 3. Install everything (one command bootstrap)
In Termux:
```bash
pkg install -y git && git clone https://github.com/Raghvendra2405/Nuclear-Backend.git && bash Nuclear-Backend/deploy/termux/install.sh
```
(Installs node, yt-dlp, ngrok; builds the backend. Takes a few minutes.)

### 3b. Install the bgutil PO-token provider (bypasses YouTube's bot-check)
YouTube now returns "Sign in to confirm you're not a bot" for the phone too.
A local WebPO-token provider fixes this without any account/cookies. One-time:
```bash
# 1. yt-dlp plugin (auto-loaded by every yt-dlp call)
pip install -U bgutil-ytdlp-pot-provider
# 2. token-generation HTTP server (Node). --ignore-scripts skips the heavy,
#    unused `canvas` native build (needs cairo/pango); the server runs fine
#    without it. Binds to 127.0.0.1:4416 only.
cd ~ && git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
cd ~/bgutil-ytdlp-pot-provider/server && npm install --ignore-scripts && npx tsc
```
`nuclear.sh` starts/supervises the server automatically (and exports
`POT_PROVIDER_BASE_URL=http://127.0.0.1:4416`). Verify: `curl 127.0.0.1:4416/ping`
should return `{"server_uptime":...,"version":"2.0.0"}`.

### 4. Add your ngrok token (same account as before → same URL)
```bash
cd ~ && ./ngrok config add-authtoken <YOUR_NGROK_TOKEN>
```
Get the token at https://dashboard.ngrok.com/get-started/your-authtoken.

### 5. Start it
```bash
bash ~/Nuclear-Backend/deploy/termux/nuclear.sh
```
It acquires a wake-lock and starts the backend + ngrok (auto-restarting both).
Check the URL/logs: `tail -f ~/nuclear.log` (look for the ngrok `url=...` line).

### 6. Auto-start on reboot (Termux:Boot)
```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-nuclear.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
bash ~/Nuclear-Backend/deploy/termux/nuclear.sh
EOF
chmod +x ~/.termux/boot/start-nuclear.sh
```
Now it comes back automatically after a reboot.

---

## Verify (from your PC or the app phone)
```
https://<your-ngrok-static-domain>/health          -> {"ok":true,...}
https://<your-ngrok-static-domain>/resolve-stream?title=Believer&artist=Imagine%20Dragons&duration=204
```
Since it's your existing ngrok domain, the app already points here → **just open the app and play.**

## Maintenance
- **When playback breaks** (YouTube changed): on the phone,
  `pip install -U yt-dlp` then re-run `nuclear.sh` (or reboot). **No app rebuild.**
- **If `/resolve-stream` fails with "Sign in to confirm you're not a bot"**: the
  PO-token provider isn't running/reachable. Check `curl 127.0.0.1:4416/ping`;
  if it fails, rebuild it (`cd ~/bgutil-ytdlp-pot-provider/server && git pull &&
  npm install --ignore-scripts && npx tsc`) and re-run `nuclear.sh`. Also bump the
  plugin: `pip install -U bgutil-ytdlp-pot-provider`. Keep plugin + server versions
  in sync. (A burst of "HTTP 429 Too Many Requests" is a temporary rate-limit —
  wait it out; the PO token prevents it recurring.)
- **If `/health` works but `/resolve-stream` always times out** (search/metadata
  fine, only YouTube hangs): the Wi-Fi is black-holing IPv6 to YouTube. `nuclear.sh`
  now writes `~/.config/yt-dlp/config` with `--force-ipv4` to fix this; verify with
  `cat ~/.config/yt-dlp/config`. Test directly: `yt-dlp -4 -g https://youtu.be/dQw4w9WgXcQ`
  should print a `googlevideo.com` URL in a few seconds.
- **Update the backend code later:** `cd ~/Nuclear-Backend && git pull && npm ci && npm run build`, then re-run `nuclear.sh`.
- If you ever use a **different** ngrok account (different domain), send me the new
  `https://…` URL and I'll rebuild the app once with it.
