#!/usr/bin/env bash
# Prepare a flat .rkllm file for NotPunchnox/rkllama (models/<name>/ layout).
#
# Usage:
#   ./scripts/setup-notpunchnox-model.sh
#   ./scripts/setup-notpunchnox-model.sh /path/to/model.rkllm npu-llm
#   NPU_LLM_HF_REPO=org/your-instruct-model ./scripts/setup-notpunchnox-model.sh
#
# Copies (not symlinks) the .rkllm into models/<name>/ because Docker bind
# mounts do not follow host symlinks reliably.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${2:-npu-llm}"
SRC="${1:-$ROOT/models/$NAME/model.rkllm}"
DEST_DIR="$ROOT/models/$NAME"
DEST_FILE="$DEST_DIR/$(basename "$SRC")"
HF_REPO="${NPU_LLM_HF_REPO:-org/your-instruct-model}"

if [[ ! -f "$SRC" ]]; then
  echo "Source .rkllm not found: $SRC" >&2
  echo "Place your model at models/$NAME/model.rkllm or pass a path." >&2
  echo "Set NPU_LLM_HF_REPO to the Hugging Face repo for tokenizer/chat template." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
if [[ ! -f "$DEST_FILE" ]]; then
  echo "Copying $SRC → $DEST_FILE (may take a minute)…"
  cp "$SRC" "$DEST_FILE"
else
  echo "Model file already present: $DEST_FILE"
fi

cat > "$DEST_DIR/Modelfile" <<EOF
FROM="$(basename "$SRC")"
HUGGINGFACE_PATH="$HF_REPO"
TEMPERATURE=0.7
EOF

echo "NotPunchnox model ready: $NAME"
echo "  docker compose --profile npu up -d rkllama"
echo "  curl http://127.0.0.1:8080/api/tags"