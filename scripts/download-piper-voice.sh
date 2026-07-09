#!/usr/bin/env bash
# Download a Piper voice (onnx + json) into a models directory.
#
# Usage:
#   ./scripts/download-piper-voice.sh                          # default en_GB-cori-medium
#   ./scripts/download-piper-voice.sh en_GB-cori-medium
#   ./scripts/download-piper-voice.sh en_GB-alba-medium /path/to/models
#
# Voices: https://huggingface.co/rhasspy/piper-voices (en/en_GB/…)
# Product default: en_GB-cori-medium (British female, medium quality).

set -euo pipefail

VOICE="${1:-en_GB-cori-medium}"
OUT_DIR="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Map voice id → HF path under en/en_GB/<speaker>/<quality>/
# voice form: en_GB-<speaker>-<quality>
if [[ ! "$VOICE" =~ ^en_GB-([a-z0-9_]+)-(x_low|low|medium|high)$ ]]; then
  echo "Unsupported voice id '$VOICE' (expected en_GB-<speaker>-<quality>)" >&2
  exit 1
fi
SPEAKER="${BASH_REMATCH[1]}"
QUALITY="${BASH_REMATCH[2]}"

BASE="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/${SPEAKER}/${QUALITY}"
ONNX_URL="${BASE}/${VOICE}.onnx"
JSON_URL="${BASE}/${VOICE}.onnx.json"

if [[ -z "$OUT_DIR" ]]; then
  # Prefer local models/piper if present, else Pi-style volume mount path via env
  if [[ -d "$ROOT/models/piper" ]]; then
    OUT_DIR="$ROOT/models/piper"
  else
    OUT_DIR="$ROOT/models/piper"
  fi
fi
mkdir -p "$OUT_DIR"

echo "Downloading Piper voice: $VOICE"
echo "  → $OUT_DIR"
curl -fsSL -o "${OUT_DIR}/${VOICE}.onnx" "$ONNX_URL"
curl -fsSL -o "${OUT_DIR}/${VOICE}.onnx.json" "$JSON_URL"
ls -lh "${OUT_DIR}/${VOICE}.onnx" "${OUT_DIR}/${VOICE}.onnx.json"
echo "OK. Set PIPER_VOICE=$VOICE and PIPER_MODEL=/models/${VOICE}.onnx (or rebuild piper-tts image)."
