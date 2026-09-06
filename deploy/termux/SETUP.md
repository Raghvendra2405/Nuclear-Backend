# Run the Nuclear backend on a spare Android phone (Termux)

A spare phone on a charger is a perfect free, always-on, residential server:
YouTube doesn't bot-block it (so **no cookies**), it runs 24/7 on ~2 W, and
yt-dlp stays **auto-updatable** (so YouTube changes never need an app rebuild).

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

### 3. Install everything (one command bootstrap)
In Termux:
```bash
pkg install -y git && git clone https://github.com/Raghvendra2405/Nuclear-Backend.git && bash Nuclear-Backend/deploy/termux/install.sh
```
(Installs node, yt-dlp, ngrok; builds the backend. Takes a few minutes.)

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
- **Update the backend code later:** `cd ~/Nuclear-Backend && git pull && npm ci && npm run build`, then re-run `nuclear.sh`.
- If you ever use a **different** ngrok account (different domain), send me the new
  `https://…` URL and I'll rebuild the app once with it.
