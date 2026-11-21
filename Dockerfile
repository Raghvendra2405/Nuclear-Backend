# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM scratch AS ytdlp-amd64
ADD --chmod=0555 --checksum=sha256:767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795 https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux /yt-dlp

FROM scratch AS ytdlp-arm64
ADD --chmod=0555 --checksum=sha256:e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483 https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux_aarch64 /yt-dlp

FROM ytdlp-${TARGETARCH} AS ytdlp

# The provider image contains the server and its native canvas dependency.
FROM brainicism/bgutil-ytdlp-pot-provider:2.0.2 AS runtime
USER root
ENV NODE_ENV=production \
    POT_PROVIDER_BASE_URL=http://127.0.0.1:4416 \
    YTDLP_JS_RUNTIME=node

COPY --from=ytdlp /yt-dlp /usr/local/bin/yt-dlp
ADD --chmod=0444 --checksum=sha256:a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/2.0.2/bgutil-ytdlp-pot-provider.zip /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip

WORKDIR /srv
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY --chmod=0555 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
