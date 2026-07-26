# SBC-track STT: RKNN Whisper (NPU) with faster-whisper CPU fallback.
# Intended for aarch64 / RK3588. On other arches, only the CPU fallback works.
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.py rknn_whisper_infer.py /app/
COPY README.md /app/README.md

# faster-whisper always (fallback). rknnlite is optional — install on aarch64 when available.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir \
         faster-whisper==1.1.1 \
         numpy==2.2.6 \
         requests \
    && (pip install --no-cache-dir rknn-toolkit-lite2==2.3.2 \
        || pip install --no-cache-dir rknnlite \
        || echo "rknnlite not on this platform — CPU fallback only")

# SenseVoice backend (STT_BACKEND=sensevoice). --no-deps is deliberate: the
# rkvoice-stream package pins numpy<2 and pulls fastapi/uvicorn for its own
# server, none of which this service uses — it only calls the backend class
# directly. sentencepiece is the one real runtime dep (the 25055-token BPE
# vocab, loaded in preload()); soundfile is only used by its file-decode path,
# which we bypass by handing it a float32 array.
RUN pip install --no-cache-dir --no-deps rkvoice-stream==0.1.1 \
    && pip install --no-cache-dir sentencepiece

ENV PORT=9000 \
    STT_MODEL=tiny \
    STT_DEVICE=npu \
    STT_BACKEND=rknn \
    STT_FALLBACK=faster-whisper \
    RKNN_MODELS_DIR=/models/rknn \
    STT_EAGER_LOAD=1

VOLUME ["/models"]
EXPOSE 9000
CMD ["python3", "-u", "/app/server.py"]
