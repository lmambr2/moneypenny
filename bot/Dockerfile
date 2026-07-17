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
# Workspace package.json must be present so npm ci can link @moneypenny/ts6-client.
COPY package.json package-lock.json ./
COPY packages/ts6-client/package.json ./packages/ts6-client/
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

# Build workspace package → bot tsc → Vue UI.
COPY . .
RUN npm run build

# Drop dev dependencies so only production deps (with compiled native addons)
# are carried into the runtime image.
RUN npm prune --omit=dev

# ── Stage 1b: radio analyzer CLIs (OQ2 — keyfinder-cli + aubio) ───────────
# libkeyfinder is not packaged on bookworm — build from source, then keyfinder-cli.
FROM debian:bookworm-slim AS analyzer
ARG LIBKEYFINDER_REF=2.2.8
ARG KEYFINDER_CLI_REF=v1.2.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates cmake g++ git make pkg-config ffmpeg libfftw3-dev \
    libavformat-dev libavcodec-dev libswresample-dev libavutil-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${LIBKEYFINDER_REF}" \
      https://github.com/mixxxdj/libkeyfinder.git /src/libkeyfinder \
    && cmake -DCMAKE_INSTALL_PREFIX=/usr/local -DBUILD_TESTING=OFF \
        -S /src/libkeyfinder -B /src/libkeyfinder/build \
    && cmake --build /src/libkeyfinder/build -j"$(nproc)" \
    && cmake --install /src/libkeyfinder/build \
    && rm -rf /src/libkeyfinder
RUN git clone --depth 1 --branch "${KEYFINDER_CLI_REF}" \
      https://github.com/evanpurkhiser/keyfinder-cli.git /src/keyfinder-cli \
    && cmake -DCMAKE_INSTALL_PREFIX=/usr/local -S /src/keyfinder-cli -B /src/keyfinder-cli/build \
    && cmake --build /src/keyfinder-cli/build -j"$(nproc)" \
    && cmake --install /src/keyfinder-cli/build \
    && rm -rf /src/keyfinder-cli

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# Runtime media tools. yt-dlp is installed via pip; ffmpeg from apt.
# aubio-tools: BPM detection for the radio analyzer sidecar (docs/radio.md §9.5).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip ca-certificates pandoc aubio-tools libfftw3-double3 \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*
COPY --from=analyzer /usr/local/bin/keyfinder-cli /usr/local/bin/keyfinder-cli
COPY --from=analyzer /usr/local/lib /usr/local/lib
RUN ldconfig

ENV NODE_ENV=production \
    # Bind all interfaces *inside* the container; the published port is
    # restricted to localhost host-side in docker-compose (DESIGN §11).
    BIND_ADDRESS=0.0.0.0

WORKDIR /app

# Non-root user (MANDATORY per DESIGN §11). The node base image already ships a
# 'node' user at uid 1000 — replace it with ours so we own uid 1000 (matches the
# host bind-mount ownership the compose file expects).
RUN userdel -r node 2>/dev/null || true; \
    groupadd -g 1000 moneypenny || true; \
    useradd -m -u 1000 -g 1000 -s /usr/sbin/nologin moneypenny

# Copy only what the runtime needs, owned by the non-root user.
# Workspace packages are symlinked from node_modules → packages/*; ship both.
COPY --from=build --chown=moneypenny:moneypenny /app/node_modules ./node_modules
COPY --from=build --chown=moneypenny:moneypenny /app/packages ./packages
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
