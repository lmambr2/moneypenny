# services/rkllama/Dockerfile
# RKLLama gateway for RK3588 — OpenAI-compatible /v1/chat/completions over RKLLM.
#
# ubuntu:24.04 matches the Orange Pi userspace so the host's librkllmrt (RKLLM
# 1.2.x, installed by host-setup/install-npu.sh) is ABI-compatible when mounted
# in for the native backend. The gateway itself is pure stdlib Python — no extra
# packages — and defaults to the mock backend so the container is useful without
# the NPU (RKLLM_BACKEND=native enables real inference on the board).

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server.py rkllama-entrypoint.sh /app/
RUN chmod +x /app/rkllama-entrypoint.sh

ENV RKLLM_BACKEND=mock \
    PORT=8080 \
    MAX_CONTEXT=2048

EXPOSE 8080

# Liveness for compose — stdlib, no curl needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/health',timeout=3).status==200 else 1)"

CMD ["/app/rkllama-entrypoint.sh"]
