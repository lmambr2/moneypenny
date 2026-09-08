#!/usr/bin/env bash
# Detect GPU class for Server STT/LLM/Talker packaging.
# Prints key=value lines (same style as detect-edition.sh).
#
# Discrete AMD/NVIDIA/Intel only count as Penny. Raphael / Granite Ridge /
# Phoenix iGPUs are never Penny and never recommend_duplex.
# Official PersonaPlex is NVIDIA CUDA. This host's product Talker is
# moshi.cpp Vulkan — recommend_duplex stays no until duplex-rtf.sh measures
# PersonaPlex q4_k on the discrete card (docs/personaplex-full-harness.md).
set -euo pipefail

HAS_NVIDIA=0
HAS_AMD=0
HAS_ROCM=0
HAS_VULKAN=0
HAS_INTEL_DISCRETE=0
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

# iGPU / APU product names — never Penny, never Talker.
is_igpu_name() {
  local n="${1:-}"
  echo "$n" | grep -qiE \
    'Raphael|Granite Ridge|Phoenix|Rembrandt|Strix|Hawk Point|9800X3D|9700X|Ryzen[[:space:]]+[0-9]|Radeon Graphics\]'
}

render_for_pci() {
  local want="${1:-}"
  local card slot render
  want="$(echo "$want" | tr 'A-F' 'a-f')"
  for card in /sys/class/drm/card[0-9]*; do
    [ -r "$card/device/uevent" ] || continue
    slot="$(awk -F= '/PCI_SLOT_NAME=/{print tolower($2)}' "$card/device/uevent" 2>/dev/null || true)"
    [ "$slot" = "$want" ] || continue
    render="$(ls -1 "$card/device/drm" 2>/dev/null | grep -E '^renderD' | head -1 || true)"
    if [ -n "$render" ]; then
      echo "/dev/dri/$render"
      return 0
    fi
  done
  return 1
}

DISCRETE_COUNT=0
IGPU_COUNT=0
PENNY_INDEX=""
PENNY_RENDER=""
PENNY_NAME=""
PENNY_VRAM_MB=0
IGPU=0

if [ "$HAS_ROCM" -eq 1 ]; then
  BUS_TXT="$(rocm-smi --showbus 2>/dev/null || true)"
  NAME_TXT="$(rocm-smi --showproductname 2>/dev/null || true)"
  VRAM_TXT="$(rocm-smi --showmeminfo vram 2>/dev/null || true)"
  IDX=0
  while true; do
    # rocm-smi prints "GPU[0]\\t\\t: PCI Bus: 0000:03:00.0" — tabs, not "GPU[0]: ".
    bus="$(echo "$BUS_TXT" | awk -v i="$IDX" '
      $0 ~ ("GPU\\[" i "\\][[:space:]]*: PCI Bus:") {
        sub(/^.*PCI Bus:[[:space:]]*/, ""); print; exit
      }
    ')"
    [ -n "$bus" ] || break
    name="$(echo "$NAME_TXT" | awk -v i="$IDX" '
      $0 ~ ("GPU\\[" i "\\][[:space:]]*: Card Series:") {
        sub(/^.*Card Series:[[:space:]]*/, ""); print; exit
      }
    ')"
    vram_b="$(echo "$VRAM_TXT" | awk -v i="$IDX" '
      $0 ~ ("GPU\\[" i "\\].*VRAM Total Memory") {
        if (match($0, /[0-9]{9,}/)) print substr($0, RSTART, RLENGTH)
        exit
      }
    ')"
    vram_mb=0
    if [[ "$vram_b" =~ ^[0-9]+$ ]]; then
      vram_mb=$((vram_b / 1024 / 1024))
    fi
    if is_igpu_name "$name"; then
      IGPU_COUNT=$((IGPU_COUNT + 1))
      IGPU=1
    else
      DISCRETE_COUNT=$((DISCRETE_COUNT + 1))
      if [ "$vram_mb" -ge "$PENNY_VRAM_MB" ]; then
        PENNY_INDEX="$IDX"
        PENNY_NAME="$name"
        PENNY_VRAM_MB="$vram_mb"
        PENNY_RENDER="$(render_for_pci "$bus" || true)"
      fi
    fi
    IDX=$((IDX + 1))
  done
fi

