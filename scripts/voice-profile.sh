#!/usr/bin/env bash
# Recommend compose voice profile + Whisper STT_MODEL for this host/edition.
# Usage: ./scripts/voice-profile.sh
# See: docs/editions.md  docs/voice-backends.md  docs/gpu-amd.md
set -euo pipefail

ARCH="$(uname -m)"
HAS_NVIDIA=0
HAS_AMD=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  HAS_NVIDIA=1
fi
if command -v lspci >/dev/null 2>&1 && lspci 2>/dev/null | grep -qiE 'VGA.*(AMD|ATI)|Display.*AMD'; then
  HAS_AMD=1
fi

EDITION="server"
if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
  EDITION="sbc"
fi
if [ -x "$(dirname "$0")/detect-edition.sh" ]; then
  EDITION="$("$(dirname "$0")/detect-edition.sh" | awk -F= '/^edition=/{print $2; exit}')"
fi

echo "edition=$EDITION arch=$ARCH nvidia=$HAS_NVIDIA amd=$HAS_AMD"
echo "# STT: Whisper dual-track. TTS: Piper. (sherpa/Kokoro removed — V2)"
echo

if [[ "$EDITION" == "sbc" ]]; then
  cat <<EOF
# SBC — RKNN NPU Whisper base (product default)
COMPOSE_FILE=docker-compose.yml:docker-compose.sbc.yml
COMPOSE_PROFILES=core,ollama,rag,voice-edge
STT_MODEL=base
STT_DEVICE=npu
STT_BACKEND=rknn
STT_FALLBACK=faster-whisper
RKNN_MODELS_DIR=/models/rknn
# Export: MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh
# Bot: sttUrl=http://stt-whisper:9000 ttsUrl=http://piper-tts:8880 textWakeFallback=true
EOF
elif [[ "$HAS_AMD" -eq 1 ]]; then
  cat <<EOF
# Server + AMD — whisper.cpp Vulkan
COMPOSE_FILE=docker-compose.yml:docker-compose.server.yml
COMPOSE_PROFILES=core,ollama,rag,voice-server
STT_MODEL=large-v3-turbo
STT_DEVICE=vulkan
STT_BACKEND=whisper-cpp
WHISPER_VULKAN=1
RENDER_GID=\$(getent group render | cut -d: -f3)
VIDEO_GID=\$(getent group video | cut -d: -f3)
# Dual R9700 later: PENNY_GPU_INDEX=1 PENNY_RENDER_NODE=/dev/dri/renderD129
# Download: ./scripts/download-whisper-ggml.sh --dir ./models/whisper-cpp large-v3-turbo
EOF
elif [[ "$HAS_NVIDIA" -eq 1 ]]; then
  cat <<EOF
# Server + NVIDIA (untested) — whisper.cpp or faster-whisper
COMPOSE_FILE=docker-compose.yml:docker-compose.server.yml
COMPOSE_PROFILES=core,ollama,rag,voice-server
STT_MODEL=medium
STT_DEVICE=cuda
STT_BACKEND=whisper-cpp
EOF
else
  cat <<EOF
# Server CPU
COMPOSE_FILE=docker-compose.yml:docker-compose.server.yml
COMPOSE_PROFILES=core,ollama,rag,voice-server
STT_MODEL=medium
STT_DEVICE=cpu
STT_BACKEND=whisper-cpp
EOF
fi

echo
echo "# Docs: docs/voice-backends.md  docs/editions.md  docs/gpu-amd.md"
