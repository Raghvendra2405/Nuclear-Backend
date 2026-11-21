# syntax=docker/dockerfile:1
# Hugging Face Docker Space for the Nuclear backend (stream resolution only —
# metadata runs on-device in the app). Free, no card, ~2 vCPU, HTTPS.
# HF Spaces are x86_64 and route to port 7860.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone (x86_64) — bundles its own Python; needs no system Python.
ADD --chmod=0555 --checksum=sha256:767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795 https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux /usr/local/bin/yt-dlp

WORKDIR /app
# Set SOURCE_REF to the release commit SHA or tag in the Space Dockerfile.
ARG SOURCE_REF=main
RUN git init . \
 && git fetch --depth 1 https://github.com/Raghvendra2405/Nuclear-Backend.git "$SOURCE_REF" \
 && git checkout --detach FETCH_HEAD \
 && npm ci --ignore-scripts \
 && npm run build \
 && npm prune --omit=dev --ignore-scripts

ENV NODE_ENV=production
ENV PORT=7860
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV YTDLP_JS_RUNTIME=node
# YouTube cookies are provided at runtime via the HF Space secret
# YTDLP_COOKIES_B64 (base64 of cookies.txt) — the server decodes it on start.

EXPOSE 7860
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
