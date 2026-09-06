# Rust bot image (strangler). Sidecars stay out of this binary.
# Builder: rust:1-bookworm + pkg-config libopus-dev (same as audio-native).
# Runtime: slim + ffmpeg + yt-dlp + libopus0. Do not embed Ollama/Whisper.

FROM rust:1-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libopus-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY crates /src/crates
WORKDIR /src/crates
# native ISA is set by the host that builds the image (Pi builds arm64).
ARG RUSTFLAGS=""
ENV RUSTFLAGS="${RUSTFLAGS}"
RUN cargo build --release -p moneypenny -p mp-audio

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg libopus0 python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000 moneypenny && \
    useradd -m -u 1000 -g 1000 -s /usr/sbin/nologin moneypenny

WORKDIR /app
COPY --from=builder --chown=moneypenny:moneypenny /src/crates/target/release/moneypenny /app/moneypenny
RUN mkdir -p /app/data /app/web/dist && chown -R moneypenny:moneypenny /app && chmod 700 /app/data

ENV BIND_ADDRESS=0.0.0.0 \
    MONEYPENNY_DATA_DIR=/app/data \
    MONEYPENNY_WEB_DIST=/app/web/dist \
    BOT_RUNTIME=rust

USER moneypenny
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/api/healthz')" || exit 1

ENTRYPOINT ["/app/moneypenny"]
