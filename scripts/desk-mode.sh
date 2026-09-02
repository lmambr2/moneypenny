#!/usr/bin/env bash
# Re-enable the desk Ollama (:11435, GPU 0) after a game. Short keep_alive so
# the card yields again. Does not touch ollama-penny (:11434).
#
# Safe before dual-GPU: if :11435 is down, prints how to install it.
#
#   ./scripts/desk-mode.sh
#   DESK_MODEL=hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL ./scripts/desk-mode.sh
set -euo pipefail

DESK="${OLLAMA_DESK_URL:-http://127.0.0.1:11435}"
DESK="${DESK%/}"
MODEL="${DESK_MODEL:-}"
KEEP="${OLLAMA_DESK_KEEP_ALIVE:-5m}"

if ! curl -sf --max-time 2 "${DESK}/api/tags" >/dev/null; then
  echo "desk-mode: desk Ollama at ${DESK} is not up."
  echo "  Dual-GPU host: install host-setup/ollama-desk.service (docs/gpu-amd.md)."
  echo "  Single-GPU / not migrated yet: skip this — Penny stays on :11434."
  exit 0
fi

if [[ -z "${MODEL}" ]]; then
  MODEL="$(
    curl -sf --max-time 5 "${DESK}/api/tags" \
      | python3 -c 'import json,sys
data=json.load(sys.stdin)
models=data.get("models") or []
print(models[0]["name"] if models else "")
' 2>/dev/null || true
  )"
fi

if [[ -z "${MODEL}" ]]; then
  echo "desk-mode: no model on the desk daemon. Pull one, then rerun."
  echo "  OLLAMA_HOST=${DESK#http://} ollama pull <coder-or-31B>"
  exit 0
fi

echo "desk-mode: warming ${MODEL} (keep_alive=${KEEP})"
curl -sf --max-time 120 -X POST "${DESK}/api/generate" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"prompt\":\"\",\"keep_alive\":\"${KEEP}\",\"stream\":false,\"options\":{\"num_predict\":0}}" \
  >/dev/null
echo "desk-mode: desk is available. Penny on :11434 is unchanged."