if [ "$HAS_NVIDIA" -eq 1 ] && [ "$DISCRETE_COUNT" -eq 0 ]; then
  ncount="$(nvidia-smi -L 2>/dev/null | grep -c '^GPU ' || true)"
  DISCRETE_COUNT="${ncount:-0}"
  if [ "$DISCRETE_COUNT" -ge 1 ]; then
    PENNY_INDEX=0
    PENNY_NAME="$(nvidia-smi -L 2>/dev/null | head -1 | sed 's/ (UUID.*//' || true)"
    PENNY_VRAM_MB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ' || echo 0)"
  fi
fi

if lspci 2>/dev/null | grep -qiE 'VGA.*Arc|3D.*Arc|VGA.*Battlemage|VGA.*Alchemist'; then
  HAS_INTEL_DISCRETE=1
  if [ "$DISCRETE_COUNT" -eq 0 ]; then
    DISCRETE_COUNT=1
  fi
fi

GPU="none"
if [ "$HAS_AMD" -eq 1 ] && [ "$DISCRETE_COUNT" -ge 1 ]; then GPU="amd"
elif [ "$HAS_NVIDIA" -eq 1 ]; then GPU="nvidia"
elif [ "$HAS_INTEL_DISCRETE" -eq 1 ]; then GPU="intel"
elif [ "$HAS_AMD" -eq 1 ]; then GPU="amd-igpu"
fi

# Duplex: official CUDA only. AMD Talker is moshi.cpp Vulkan, RTF-gated.
RECOMMEND_DUPLEX="no"
RECOMMEND_DUPLEX_REASON="no-discrete-gpu"
RECOMMEND_SPEECH="cascaded"
if [ "$HAS_NVIDIA" -eq 1 ] && [ "$DISCRETE_COUNT" -ge 1 ]; then
  RECOMMEND_DUPLEX="yes"
  RECOMMEND_DUPLEX_REASON="nvidia-official-moshi"
  RECOMMEND_SPEECH="moshi-cuda"
elif [ "$GPU" = "amd" ]; then
  RECOMMEND_DUPLEX="no"
  RECOMMEND_DUPLEX_REASON="unmeasured-moshicpp-rtf"
  RECOMMEND_SPEECH="moshicpp-vulkan"
elif [ "$GPU" = "intel" ]; then
  RECOMMEND_DUPLEX="no"
  RECOMMEND_DUPLEX_REASON="unmeasured-moshicpp-intel"
  RECOMMEND_SPEECH="moshicpp-vulkan"
fi
if [ "$GPU" = "amd-igpu" ]; then
  RECOMMEND_DUPLEX="no"
  RECOMMEND_DUPLEX_REASON="igpu-refused"
  RECOMMEND_SPEECH="cascaded"
fi

echo "gpu=$GPU"
echo "amd=$HAS_AMD"
echo "rocm=$HAS_ROCM"
echo "nvidia=$HAS_NVIDIA"
echo "intel_discrete=$HAS_INTEL_DISCRETE"
echo "igpu=$IGPU"
echo "vulkan=$HAS_VULKAN"
echo "gpu_count=$DISCRETE_COUNT"
echo "igpu_count=$IGPU_COUNT"
echo "penny_index=${PENNY_INDEX}"
echo "penny_render_node=${PENNY_RENDER}"
echo "penny_name=${PENNY_NAME}"
echo "vram_mb=${PENNY_VRAM_MB}"
echo "render_gid=${RENDER_GID:-}"
echo "video_gid=${VIDEO_GID:-}"
echo "recommend_duplex=$RECOMMEND_DUPLEX"
echo "recommend_duplex_reason=$RECOMMEND_DUPLEX_REASON"
echo "recommend_speech=$RECOMMEND_SPEECH"

if [ "$GPU" = "amd" ]; then
  echo "recommend_llm=host-ollama"
  echo "recommend_stt=whisper-cpp-vulkan"
  echo "docs=docs/gpu-amd.md"
elif [ "$GPU" = "nvidia" ]; then
  echo "recommend_llm=ollama-docker-or-host"
  echo "recommend_stt=whisper-cpp-cuda"
  echo "docs=docs/gpu-amd.md"
elif [ "$GPU" = "intel" ]; then
  echo "recommend_llm=ollama-cpu"
  echo "recommend_stt=whisper-cpp-cpu"
  echo "docs=docs/personaplex-full-harness.md"
else
  echo "recommend_llm=ollama-cpu"
  echo "recommend_stt=whisper-cpp-cpu"
  echo "docs=docs/editions.md"
fi
