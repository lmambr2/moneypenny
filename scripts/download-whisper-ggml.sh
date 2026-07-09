#!/usr/bin/env bash
# Download whisper.cpp ggml weights into a models directory (Server STT track).
#
#   ./scripts/download-whisper-ggml.sh              # small → ./models/whisper-cpp
#   ./scripts/download-whisper-ggml.sh tiny base
#   ./scripts/download-whisper-ggml.sh --dir /path large-v3
#
# Primary source: Hugging Face ggerganov/whisper.cpp (same files as whisper.cpp scripts).
set -euo pipefail

OUT_DIR="${STT_MODELS_DIR:-./models/whisper-cpp}"
MODELS=()

usage() {
  cat <<'EOF'
Usage: ./scripts/download-whisper-ggml.sh [--dir DIR] [MODEL ...]

Models: tiny base small medium large-v3 large-v3-turbo
Default model: small
Default dir:   ./models/whisper-cpp  (or $STT_MODELS_DIR)

After download, point compose volume whisper-models at this dir, or:
  STT_MODEL=small STT_MODEL_PATH=/models/ggml-small.bin
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dir) OUT_DIR="${2:?}"; shift 2 ;;
    -*) echo "unknown: $1" >&2; usage; exit 1 ;;
    *) MODELS+=("$1"); shift ;;
  esac
done
if [ ${#MODELS[@]} -eq 0 ]; then
  MODELS=(small)
fi

mkdir -p "$OUT_DIR"
# HF resolve URL pattern used by whisper.cpp community weights
BASE_URL="${WHISPER_GGML_BASE_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main}"

have() { command -v "$1" >/dev/null 2>&1; }
if have curl; then
  fetch() { curl -fL --retry 3 --retry-delay 2 -o "$2" "$1"; }
elif have wget; then
  fetch() { wget -O "$2" "$1"; }
else
  echo "need curl or wget" >&2
  exit 1
fi

for m in "${MODELS[@]}"; do
  name="ggml-${m}.bin"
  dest="${OUT_DIR}/${name}"
  if [ -f "$dest" ] && [ -s "$dest" ]; then
    echo "OK exists: $dest ($(du -h "$dest" | awk '{print $1}'))"
    continue
  fi
  url="${BASE_URL}/${name}"
  echo "GET $url → $dest"
  tmp="${dest}.partial"
  fetch "$url" "$tmp"
  mv "$tmp" "$dest"
  echo "OK $dest ($(du -h "$dest" | awk '{print $1}'))"
done

echo
echo "Next (Server edition):"
echo "  # bind or copy into compose volume whisper-models → /models"
echo "  export STT_MODEL=${MODELS[0]}"
echo "  docker compose -f docker-compose.yml -f docker-compose.server.yml \\"
echo "    --profile voice-server up -d --build stt-whisper"
