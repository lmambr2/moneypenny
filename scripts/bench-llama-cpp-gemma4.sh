#!/usr/bin/env bash
# 30-minute secretary-bot bench from docs/gpu-amd.md.
#
#   ./scripts/bench-llama-cpp-gemma4.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/llama-cpp-env.sh
source "$ROOT/scripts/lib/llama-cpp-env.sh"

BENCH="$(llama_bench_bin)" || {
  echo "llama-bench not found. Run ./scripts/build-llama-cpp-hip.sh" >&2
  exit 1
}
TARGET="$(gemma4_target_gguf)"
[ -s "$TARGET" ] || { echo "missing $TARGET" >&2; exit 1; }

export ROCM_PATH="${ROCM_PATH:-/opt/rocm}"
pin_rocm_compute_gpu || exit 1
export LD_LIBRARY_PATH="${ROCM_PATH}/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

echo "== 1) LLM alone (no MTP) =="
"$BENCH" -m "$TARGET" -ngl 99 -fa 1 -p 512 -n 128

echo
echo "== 2) llama-server + 128-token completion (MTP is the number that matters) =="
if curl -sf --max-time 2 "http://${LLAMA_SERVER_HOST}:${LLAMA_SERVER_PORT}/v1/models" >/dev/null; then
  curl -sS --max-time 120 "http://${LLAMA_SERVER_HOST}:${LLAMA_SERVER_PORT}/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${LLAMA_SERVER_ALIAS}\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with a single short sentence confirming you are online.\"}],\"max_tokens\":128,\"temperature\":1.0,\"top_p\":0.95}"
  echo
  echo "Watch journalctl --user -u llama-server-gemma4 for spec accept."
else
  echo "llama-server not up on :${LLAMA_SERVER_PORT}. Start it, then rerun step 2."
fi

echo
echo "== 3) voice-smoke (optional) =="
echo "  ./scripts/voice-smoke.sh --up-mock"
echo "Pass: decode ≥ 60 tok/s thinking off, TTFT < 150 ms @ 8K, amd-smi peak < 24 GB"
