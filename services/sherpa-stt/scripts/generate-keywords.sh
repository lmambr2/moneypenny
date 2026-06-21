#!/usr/bin/env bash
# Generate a sherpa-onnx KWS keywords file for a custom English watchword.
# Requires: pip install sherpa-onnx click sentencepiece pypinyin
#
# Usage:
#   ./generate-keywords.sh MONEYPENNY ../keywords/moneypenny.txt
set -euo pipefail

WATCHWORD="${1:?watchword required (e.g. MONEYPENNY)}"
OUT="${2:?output path required}"
MODEL_DIR="${KWS_MODEL_DIR:-/models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01}"

if [[ ! -f "$MODEL_DIR/tokens.txt" || ! -f "$MODEL_DIR/bpe.model" ]]; then
  echo "KWS model not found at $MODEL_DIR (set KWS_MODEL_DIR)" >&2
  exit 1
fi

RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT
# Uppercase helps BPE align with the gigaspeech token table.
echo "${WATCHWORD^^} @${WATCHWORD^^}" >"$RAW"

sherpa-onnx-cli text2token \
  --tokens "$MODEL_DIR/tokens.txt" \
  --tokens-type bpe \
  --bpe-model "$MODEL_DIR/bpe.model" \
  "$RAW" "$OUT"

echo "Wrote $OUT:"
cat "$OUT"