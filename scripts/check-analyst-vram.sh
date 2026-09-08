#!/usr/bin/env bash
# Advise whether to enable the heavy 31B analyst model on this host.
# Heuristic only — Ollama/ROCm reporting varies.
#
#   ./scripts/check-analyst-vram.sh
#   ./scripts/check-analyst-vram.sh --json
set -euo pipefail

JSON=0
[ "${1:-}" = "--json" ] && JSON=1

MB=0
SOURCE="unknown"

if command -v rocm-smi >/dev/null 2>&1; then
  # Penny = largest non-iGPU card (Raphael / Granite Ridge / Ryzen APU skipped).
  # Dual-R9700 later: PENNY_GPU_INDEX. One discrete card: that card, even if it is GPU[0].
  NAME_TXT="$(rocm-smi --showproductname 2>/dev/null || true)"
  VRAM_TXT="$(rocm-smi --showmeminfo vram 2>/dev/null || true)"
  BEST_MB=0
  BEST_SRC=""
  IDX=0
  while true; do
    name="$(echo "$NAME_TXT" | awk -v i="$IDX" '
      $0 ~ ("GPU\\[" i "\\][[:space:]]*: Card Series:") {
        sub(/^.*Card Series:[[:space:]]*/, ""); print; exit
      }
    ')"
    [ -n "$name" ] || break
    line="$(echo "$VRAM_TXT" | awk -v i="$IDX" '
      $0 ~ ("GPU\\[" i "\\][[:space:]]*: VRAM Total Memory \\(B\\):") { print; exit }
    ')"
    bytes=0
    if [[ "$line" =~ ([0-9]{9,}) ]]; then
      bytes="${BASH_REMATCH[1]}"
    fi
    mb=$((bytes / 1024 / 1024))
    igpu=0
    echo "$name" | grep -qiE 'Raphael|Granite Ridge|Phoenix|Rembrandt|Strix|Hawk Point|9800X3D|Ryzen[[:space:]]+[0-9]' && igpu=1
    if [ -n "${PENNY_GPU_INDEX:-}" ] && [ "$IDX" = "$PENNY_GPU_INDEX" ]; then
      BEST_MB="$mb"
      BEST_SRC="rocm-smi-penny-$IDX"
      break
    fi
    if [ "$igpu" -eq 0 ] && [ "$mb" -ge "$BEST_MB" ]; then
      BEST_MB="$mb"
      BEST_SRC="rocm-smi-discrete-$IDX"
    fi
    IDX=$((IDX + 1))
  done
  if [ "$BEST_MB" -gt 0 ]; then
    MB="$BEST_MB"
    SOURCE="$BEST_SRC"
  fi
fi

if [ "$MB" -eq 0 ] && command -v nvidia-smi >/dev/null 2>&1; then
  MB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ' || echo 0)"
  SOURCE="nvidia-smi"
fi

if [ "$MB" -eq 0 ] && [ -r /sys/class/drm/card0/device/mem_info_vram_total ]; then
  bytes="$(cat /sys/class/drm/card0/device/mem_info_vram_total)"
  MB=$((bytes / 1024 / 1024))
  SOURCE="sysfs"
fi

GB=$((MB / 1024))
# Q4 ballpark: 12B ~8GB, 31B ~18–21GB @ 32k ctx. 32GB VRAM is NOT enough
# for both resident plus Whisper — amdgpu HMM pins ~18–23GB host RAM and OOMs.
RECOMMEND="12b-only"
if [ "$MB" -ge 48000 ]; then
  RECOMMEND="both-resident-ok"
elif [ "$MB" -ge 20000 ]; then
  RECOMMEND="31b-with-swap"
elif [ "$MB" -ge 10000 ]; then
  RECOMMEND="12b-only"
else
  RECOMMEND="check-host"
fi

if [ "$JSON" -eq 1 ]; then
  printf '{"vram_mb":%s,"vram_gb_approx":%s,"source":"%s","recommend":"%s"}\n' \
    "$MB" "$GB" "$SOURCE" "$RECOMMEND"
  exit 0
fi

echo "vram_mb=$MB"
echo "vram_gb_approx=$GB"
echo "source=$SOURCE"
echo "recommend=$RECOMMEND"
echo
case "$RECOMMEND" in
  both-resident-ok)
    echo "OK to enable Settings → heavy analyst 31B with both models resident if desired."
    echo "Still prefer OLLAMA_MAX_LOADED_MODELS=2 only when stable under load."
    ;;
  31b-with-swap)
    echo "Enable 31B only with swap: OLLAMA_MAX_LOADED_MODELS=1 (12B unloads during !analyst)."
    echo "Do not expect concurrent 12B+31B."
    ;;
  12b-only)
    echo "Keep 31B toggle OFF. Chat 12B only."
    ;;
  *)
    echo "Could not read VRAM. Leave 31B OFF unless you know the card (e.g. 32GB)."
    ;;
esac
echo "Docs: docs/remote-llm.md · docs/gpu-amd.md"
