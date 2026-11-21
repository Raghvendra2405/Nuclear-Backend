---
title: Nuclear Backend
emoji: 🎵
colorFrom: purple
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

Backend for the Nuclear mobile app. Check `/ready` after deployment and verify
playback through `/resolve-stream` and `/stream`. Set `YTDLP_COOKIES_B64` in the
Space secrets if the resolver needs a cookie file.
