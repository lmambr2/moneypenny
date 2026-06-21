#!/usr/bin/env bash
# Launch the Moneypenny RKLLama gateway (OpenAI-compatible) over RKLLM.
#
#   RKLLM_BACKEND=mock   (default) — no NPU; canned/echo responses for dev + for
#                        validating the bot end-to-end on any machine.
#   RKLLM_BACKEND=native           — real inference via librkllmrt + MODEL_PATH
#                        (requires the host NPU driver + mounted librkllmrt.so).

set -euo pipefail

echo "RKLLama gateway starting..."
echo "  RKLLM_BACKEND=${RKLLM_BACKEND:-mock}"
echo "  PORT=${PORT:-8080}  MAX_CONTEXT=${MAX_CONTEXT:-2048}"
if [ "${RKLLM_BACKEND:-mock}" = "native" ]; then
  echo "  MODEL_PATH=${MODEL_PATH:-/models/default.rkllm}"
fi

exec python3 /app/server.py
