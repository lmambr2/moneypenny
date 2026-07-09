# Whisper STT sidecar (faster-whisper) — x86 server primary; tiny/base ok on beefy ARM.
# GPU: use compose deploy reservations + image with CUDA (see docker-compose comments).
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py /app/server.py

# CPU wheels by default. For CUDA hosts, rebuild with extras or mount a CUDA base.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir faster-whisper==1.1.1

ENV PORT=9000 \
    STT_MODEL=small \
    STT_DEVICE=auto \
    STT_EAGER_LOAD=1

EXPOSE 9000
# Models download to /root/.cache — use a volume in compose for persistence.
CMD ["python3", "-u", "/app/server.py"]
