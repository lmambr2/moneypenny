#!/usr/bin/env bash
# Detect which Moneypenny edition this host should run.
# Prints: edition=<sbc|server> and key facts. Exit 0 always.
# Usage: ./scripts/detect-edition.sh
#        EDITION=$(./scripts/detect-edition.sh | awk -F= '/^edition=/{print $2}')
set -euo pipefail

ARCH="$(uname -m)"
HAS_NPU=0
if [ -e /dev/rknpu ] || [ -e /sys/class/devfreq/fdab0000.npu ]; then
  HAS_NPU=1
fi
HAS_NVIDIA=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  HAS_NVIDIA=1
fi

EDITION="server"
REASON="default x86/generic host"

case "$ARCH" in
  aarch64|arm64)
    if [ "$HAS_NPU" -eq 1 ]; then
      EDITION="sbc"
      REASON="aarch64 + RK3588 NPU (Orange Pi class)"
    else
      EDITION="sbc"
      REASON="aarch64 without NPU nodes — still SBC-class (edge defaults)"
    fi
    ;;
  x86_64|amd64)
    EDITION="server"
    if [ "$HAS_NVIDIA" -eq 1 ]; then
      REASON="x86_64 + NVIDIA GPU"
    else
      REASON="x86_64 CPU-only"
    fi
    ;;
  *)
    EDITION="server"
    REASON="unknown arch ${ARCH} — using server defaults"
    ;;
esac

# Override for packaging / CI
if [ -n "${MONEYPENNY_EDITION:-}" ]; then
  case "$MONEYPENNY_EDITION" in
    sbc|server)
      EDITION="$MONEYPENNY_EDITION"
      REASON="MONEYPENNY_EDITION env override"
      ;;
  esac
fi

echo "edition=$EDITION"
echo "arch=$ARCH"
echo "npu=$HAS_NPU"
echo "nvidia=$HAS_NVIDIA"
echo "reason=$REASON"

if [ "$EDITION" = "sbc" ]; then
  echo "compose_file=docker-compose.yml:docker-compose.sbc.yml"
  echo "default_profiles=core,ollama,rag,voice-edge"
  echo "default_stt_model=tiny"
  echo "default_llm_model=hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL"
else
  echo "compose_file=docker-compose.yml:docker-compose.server.yml"
  if [ "$HAS_NVIDIA" -eq 1 ]; then
    echo "default_profiles=core,ollama,rag,voice-server"
    echo "default_stt_model=large-v3"
  else
    echo "default_profiles=core,ollama,rag,voice-server"
    echo "default_stt_model=small"
  fi
  echo "default_llm_model=hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL"
fi
