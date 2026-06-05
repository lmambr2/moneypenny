# Moneypenny bot — production image (DESIGN §11)
# Multi-stage: build the TS backend + Vue UI, then ship a slim non-root runtime.

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build

# Toolchain for native modules (@discordjs/opus, better-sqlite3).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (cache-friendly). Root + web each have their own lockfile.
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

# Build backend (tsc → dist/) and frontend (vue-tsc + vite → web/dist/).
COPY . .
RUN npm run build

# Drop dev dependencies so only production deps (with compiled native addons)
# are carried into the runtime image.
RUN npm prune --omit=dev

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# Runtime media tools. yt-dlp is installed via pip; ffmpeg from apt.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # Bind all interfaces *inside* the container; the published port is
    # restricted to localhost host-side in docker-compose (DESIGN §11).
    BIND_ADDRESS=0.0.0.0

WORKDIR /app

# Non-root user (MANDATORY per DESIGN §11). The base image ships root.
RUN useradd -m -u 1000 moneypenny

# Copy only what the runtime needs, owned by the non-root user.
COPY --from=build --chown=moneypenny:moneypenny /app/node_modules ./node_modules
COPY --from=build --chown=moneypenny:moneypenny /app/dist ./dist
COPY --from=build --chown=moneypenny:moneypenny /app/web/dist ./web/dist
COPY --chown=moneypenny:moneypenny package.json ./

# /app/data holds the SQLite DB, logs, avatars, and config.json — must be
# writable by the non-root user. Lock it down (secrets at rest, §11).
RUN mkdir -p /app/data && chown -R moneypenny:moneypenny /app && chmod 700 /app/data

USER moneypenny
EXPOSE 3000

# Liveness probe via the public health endpoint (no extra deps — Node 20 fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
