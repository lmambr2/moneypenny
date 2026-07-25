#!/usr/bin/env bash
# Fetch the Silero VAD ONNX model for the optional `silero` VAD backend (audit C5).
#
# The energy segmenter is the default and needs nothing. This is only for
# A/B-ing model end-pointing, which is the suspected fix for commands being
# mis-segmented while music plays under the speaker.
#
# Also requires the runtime, which is deliberately NOT a package.json
# dependency (large native module, RK3588 is the primary target):
#
#   cd bot && npm i onnxruntime-node
#
# Then set voice.vadBackend=silero and voice.vadModelPath to the printed path.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${SILERO_MODELS_DIR:-$REPO_ROOT/models/silero}"
MODEL_PATH="$MODELS_DIR/silero_vad.onnx"
# Silero VAD v5 — 16 kHz, 512-sample frames, combined LSTM state tensor.
MODEL_URL="${SILERO_MODEL_URL:-https://raw.githubusercontent.com/snakers4/silero-vad/v5.1/src/silero_vad/data/silero_vad.onnx}"

if [ -f "$MODEL_PATH" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Silero VAD model already present: $MODEL_PATH"
  echo "Re-download with FORCE=1 $0"
  exit 0
fi

mkdir -p "$MODELS_DIR"
echo "Downloading Silero VAD v5 -> $MODEL_PATH"
if command -v curl >/dev/null 2>&1; then
  curl -fSL "$MODEL_URL" -o "$MODEL_PATH.tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$MODEL_URL" -O "$MODEL_PATH.tmp"
else
  echo "error: neither curl nor wget is available" >&2
  exit 1
fi

# ONNX files start with the protobuf magic for the ir_version field; a captive
# portal or 404 page would otherwise be written straight into models/.
if [ ! -s "$MODEL_PATH.tmp" ]; then
  rm -f "$MODEL_PATH.tmp"
  echo "error: downloaded file is empty" >&2
  exit 1
fi
if head -c 4 "$MODEL_PATH.tmp" | grep -q "<"; then
  rm -f "$MODEL_PATH.tmp"
  echo "error: downloaded file looks like HTML, not an ONNX model" >&2
  exit 1
fi

mv "$MODEL_PATH.tmp" "$MODEL_PATH"
echo "OK: $MODEL_PATH ($(wc -c <"$MODEL_PATH") bytes)"
echo
echo "Enable with:  voice.vadBackend=silero  voice.vadModelPath=$MODEL_PATH"
echo "Runtime dep:  cd bot && npm i onnxruntime-node"
