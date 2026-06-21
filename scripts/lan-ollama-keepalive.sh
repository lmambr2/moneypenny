#!/usr/bin/env bash
# Keep the Moneypenny chat model resident on the LAN Ollama workstation.
# Ollama's default OLLAMA_KEEP_ALIVE is 5m; idle gaps cause cold reloads (~0.5s+).
set -euo pipefail

MODEL="${MONEYPENNY_CHAT_MODEL:-hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL}"
URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
KEEP="${OLLAMA_KEEP_ALIVE:-6h}"

curl -sf -X POST "${URL}/api/generate" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":\"${KEEP}\",\"options\":{\"num_predict\":0}}" \
  >/dev/null