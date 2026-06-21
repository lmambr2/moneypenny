FROM python:3.12-slim
WORKDIR /app
COPY server.py /app/server.py
ENV PYTHONUNBUFFERED=1 \
    PORT=9000 \
    MOCK_STT_TEXT=skip \
    MIN_PCM_BYTES=64
EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9000/health',timeout=3).status==200 else 1)"
CMD ["python3", "/app/server.py"]