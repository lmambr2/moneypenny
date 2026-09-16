#!/usr/bin/env bash
# Shared paths for the host llama.cpp HIP stack (docs/gpu-amd.md).
# Source from other scripts; do not execute directly.

_llama_cpp_this="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONEYPENNY_ROOT="$(cd "$_llama_cpp_this/../.." && pwd)"

: "${LLAMA_CPP_DIR:=${HOME}/src/llama.cpp}"
: "${LLAMA_CPP_BUILD_DIR:=${LLAMA_CPP_DIR}/build}"
: "${MONEYPENNY_GGUF_DIR:=${MONEYPENNY_ROOT}/models/gguf}"

: "${GEMMA4_QAT_REPO:=unsloth/gemma-4-12B-it-qat-GGUF}"
: "${GEMMA4_QAT_FILE:=gemma-4-12B-it-qat-UD-Q4_K_XL.gguf}"
: "${GEMMA4_MTP_FILE:=mtp-gemma-4-12B-it-Q8_0.gguf}"
: "${GEMMA4_MTP_REPO_PATH:=MTP/mtp-gemma-4-12B-it-Q8_0.gguf}"

: "${LLAMA_SERVER_HOST:=127.0.0.1}"
: "${LLAMA_SERVER_PORT:=11434}"
: "${LLAMA_SERVER_ALIAS:=gemma4:12b}"
: "${LLAMA_GPU_ARCH:=gfx1201}"

# Dual R9700. DRM cardN swaps; PCI + by-path do not.
# Display (Hyprland, DP-4 Dell AW3425DW): PCI 0000:03:00.0 → renderD128
# Compute (no monitor):                  PCI 0000:07:00.0 → renderD129
# HIP/ROCR index follows PCI BDF order of 1002:7551 VGA, NOT cardN:
#   HIP 0 = 03:00.0 = renderD128 = DISPLAY  — never
#   HIP 1 = 07:00.0 = renderD129 = COMPUTE
# 2026-09-13 14:50: unpinned HIP compile woke 07:00.0; Hyprland was subscribed
# to both DRM cards and SIGABRT'd in CRenderPass::clear. Do not run rocminfo /
# llama-server / llama-bench without this pin.
: "${MONEYPENNY_COMPUTE_PCI:=0000:07:00.0}"
: "${MONEYPENNY_DISPLAY_PCI:=0000:03:00.0}"

pin_rocm_compute_gpu() {
  local compute_render display_render bdf idx=0 found=""
  compute_render="$(readlink -f "/dev/dri/by-path/pci-${MONEYPENNY_COMPUTE_PCI}-render" 2>/dev/null || true)"
  display_render="$(readlink -f "/dev/dri/by-path/pci-${MONEYPENNY_DISPLAY_PCI}-render" 2>/dev/null || true)"
  if [ -z "$compute_render" ] || [ ! -e "$compute_render" ]; then
    echo "pin_rocm_compute_gpu: missing by-path for ${MONEYPENNY_COMPUTE_PCI}" >&2
    return 1
  fi
  if [ "$compute_render" = "/dev/dri/renderD128" ] || [ "$compute_render" = "$display_render" ]; then
    echo "pin_rocm_compute_gpu: refusing ${MONEYPENNY_COMPUTE_PCI} → ${compute_render} (display GPU / renderD128)" >&2
    return 1
  fi
  while IFS= read -r bdf; do
    [ -n "$bdf" ] || continue
    if [ "$bdf" = "$MONEYPENNY_COMPUTE_PCI" ]; then
      found="$idx"
      break
    fi
    idx=$((idx + 1))
  done < <(
    for d in /sys/bus/pci/devices/*; do
      [ -f "$d/class" ] && [ -f "$d/vendor" ] && [ -f "$d/device" ] || continue
      [ "$(cat "$d/class")" = "0x030000" ] || continue
      [ "$(cat "$d/vendor")" = "0x1002" ] || continue
      [ "$(cat "$d/device")" = "0x7551" ] || continue
      basename "$d"
    done | sort
  )
  if [ -z "$found" ]; then
    echo "pin_rocm_compute_gpu: ${MONEYPENNY_COMPUTE_PCI} not in 1002:7551 VGA list" >&2
    return 1
  fi
  export HIP_VISIBLE_DEVICES="$found"
  export ROCR_VISIBLE_DEVICES="$found"
  export MONEYPENNY_COMPUTE_RENDER="$compute_render"
  export MONEYPENNY_DISPLAY_RENDER="${display_render:-}"
}

# Resolve now so sourced scripts inherit a safe pin (overrides a stale 0).
pin_rocm_compute_gpu

llama_server_bin() {
  if [ -x "${LLAMA_CPP_BUILD_DIR}/bin/llama-server" ]; then
    printf '%s\n' "${LLAMA_CPP_BUILD_DIR}/bin/llama-server"
    return 0
  fi
  if command -v llama-server >/dev/null 2>&1; then
    command -v llama-server
    return 0
  fi
  return 1
}

llama_bench_bin() {
  if [ -x "${LLAMA_CPP_BUILD_DIR}/bin/llama-bench" ]; then
    printf '%s\n' "${LLAMA_CPP_BUILD_DIR}/bin/llama-bench"
    return 0
  fi
  command -v llama-bench 2>/dev/null || return 1
}

gemma4_target_gguf() {
  printf '%s/%s\n' "${MONEYPENNY_GGUF_DIR}" "${GEMMA4_QAT_FILE}"
}

gemma4_draft_gguf() {
  printf '%s/%s\n' "${MONEYPENNY_GGUF_DIR}" "${GEMMA4_MTP_FILE}"
}
