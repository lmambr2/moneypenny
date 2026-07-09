#!/usr/bin/env bash
# Recommend compose voice profile + Whisper STT_MODEL for this host/edition.
# Usage: ./scripts/voice-profile.sh
# See also: ./scripts/detect-edition.sh  docs/editions.md  docs/voice-backends.md
set -euo pipefail

ARCH="$(uname -m)"
HAS_NVIDIA=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  HAS_NVIDIA=1
fi

EDITION="server"
if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
  EDITION="sbc"
fi
if [ -x "$(dirname "$0")/detect-edition.sh" ]; then
  EDITION="$("$(dirname "$0")/detect-edition.sh" | awk -F= '/^edition=/{print $2; exit}')"
fi

echo "edition=$EDITION arch=$ARCH nvidia=$HAS_NVIDIA"
echo "# STT family: Whisper (stt-whisper). TTS: Piper British southern female."
echo

if [[ "$EDITION" == "sbc" ]]; then
  cat <<EOF
# SBC edition — Whisper tiny on CPU (NPU RKNN backend later)
COMPOSE_FILE=docker-compose.yml:docker-compose.sbc.yml
COMPOSE_PROFILES=core,ollama,rag,voice-edge
STT_MODEL=tiny
STT_DEVICE=cpu
STT_BACKEND=faster-whisper
# Bot Settings:
#   voice.sttUrl = "http://stt-whisper:9000"
#   voice.ttsUrl = "http://piper-tts:8880"
#   voice.ttsVoice = "en_GB-southern_english_female-low"
#   voice.textWakeFallback = true
#   voice.requireWatchword = true
#
# When RKNN Whisper lands: STT_BACKEND=rknn (same service URL).
EOF
elif [[ "$HAS_NVIDIA" -eq 1 ]]; then
  cat <<EOF
# Server edition + NVIDIA — full Whisper ladder
COMPOSE_FILE=docker-compose.yml:docker-compose.server.yml
COMPOSE_PROFILES=core,ollama,rag,voice-server
STT_MODEL=large-v3
STT_DEVICE=cuda
STT_BACKEND=faster-whisper
# Bot Settings: same URLs as edge; textWakeFallback=true
# Enable GPU deploy block under stt-whisper if needed.
EOF
else
  cat <<EOF
# Server edition CPU-only
COMPOSE_FILE=docker-compose.yml:docker-compose.server.yml
COMPOSE_PROFILES=core,ollama,rag,voice-server
STT_MODEL=small
STT_DEVICE=cpu
STT_BACKEND=faster-whisper
# For better titles: STT_MODEL=medium (slower). large-v3 wants a GPU.
# Bot Settings: stt-whisper + piper-tts + textWakeFallback=true
EOF
fi

echo
echo "# Legacy Moonshine+KWS+Kokoro (deprecated): profile \"voice\" only"
echo "# Docs: docs/voice-backends.md  docs/editions.md"
