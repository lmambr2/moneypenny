# Moneypenny TurboVec vector store — Qdrant-compatible REST subset for RAG.
# Replaces the qdrant service (VECTOR_DB_URL=http://turbovec:6333).
FROM python:3.12-slim

# turbovec ships manylinux wheels (x86_64 + aarch64). Pull numpy via its deps.
RUN pip install --no-cache-dir "turbovec>=0.8.0,<0.9" numpy

WORKDIR /app
COPY server.py /app/server.py

ENV PYTHONUNBUFFERED=1 \
    PORT=6333 \
    TURBOVEC_DATA=/data \
    TURBOVEC_BIT_WIDTH=4 \
    TURBOVEC_NORMALIZE=1

VOLUME ["/data"]
EXPOSE 6333

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:6333/health',timeout=3).status==200 else 1)"

CMD ["python3", "/app/server.py"]
