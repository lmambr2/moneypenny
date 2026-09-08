FROM python:3.12-slim
WORKDIR /app
COPY server.py /app/server.py
ENV PYTHONUNBUFFERED=1 \
    PORT=8999 \
    MOCK_VOICE=NATF2 \
    MOCK_LOADED=1 \
    MOCK_RTF=0.5 \
    MOCK_WORKING_SET_MB=64
EXPOSE 8999
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8999/health',timeout=3).status==200 else 1)"
CMD ["python3", "/app/server.py"]
