#!/usr/bin/env bash
# Export openai-whisper tiny → ONNX (20s) → RK3588 .rknn for SBC stt-rknn.
#
# Prereq: models/convert/.venv-rknn2 with rknn-toolkit2 (see script body).
# Usage:
#   ./models/convert/export-whisper-rknn.sh
#   MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh
set -euo pipefail
export TMPDIR="${TMPDIR:-$HOME/tmp}"
mkdir -p "$TMPDIR"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONVERT="$(cd "$(dirname "$0")" && pwd)"
VENV="${CONVERT}/.venv-rknn2"
ZOO="${CONVERT}/vendor/rknn_model_zoo/examples/whisper"
OUT="${ROOT}/models/rknn"
MODEL_TYPE="${MODEL_TYPE:-tiny}"
PLATFORM="${PLATFORM:-rk3588}"
DTYPE="${DTYPE:-fp}"  # i8 needs a dataset file

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "Missing $VENV — install rknn-toolkit2 first (see docs / prior session)." >&2
  exit 1
fi
if [[ ! -d "$ZOO/python" ]]; then
  echo "Missing rknn_model_zoo under $CONVERT/vendor — clone airockchip/rknn_model_zoo" >&2
  exit 1
fi

mkdir -p "$OUT"
# Ensure openai-whisper patched for 20s is present
"$VENV/bin/python" -c "import whisper" 2>/dev/null || {
  "$VENV/bin/pip" install --no-build-isolation 'setuptools<70' 'openai-whisper==20231117' onnxsim soundfile
}

# Export ONNX
cd "$ZOO/python"
"$VENV/bin/python" export_onnx.py --model_type "$MODEL_TYPE" --n_mels 80
ENC_ONNX="../model/whisper_encoder_${MODEL_TYPE}.onnx"
DEC_ONNX="../model/whisper_decoder_${MODEL_TYPE}.onnx"

# Convert
"$VENV/bin/python" convert.py "$ENC_ONNX" "$PLATFORM" "$DTYPE" \
  "$OUT/whisper-${MODEL_TYPE}-encoder.rknn"
"$VENV/bin/python" convert.py "$DEC_ONNX" "$PLATFORM" "$DTYPE" \
  "$OUT/whisper-${MODEL_TYPE}-decoder.rknn"

cp -f "$ZOO/model/vocab_en.txt" "$ZOO/model/mel_80_filters.txt" "$OUT/"
ls -lh "$OUT"/whisper-${MODEL_TYPE}-*.rknn "$OUT"/vocab_en.txt "$OUT"/mel_80_filters.txt
echo "Done. Rsync to Pi:"
echo "  rsync -avP $OUT/ dietpi@opi5:~/moneypenny/models/rknn/"
