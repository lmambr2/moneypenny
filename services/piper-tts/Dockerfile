# Piper TTS — default British female medium (cori).
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Piper CLI (static binary). Archives use uname -m: x86_64 | aarch64.
ARG PIPER_VERSION=2023.11.14-2
RUN set -e; \
    ARCH="$(uname -m)"; \
    curl -fsSL -o /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${ARCH}.tar.gz" \
    && mkdir -p /opt/piper \
    && tar -xzf /tmp/piper.tar.gz -C /opt/piper \
    && PIPER_BIN="$(find /opt/piper -type f -name piper | head -1)" \
    && ln -sf "$PIPER_BIN" /usr/local/bin/piper \
    && rm -f /tmp/piper.tar.gz \
    || (echo "WARN: piper binary download failed for ${ARCH} — espeak-ng fallback only" && true)

# Canonical product voice: en_GB-cori-medium (British female, medium quality).
# Also ship the old low southern_english as fallback if request names it.
# https://huggingface.co/rhasspy/piper-voices
ARG VOICE_ID=en_GB-cori-medium
ARG VOICE_BASE=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/cori/medium
ARG FALLBACK_BASE=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/southern_english_female/low
RUN mkdir -p /models \
    && curl -fsSL -o /models/${VOICE_ID}.onnx \
         "${VOICE_BASE}/${VOICE_ID}.onnx" \
    && curl -fsSL -o /models/${VOICE_ID}.onnx.json \
         "${VOICE_BASE}/${VOICE_ID}.onnx.json" \
    && curl -fsSL -o /models/en_GB-southern_english_female-low.onnx \
         "${FALLBACK_BASE}/en_GB-southern_english_female-low.onnx" \
    && curl -fsSL -o /models/en_GB-southern_english_female-low.onnx.json \
         "${FALLBACK_BASE}/en_GB-southern_english_female-low.onnx.json"

WORKDIR /app
COPY server.py /app/server.py
RUN chmod +x /app/server.py

ENV PORT=8880 \
    PIPER_BIN=/usr/local/bin/piper \
    PIPER_MODEL=/models/en_GB-cori-medium.onnx \
    PIPER_VOICE=en_GB-cori-medium \
    PIPER_MODELS_DIR=/models

EXPOSE 8880
# Models owned by root; nobody can read them if 644
RUN chmod -R a+rX /models /app
USER nobody
CMD ["python3", "-u", "/app/server.py"]
