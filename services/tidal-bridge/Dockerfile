# Moneypenny Tidal bridge — resolves Tidal refs to playable stream URLs via the
# unofficial python-tidal library + your account (HiFi). See server.py.
FROM python:3.12-slim

# Pin a known-good python-tidal. NOTE: must be 0.8.x — 0.7.x's default OAuth
# client_id (zU4XHVVkc2tDPo4t) registers as a plain "Android Automotive" device
# that Tidal does NOT grant track playback to: metadata resolves fine but every
# playbackinfopostpaywall returns 401 subStatus 4005 "Asset is not ready for
# playback". 0.8.x's client_id (fX2JxdmntZWK0ixT) registers as "Android
# Automotive HiRes" which IS entitled. Re-login is required after bumping across
# this boundary (the cached refresh token is bound to the old client_id).
RUN pip install --no-cache-dir "tidalapi>=0.8.11,<0.9"

WORKDIR /app
COPY server.py /app/server.py

# PYTHONUNBUFFERED: flush stdout line-by-line. Without it, python-tidal's
# device-login print ("Visit link.tidal.com/XXXX …") sits in the block buffer
# and only surfaces when the 300s login times out — i.e. the link is unusable in
# real time and every login "takes too long". Keep this set.
ENV PYTHONUNBUFFERED=1 \
    PORT=8081 \
    TIDAL_SESSION_FILE=/data/tidal-session.json \
    TIDAL_QUALITY=LOSSLESS

VOLUME ["/data"]
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8081/health',timeout=3).status==200 else 1)"

CMD ["python3", "/app/server.py"]
