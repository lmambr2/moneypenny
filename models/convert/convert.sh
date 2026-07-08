#!/usr/bin/env bash
# x86-only: Gemma4 E2B QAT (HF safetensors) -> .rkllm W8A8 for RK3588.
#
# Source weights (NOT GGUF — rkllm-toolkit needs safetensors):
#   unsloth/gemma-4-E2B-it-qat-q4_0-unquantized
# Same QAT family as Ollama: hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL
#
# Usage:
#   ./models/convert/convert.sh
#   MODEL_DIR=/path/to/qat ./models/convert/convert.sh
#   SKIP_DOWNLOAD=1 ./models/convert/convert.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONVERT_DIR="$ROOT/models/convert"
VENV="$CONVERT_DIR/.venv"
HF_REPO="unsloth/gemma-4-E2B-it-qat-q4_0-unquantized"
MODEL_DIR="${MODEL_DIR:-$CONVERT_DIR/hf/$HF_REPO}"
OUT_NAME="gemma4-e2b-it-qat-w8a8.rkllm"
OUT_PATH="${OUT_PATH:-$CONVERT_DIR/$OUT_NAME}"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "Creating Python 3.12 venv at $VENV…" >&2
  python3.12 -m venv "$VENV"
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  export BUILD_CUDA_EXT=0
  pip install --upgrade pip wheel
  pip install /tmp/rknn-llm/rkllm-toolkit/packages/rkllm_toolkit-1.3.0-cp312-cp312-linux_x86_64.whl
  pip install -r /tmp/rknn-llm/rkllm-toolkit/packages/requirements.txt
else
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
fi

# ROCm: prefer discrete GPU (R9700 = device 0 in rocm-smi). Install once:
#   pip install torch torchvision --index-url https://download.pytorch.org/whl/rocm6.4
# rkllm-toolkit pins torch==2.6.0 but ROCm wheels are newer; conversion still works.
export HIP_VISIBLE_DEVICES="${HIP_VISIBLE_DEVICES:-0}"

if [[ "${SKIP_DOWNLOAD:-0}" != "1" && ! -f "$MODEL_DIR/model.safetensors" ]]; then
  echo "Downloading QAT safetensors: $HF_REPO -> $MODEL_DIR" >&2
  HF_REPO="$HF_REPO" MODEL_DIR="$MODEL_DIR" "$VENV/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download

repo = os.environ["HF_REPO"]
dest = os.environ["MODEL_DIR"]
os.makedirs(dest, exist_ok=True)
snapshot_download(repo_id=repo, local_dir=dest)
print("Download complete:", dest)
PY
fi

export GEMMA4_QAT_DIR="$MODEL_DIR"
export HF_REPO MODEL_DIR

if [[ ! -f "$CONVERT_DIR/data_quant.json" ]]; then
  echo "Generating calibration data (CPU/GPU — may take a while)…" >&2
  python "$CONVERT_DIR/generate_data_quant.py" -m "$MODEL_DIR"
fi

python "$CONVERT_DIR/export_gemma4_e2b_qat.py" \
  -m "$MODEL_DIR" \
  -o "$OUT_PATH"

echo ""
echo "Next: install on Pi"
echo "  rsync -avP \"$OUT_PATH\" dietpi@opi5:~/moneypenny/models/npu-llm/model.rkllm"
echo "  NPU_LLM_HF_REPO=$HF_REPO $ROOT/scripts/setup-notpunchnox-model.sh \"$OUT_PATH\" npu-llm"