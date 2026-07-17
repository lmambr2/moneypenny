#!/usr/bin/env bash
# Build @moneypenny/audio-native for the host triple (and optional cross targets).
#
# Usage:
#   ./scripts/build-audio-native.sh              # host only
#   ./scripts/build-audio-native.sh --with-arm64  # also aarch64 (needs toolchain)
#
# Requires: rustc, cargo, pkg-config, libopus-dev, Node 20+
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/bot/packages/audio-native"
WITH_ARM64=0

for arg in "$@"; do
  case "$arg" in
    --with-arm64) WITH_ARM64=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo/rustc required" >&2
  exit 1
fi
if ! pkg-config --exists opus 2>/dev/null; then
  echo "error: libopus (pkg-config opus) required — apt install libopus-dev" >&2
  exit 1
fi

cd "$PKG"
if [[ ! -d node_modules/@napi-rs ]]; then
  (cd "$ROOT/bot" && npm install -w @moneypenny/audio-native)
fi

echo "==> host native build"
npm run build

if [[ "$WITH_ARM64" -eq 1 ]]; then
  echo "==> aarch64-unknown-linux-gnu (cross)"
  if ! rustup target list --installed 2>/dev/null | grep -q aarch64-unknown-linux-gnu; then
    rustup target add aarch64-unknown-linux-gnu || {
      echo "warn: cannot add aarch64 target — skip cross" >&2
      exit 0
    }
  fi
  # napi-rs uses cargo --target; linker must exist (gcc-aarch64-linux-gnu or zig).
  if command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then
    export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
    npx napi build --platform --release --target aarch64-unknown-linux-gnu
  else
    echo "warn: aarch64-linux-gnu-gcc not found — build arm64 on device or in arm64 Docker" >&2
    echo "  docker run --rm -v \"$ROOT\":/src -w /src/bot/packages/audio-native \\" >&2
    echo "    rust:1-bookworm bash -lc 'apt-get update && apt-get install -y nodejs npm pkg-config libopus-dev && npm i && npx napi build --platform --release'" >&2
  fi
fi

echo "==> artifacts"
ls -la "$PKG"/*.node 2>/dev/null || true
node --test "$PKG/test.cjs" || true
echo "done."
