#!/usr/bin/env bash
# Keep the Moneypenny 12B chat model resident on the LAN Ollama workstation.
# Never load it beside a heavier model (31B) — that OOMs a 32 GB box.
set -euo pipefail

MODEL="${MONEYPENNY_CHAT_MODEL:-hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL}"
URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
KEEP="${OLLAMA_KEEP_ALIVE:-24h}"

if command -v python3 >/dev/null 2>&1; then
  if ! python3 - "$URL" "$MODEL" <<'PY'
import json, sys, urllib.request

url, chat = sys.argv[1], sys.argv[2]
try:
    with urllib.request.urlopen(url + "/api/ps", timeout=5) as resp:
        models = json.load(resp).get("models") or []
except Exception:
    raise SystemExit(0)

embed = ("embed", "bge-", "nomic-embed", "minilm")
for model in models:
    name = model.get("name") or ""
    lower = name.lower()
    if name == chat or name.startswith(chat):
        continue
    if any(token in lower for token in embed):
        continue
    size = int(model.get("size_vram") or model.get("size") or 0)
    if size >= 4 * 1024**3 or "31b" in lower:
        raise SystemExit(1)
raise SystemExit(0)
PY
  then
    echo "skip keepalive: a heavy non-chat model is already loaded" >&2
    exit 0
  fi
fi

curl -sf -X POST "${URL}/api/generate" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":\"${KEEP}\",\"options\":{\"num_predict\":0}}" \
  >/dev/null
