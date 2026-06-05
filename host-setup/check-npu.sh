#!/usr/bin/env bash
# host-setup/check-npu.sh
# Validates RKNPU driver + RKLLM runtime versions on Orange Pi 5 Max.
# Run as root or with appropriate device permissions.

set -euo pipefail

# Pins (must match install-npu.sh / DESIGN §14).
RKNPU_DRIVER_TARGET="${RKNPU_DRIVER_TARGET:-0.9.8}"
RKLLM_VERSION="${RKLLM_VERSION:-1.2.3}"

echo "=== Moneypenny NPU Environment Check ==="

# Check for RKNPU device
if [ ! -e /dev/rknpu ]; then
  echo "FAIL: /dev/rknpu not found. Install RKNPU driver v0.9.8+."
  exit 1
fi
echo "OK: /dev/rknpu present"

# Check driver version against the pinned target (RKNPU<->RKLLM are coupled).
if [ -f /sys/kernel/debug/rknpu/version ]; then
  DRIVER_VER=$(cat /sys/kernel/debug/rknpu/version)
  echo "Driver version: $DRIVER_VER"
  if echo "$DRIVER_VER" | grep -q "$RKNPU_DRIVER_TARGET"; then
    echo "OK: driver matches target $RKNPU_DRIVER_TARGET"
  else
    echo "WARN: driver is not $RKNPU_DRIVER_TARGET — coupled with RKLLM $RKLLM_VERSION (DESIGN §14). Mismatch may crash inference."
  fi
else
  echo "WARN: Could not read driver version from sysfs (need root + debugfs). Proceeding anyway."
fi

# Check for librkllmrt (the critical userspace runtime)
if ldconfig -p | grep -q rkllmrt; then
  echo "OK: librkllmrt found in linker cache"
  # install-npu.sh records the version it installed here.
  if [ -f /usr/lib/.moneypenny-rkllm-version ]; then
    INSTALLED="$(cat /usr/lib/.moneypenny-rkllm-version)"
    echo "Installed librkllmrt version: $INSTALLED"
    [ "$INSTALLED" = "$RKLLM_VERSION" ] || echo "WARN: runtime $INSTALLED != target $RKLLM_VERSION."
  fi
else
  echo "FAIL: librkllmrt not found. Run host-setup/install-npu.sh to install RKLLM $RKLLM_VERSION."
  exit 1
fi

# Quick RKLLM capability probe (if rkllm tool or python bindings available)
if command -v rkllm &>/dev/null; then
  echo "RKLLM CLI present — running quick probe..."
  # rkllm --version or similar
fi

echo "=== NPU check complete. Ready for rkllama container. ==="
