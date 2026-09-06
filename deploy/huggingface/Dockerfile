# Hugging Face Docker Space for the Nuclear backend (stream resolution only —
# metadata runs on-device in the app). Free, no card, ~2 vCPU, HTTPS.
# HF Spaces are x86_64 and route to port 7860.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone (x86_64) — bundles its own Python; needs no system Python.
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
# Clone + build the backend from GitHub. (Bump this ARG to force a fresh clone
# when you push backend changes — HF caches layers otherwise.)
ARG CACHEBUST=1
RUN git clone --depth 1 https://github.com/Raghvendra2405/Nuclear-Backend.git . \
 && npm ci \
 && npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force

ENV NODE_ENV=production
ENV PORT=7860
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV YTDLP_JS_RUNTIME=node
# YouTube cookies are provided at runtime via the HF Space secret
# YTDLP_COOKIES_B64 (base64 of cookies.txt) — the server decodes it on start.

EXPOSE 7860
CMD ["node", "dist/server.js"]
