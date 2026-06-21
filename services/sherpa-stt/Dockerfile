FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl bzip2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG SHERPA_MODEL_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2
ARG SHERPA_MODEL_DIR=sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27
ARG KWS_MODEL_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2
ARG KWS_MODEL_DIR=sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
ARG SILERO_VAD_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx

RUN mkdir -p /models \
  && curl -fsSL "$SHERPA_MODEL_URL" -o /tmp/asr.tar.bz2 \
  && tar -xjf /tmp/asr.tar.bz2 -C /models \
  && rm /tmp/asr.tar.bz2 \
  && test -f "/models/${SHERPA_MODEL_DIR}/tokens.txt" \
  && test -f "/models/${SHERPA_MODEL_DIR}/encoder_model.ort" \
  && curl -fsSL "$KWS_MODEL_URL" -o /tmp/kws.tar.bz2 \
  && tar -xjf /tmp/kws.tar.bz2 -C /models \
  && rm /tmp/kws.tar.bz2 \
  && test -f "/models/${KWS_MODEL_DIR}/tokens.txt" \
  && test -f "/models/${KWS_MODEL_DIR}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" \
  && curl -fsSL "$SILERO_VAD_URL" -o /models/silero_vad.onnx

RUN pip install --no-cache-dir "sherpa-onnx>=1.12.0" numpy

COPY server.py /app/server.py
COPY keywords /app/keywords

ENV PYTHONUNBUFFERED=1 \
    PORT=9000 \
    MODEL_DIR=/models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27 \
    KWS_MODEL_DIR=/models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01 \
    KEYWORDS_FILE=/app/keywords/moneypenny.txt \
    COMMAND_KEYWORDS_FILE=/app/keywords/commands.txt \
    KWS_THRESHOLD=0.10 \
    KWS_SCORE=3.0 \
    KWS_TRAILING_BLANKS=8 \
    VAD_MODEL=/models/silero_vad.onnx \
    NUM_THREADS=4 \
    MIN_PCM_BYTES=320 \
    PARTIAL_DECODE_INTERVAL_S=999

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD python3 -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:9000/health',timeout=8); sys.exit(0 if r.status==200 else 1)"

CMD ["python3", "/app/server.py"]