#!/usr/bin/env bash
# Build llama.cpp with HIP for gfx1201 (Radeon AI PRO R9700 / RDNA4).
#
#   ./scripts/build-llama-cpp-hip.sh
#   LLAMA_CPP_DIR=/opt/llama.cpp ./scripts/build-llama-cpp-hip.sh
#
# Requires ROCm (hipcc, hipblas, rocblas) and a llama.cpp tree at
# $LLAMA_CPP_DIR (default: ~/src/llama.cpp). Clones it if missing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/llama-cpp-env.sh
source "$ROOT/scripts/lib/llama-cpp-env.sh"

need() { command -v "$1" >/dev/null 2>&1 || { echo "need $1" >&2; exit 1; }; }
need git
need cmake
need ninja
need hipconfig

if [ ! -d "${LLAMA_CPP_DIR}/.git" ]; then
  echo "Cloning llama.cpp → ${LLAMA_CPP_DIR}"
  mkdir -p "$(dirname "${LLAMA_CPP_DIR}")"
  git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "${LLAMA_CPP_DIR}"
fi

cd "${LLAMA_CPP_DIR}"
echo "llama.cpp $(git describe --tags --always)  arch=${LLAMA_GPU_ARCH}"

export ROCM_PATH="${ROCM_PATH:-$(hipconfig -R)}"
export HIP_PATH="${HIP_PATH:-$ROCM_PATH}"
export HIPCXX="${HIPCXX:-$(hipconfig -l)/clang}"
if [ ! -x "$HIPCXX" ]; then
  echo "HIPCXX not executable: $HIPCXX" >&2
  exit 1
fi
export PATH="${ROCM_PATH}/bin:${PATH}"
export LD_LIBRARY_PATH="${ROCM_PATH}/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# HIP compile enumerates GPUs. Unpinned, that wakes the idle compute card
# and DRM-hotplugs Hyprland. Pin before cmake --build.
pin_rocm_compute_gpu || exit 1

# Official HIP recipe + graphs. GPU_TARGETS is forwarded to CMAKE_HIP_ARCHITECTURES.
HIPCXX="$HIPCXX" HIP_PATH="$HIP_PATH" cmake -S . -B "${LLAMA_CPP_BUILD_DIR}" -G Ninja \
  -DGGML_HIP=ON \
  -DGPU_TARGETS="${LLAMA_GPU_ARCH}" \
  -DCMAKE_HIP_ARCHITECTURES="${LLAMA_GPU_ARCH}" \
  -DGGML_HIP_GRAPHS=ON \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="${ROCM_PATH}"

# HIP clang (ROCm 7.2 / LLVM 22) segfaults compiling fattn-tile instances
# under high -j. Serial-ish + retry recovers; override with LLAMA_CPP_JOBS.
JOBS="${LLAMA_CPP_JOBS:-2}"
attempt=0
until cmake --build "${LLAMA_CPP_BUILD_DIR}" --config Release -j"$JOBS"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 12 ]; then
    echo "HIP build failed after $attempt attempts" >&2
    exit 1
  fi
  echo "HIP clang ICE — retry $attempt (ninja continues remaining targets)"
  sleep 1
done

BIN="$(llama_server_bin)" || { echo "llama-server missing after build" >&2; exit 1; }
echo "OK $BIN"
"$BIN" --version || true
echo
echo "Next:"
echo "  ./scripts/download-gemma4-qat-gguf.sh"
echo "  ./scripts/install-llama-server.sh"
