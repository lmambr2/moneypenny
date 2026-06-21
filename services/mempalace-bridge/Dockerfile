FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

# MemPalace pulls chromadb + embedding stack on first use.
RUN pip install --no-cache-dir "mempalace>=3.4.0"

COPY server.py /app/server.py

ENV PYTHONUNBUFFERED=1 \
    PORT=8090 \
    MEMPALACE_PALACE_PATH=/data/palace \
    MEMPALACE_WING=moneypenny

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=120s --start-period=300s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8090/health || exit 1

CMD ["python3", "/app/server.py"]