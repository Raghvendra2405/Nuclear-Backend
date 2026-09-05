# syntax=docker/dockerfile:1

# ---- build stage: compile TypeScript -> dist ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
# Based on the official bgutil PO-token provider image. That image already ships
# the provider server (/app/build/main.js) with its node_modules — including the
# native `canvas` addon prebuilt for its Node 26 runtime — plus all the system
# libs canvas needs. Reusing it avoids reproducing a fragile native build here.
#
# Why we need it: plain yt-dlp gets YouTube's "Sign in to confirm you're not a
# bot" block from a datacenter IP (Render), so /resolve-stream fails in the cloud
# even though it works from a residential dev IP. The provider mints WebPO tokens
# that get past that block. See README "Stream resolution & PO tokens".
FROM brainicism/bgutil-ytdlp-pot-provider:1.3.2 AS runtime
USER root
ENV NODE_ENV=production

# yt-dlp: the standalone Linux binary bundles its own Python (no system Python).
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

# bgutil yt-dlp plugin, version-matched to the provider server (1.3.2). yt-dlp
# loads a .zip containing a yt_dlp_plugins/ root directly from its system plugin
# dir, so no unzip step is needed.
ADD https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/1.3.2/bgutil-ytdlp-pot-provider.zip /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip

# Backend -> provider address (read by src/providers/ytdlp.ts). Only set here, so
# local dev (no provider) leaves the yt-dlp commands unchanged.
ENV POT_PROVIDER_BASE_URL=http://127.0.0.1:4416
# Recent yt-dlp needs an external JS runtime for YouTube; node is in this image.
ENV YTDLP_JS_RUNTIME=node

# ---- backend app (kept out of the provider's /app dir) ----
WORKDIR /srv
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Entrypoint launches the PO-token provider (127.0.0.1:4416) then the backend.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Hosts inject $PORT; the server reads it (falls back to 4000) and binds 0.0.0.0.
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
