#!/usr/bin/env bash
# Serve Gemma 4 12B QAT + MTP on one R9700 for MoneyPenny (OpenAI /v1).
#
# Compute R9700 only (PCI 0000:07:00.0 / renderD129). Never renderD128.
# Docs: docs/gpu-amd.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/llama-cpp-env.sh
source "$ROOT/scripts/lib/llama-cpp-env.sh"

BIN="$(llama_server_bin)" || {
  echo "llama-server not found. Run ./scripts/build-llama-cpp-hip.sh" >&2
  exit 1
}
TARGET="$(gemma4_target_gguf)"
DRAFT="$(gemma4_draft_gguf)"
[ -s "$TARGET" ] || { echo "missing $TARGET — run ./scripts/download-gemma4-qat-gguf.sh" >&2; exit 1; }
[ -s "$DRAFT" ] || { echo "missing $DRAFT — run ./scripts/download-gemma4-qat-gguf.sh" >&2; exit 1; }

export ROCM_PATH="${ROCM_PATH:-/opt/rocm}"
export HIP_PATH="${HIP_PATH:-$ROCM_PATH}"
pin_rocm_compute_gpu || exit 1
export LD_LIBRARY_PATH="${ROCM_PATH}/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PATH="${ROCM_PATH}/bin:${PATH}"
if [ "${MONEYPENNY_COMPUTE_RENDER}" = "/dev/dri/renderD128" ]; then
  echo "refusing to start llama-server on renderD128" >&2
  exit 1
fi

# Spec: n-max 2 first. Raise to 4 only if spec accept stays >0.65.
N_MAX="${LLAMA_SPEC_DRAFT_N_MAX:-2}"
CTX="${LLAMA_CTX_SIZE:-16384}"
CACHE_K="${LLAMA_CACHE_TYPE_K:-q8_0}"
CACHE_V="${LLAMA_CACHE_TYPE_V:-q8_0}"

exec "$BIN" \
  -m "$TARGET" \
  --model-draft "$DRAFT" \
  --spec-type draft-mtp \
  --spec-draft-n-max "$N_MAX" \
  --parallel 1 \
  --ctx-size "$CTX" \
  --n-gpu-layers 99 \
  -fa on \
  --cache-type-k "$CACHE_K" \
  --cache-type-v "$CACHE_V" \
  --temp 1.0 --top-p 0.95 --top-k 64 \
  --jinja \
  --reasoning off \
  --chat-template-kwargs '{"enable_thinking":false}' \
  --host "${LLAMA_SERVER_HOST}" \
  --port "${LLAMA_SERVER_PORT}" \
  --alias "${LLAMA_SERVER_ALIAS}"
