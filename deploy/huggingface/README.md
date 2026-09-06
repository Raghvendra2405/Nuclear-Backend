---
title: Nuclear Backend
emoji: 🎵
colorFrom: purple
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

Stream-resolution backend for the Nuclear mobile app (yt-dlp). Metadata runs
on-device in the app; this Space only serves `/resolve-stream` and `/stream`.
Set the `YTDLP_COOKIES_B64` secret (base64 of a YouTube cookies.txt).
