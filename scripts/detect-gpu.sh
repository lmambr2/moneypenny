#!/usr/bin/env bash
# Detect GPU class for Server STT/LLM packaging.
# Prints key=value lines (same style as detect-edition.sh).
set -euo pipefail

HAS_NVIDIA=0
HAS_AMD=0
HAS_ROCM=0
HAS_VULKAN=0
RENDER_GID=""
VIDEO_GID=""

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  HAS_NVIDIA=1
fi
if command -v rocm-smi >/dev/null 2>&1; then
  HAS_AMD=1
  HAS_ROCM=1
fi
if [ -e /dev/kfd ] || [ -d /sys/module/amdgpu ]; then
  HAS_AMD=1
fi
if command -v vulkaninfo >/dev/null 2>&1; then
  if vulkaninfo --summary 2>/dev/null | grep -qiE 'AMD|Radeon|NVIDIA|Intel'; then
    HAS_VULKAN=1
  fi
elif [ -d /usr/share/vulkan/icd.d ] || [ -d /etc/vulkan/icd.d ]; then
  HAS_VULKAN=1
fi

if getent group render >/dev/null 2>&1; then
  RENDER_GID="$(getent group render | cut -d: -f3)"
fi
if getent group video >/dev/null 2>&1; then
  VIDEO_GID="$(getent group video | cut -d: -f3)"
fi

GPU="none"
if [ "$HAS_AMD" -eq 1 ]; then GPU="amd"
elif [ "$HAS_NVIDIA" -eq 1 ]; then GPU="nvidia"
fi

echo "gpu=$GPU"
echo "amd=$HAS_AMD"
echo "rocm=$HAS_ROCM"
echo "nvidia=$HAS_NVIDIA"
echo "vulkan=$HAS_VULKAN"
echo "render_gid=${RENDER_GID:-}"
echo "video_gid=${VIDEO_GID:-}"

if [ "$GPU" = "amd" ]; then
  echo "recommend_llm=host-ollama"
  echo "recommend_stt=whisper-cpp-vulkan"
  echo "docs=docs/gpu-amd.md"
elif [ "$GPU" = "nvidia" ]; then
  echo "recommend_llm=ollama-docker-or-host"
  echo "recommend_stt=whisper-cpp"
  echo "docs=docs/gpu-amd.md"
else
  echo "recommend_llm=ollama-cpu"
  echo "recommend_stt=whisper-cpp-cpu"
fi
