# Moneypenny bot — production image (DESIGN §11)
# Multi-stage: build the TS backend + Vue UI, then ship a slim non-root runtime.
#
# Architecture / audio-native (PR-B4):
#   Native addons (@moneypenny/audio-native, better-sqlite3, opus) compile for
#   the *image* arch. Build on an arm64 host (Pi) or use buildx with qemu for
#   TARGETARCH=arm64 — plain `docker build` on x86 cannot emit arm64 .node
#   without a cross linker. Fallback: @discordjs/opus if audio-native fails.
#   Host script: ./scripts/build-audio-native.sh [--with-arm64]
#   See bot/packages/audio-native/README.md

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build

# BuildKit injects TARGETARCH (amd64 | arm64). Used for operator logs only;
# Node/Rust compile for the container platform automatically when not cross-linking.
ARG TARGETARCH

# Toolchain for native modules (@discordjs/opus, better-sqlite3, audio-native/libopus).
# Rust is optional: if the audio-native build fails, encoder falls back to @discordjs/opus.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential git ca-certificates pkg-config libopus-dev \
    curl \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

# Install deps first (cache-friendly). Root + web each have their own lockfile.
# Workspace package.json must be present so npm ci can link @moneypenny/* packages.
COPY package.json package-lock.json ./
COPY packages/ts6-client/package.json ./packages/ts6-client/
COPY packages/audio-native/package.json ./packages/audio-native/
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

# Build workspace packages → bot tsc → Vue UI.
# `build:native || true` inside npm run build keeps image green if Rust/napi fails.
COPY . .
RUN echo "building bot image arch=${TARGETARCH:-unknown}" \
    && npm run build

# `npm run build` tolerates a failed Rust/napi build (encoder falls back to
# @discordjs/opus), which means an arm64 image can silently ship without the
# native addon. Report which backend the built image actually has (audit C3).
# Informational only — the fallback is supported, so this must not fail the build.
ARG TARGETARCH
RUN node -e "import('./dist/audio/encoder.js').then(m=>{const i=m.opusBackendAvailable();console.log('[build] opus backend: '+JSON.stringify(i));if(!i.native)console.warn('[build] WARNING: audio-native addon did not build for arch='+(process.env.TARGETARCH||process.arch)+' — image will use the @discordjs/opus fallback');}).catch(e=>console.warn('[build] opus backend probe skipped: '+e.message))"

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
# libopus0: optional @moneypenny/audio-native (PR-B4); discordjs/opus still works without it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip ca-certificates pandoc aubio-tools libfftw3-double3 libopus0 \
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
