# Deploy the Nuclear backend on Hugging Face Spaces (free, no card)

Gives an always-on HTTPS backend for stream resolution at
`https://<username>-nuclear-backend.hf.space`. Metadata runs on-device, so this
Space only needs yt-dlp + your YouTube cookies.

## 1. Create the Space
1. Sign up at https://huggingface.co (no credit card).
2. Top-right **+ → New Space**.
3. **Owner:** you. **Space name:** `nuclear-backend`.
4. **SDK:** choose **Docker** → **Blank**.
5. **Visibility:** **Public** (the app must reach the URL without logging in).
6. **Create Space.**

## 2. Add the two files
In the new Space → **Files** tab → **+ Add file → Create a new file**, twice:

- Filename **`Dockerfile`** → paste the contents of `deploy/huggingface/Dockerfile`.
- Filename **`README.md`** → paste the contents of `deploy/huggingface/README.md`
  (keep the `---` header — HF needs it).

Commit each. (Or drag-and-drop both files via **Add file → Upload files**.)

## 3. Add the cookies secret
Space → **Settings** → **Variables and secrets** → **New secret**:
- **Name:** `YTDLP_COOKIES_B64`
- **Value:** paste the whole line from the **`cookies-b64.txt`** I sent you.

(That's the base64 of your YouTube cookies; the server decodes it on startup.)

## 4. Let it build
The Space rebuilds automatically (watch the **Logs**). First build ~3–6 min.
When it shows **Running**, open the Space — you should see it's live.

## 5. Verify
Your URL is `https://<username>-nuclear-backend.hf.space` (shown on the Space page).

```
https://<username>-nuclear-backend.hf.space/health
```
→ `{"ok":true,...}`. Then test a resolve:
```
https://<username>-nuclear-backend.hf.space/resolve-stream?title=Believer&artist=Imagine%20Dragons&duration=204
```
→ JSON containing a `stream.url`. (First call may take ~10–20s cold; then cached.)

## 6. Keep it awake (optional but recommended)
Free Spaces pause after ~48h with no traffic. You already have an **UptimeRobot**
account — add an **HTTP(s) monitor** for `https://<username>-nuclear-backend.hf.space/health`
every 30 min. That keeps it warm 24/7 for free.

## 7. Hand me the URL
Give me `https://<username>-nuclear-backend.hf.space` and I'll bake it into the app
(`EXPO_PUBLIC_BACKEND_URL`) and rebuild the APK.

---

### Notes
- **Updating the backend later:** edit the `Dockerfile`, change `ARG CACHEBUST=1`
  to `2` (etc.), commit → the Space rebuilds and re-clones the latest code.
- **Cookies expire** eventually; if playback starts failing, re-export the burner's
  cookies, re-base64 them, and update the `YTDLP_COOKIES_B64` secret. Browsing/search
  keep working regardless (they're on-device).
- yt-dlp is pulled fresh on each build; rebuild occasionally if YouTube changes.
