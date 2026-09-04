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
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# yt-dlp: the standalone Linux binary bundles its own Python, so the image
# needs no system Python. ADD fetches it at build time (self-contained).
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

# Production deps only (fastify); devDeps like tsx/typescript aren't needed here.
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Hosts inject $PORT; the server reads it (falls back to 4000) and binds 0.0.0.0.
EXPOSE 4000
CMD ["node", "dist/server.js"]
