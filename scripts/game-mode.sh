#!/usr/bin/env bash
# Unload desk models on GPU 0 so a game (or anything else) can take the card.
# Leaves ollama-penny (:11434, GPU 1) running — voice must keep working in-raid.
#
# Safe to run before the dual-R9700 box exists: if :11435 is down, this is a no-op.
#
#   ./scripts/game-mode.sh
#   OLLAMA_DESK_URL=http://127.0.0.1:11435 ./scripts/game-mode.sh
set -euo pipefail

DESK="${OLLAMA_DESK_URL:-http://127.0.0.1:11435}"
DESK="${DESK%/}"

if ! curl -sf --max-time 2 "${DESK}/api/tags" >/dev/null; then
  echo "game-mode: desk Ollama at ${DESK} is not up — nothing to unload."
  echo "  (Expected until the second R9700 is installed. See docs/gpu-amd.md.)"
  exit 0
fi

names="$(
  curl -sf --max-time 5 "${DESK}/api/ps" \
    | python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for m in data.get("models") or []:
    name=m.get("name") or m.get("model")
    if name:
        print(name)
' 2>/dev/null || true
)"

if [[ -z "${names}" ]]; then
  echo "game-mode: desk Ollama has no loaded models."
  exit 0
fi

while IFS= read -r model; do
  [[ -z "${model}" ]] && continue
  echo "game-mode: unloading ${model}"
  curl -sf --max-time 30 -X POST "${DESK}/api/generate" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${model}\",\"keep_alive\":0,\"stream\":false}" \
    >/dev/null || true
done <<<"${names}"

echo "game-mode: desk GPU is free. Penny on :11434 is unchanged."
