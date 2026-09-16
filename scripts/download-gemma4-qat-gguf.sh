#!/usr/bin/env bash
# Fetch the single-R9700 MoneyPenny GGUFs (no mmproj, no BF16).
#
#   ./scripts/download-gemma4-qat-gguf.sh
#
# Target: Unsloth UD-Q4_K_XL (~6.7 GB) + official MTP Q8_0 draft (~465 MB)
# from unsloth/gemma-4-12B-it-qat-GGUF.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/llama-cpp-env.sh
source "$ROOT/scripts/lib/llama-cpp-env.sh"

HF_BASE="${HF_BASE:-https://huggingface.co}"
mkdir -p "${MONEYPENNY_GGUF_DIR}"

have() { command -v "$1" >/dev/null 2>&1; }
if have curl; then
  fetch() {
    local url="$1" dest="$2"
    curl -fL --retry 5 --retry-delay 2 -C - -o "$dest" "$url"
  }
elif have wget; then
  fetch() {
    local url="$1" dest="$2"
    wget -c -O "$dest" "$url"
  }
else
  echo "need curl or wget" >&2
  exit 1
fi

download() {
  local rel="$1" dest="$2"
  if [ -f "$dest" ] && [ -s "$dest" ]; then
    echo "OK exists: $dest ($(du -h "$dest" | awk '{print $1}'))"
    return 0
  fi
  local url="${HF_BASE}/${GEMMA4_QAT_REPO}/resolve/main/${rel}"
  local tmp="${dest}.partial"
  echo "GET $url"
  fetch "$url" "$tmp"
  mv "$tmp" "$dest"
  echo "OK $dest ($(du -h "$dest" | awk '{print $1}'))"
}

download "${GEMMA4_QAT_FILE}" "$(gemma4_target_gguf)"
download "${GEMMA4_MTP_REPO_PATH}" "$(gemma4_draft_gguf)"

echo
echo "Do not load mmproj-*.gguf — MoneyPenny owns STT/TTS."
echo "Next: ./scripts/install-llama-server.sh"
