#!/usr/bin/env bash
# host-setup/install-npu.sh
#
# Prepares an Orange Pi 5 Max (RK3588) host for Moneypenny's NPU LLM stack:
#   1. sanity-checks the board + RKNPU kernel driver (DESIGN §3, §14)
#   2. installs the pinned librkllmrt userspace runtime (1.2.3)
#   3. sets the NPU devfreq governor to performance
#   4. installs a udev rule so the device node is accessible
#   5. runs check-npu.sh to confirm the result
#
# Coupling matters (DESIGN §14): RKNPU driver 0.9.8 <-> librkllmrt 1.2.x. The
# kernel driver ships with the vendor BSP kernel (Armbian / Ubuntu-Rockchip), so
# this script does NOT compile or insmod kernel modules — if the driver is
# missing it tells you to flash a matching kernel and stops.
#
# Idempotent. Re-run safely. Usage:
#   sudo ./host-setup/install-npu.sh [--force] [--dry-run] [--skip-governor] [-h]
#
# Override the runtime download if the upstream layout differs:
#   sudo RKLLM_RUNTIME_URL=https://.../librkllmrt.so ./host-setup/install-npu.sh

set -euo pipefail

# ── Pins (DESIGN §14) ────────────────────────────────────────────────────────
RKLLM_VERSION="${RKLLM_VERSION:-1.2.3}"
RKNPU_DRIVER_TARGET="${RKNPU_DRIVER_TARGET:-0.9.8}"
# Upstream runtime .so. Overridable; defaults to the airockchip/rknn-llm release.
RKLLM_REPO_REF="${RKLLM_REPO_REF:-release-v${RKLLM_VERSION}}"
RKLLM_RUNTIME_PATH="${RKLLM_RUNTIME_PATH:-rkllm-runtime/Linux/librkllm_api/aarch64/librkllmrt.so}"
RKLLM_RUNTIME_URL="${RKLLM_RUNTIME_URL:-https://github.com/airockchip/rknn-llm/raw/${RKLLM_REPO_REF}/${RKLLM_RUNTIME_PATH}}"

LIB_DEST="/usr/lib/librkllmrt.so"
VERSION_MARKER="/usr/lib/.moneypenny-rkllm-version"
UDEV_RULE="/etc/udev/rules.d/99-rknpu.rules"
RKNPU_DEV_MODE="${RKNPU_DEV_MODE:-0660}"
RKNPU_DEV_GROUP="${RKNPU_DEV_GROUP:-render}"

FORCE=0
DRY_RUN=0
SKIP_GOVERNOR=0

# ── Pretty logging ───────────────────────────────────────────────────────────
c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log()  { echo "${c_dim}[*]${c_off} $*"; }
ok()   { echo "${c_ok}[OK]${c_off} $*"; }
warn() { echo "${c_warn}[WARN]${c_off} $*" >&2; }
die()  { echo "${c_err}[FAIL]${c_off} $*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then echo "${c_dim}[dry-run]${c_off} $*"; else eval "$@"; fi; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-governor) SKIP_GOVERNOR=1 ;;
    -h|--help) usage ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
  shift
done

echo "=== Moneypenny NPU host setup (RKLLM ${RKLLM_VERSION} / RKNPU ${RKNPU_DRIVER_TARGET}) ==="

# ── 0. Preconditions ─────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  die "Run as root (sudo). Use --dry-run to preview without root."
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ]; then
  warn "Architecture is '$ARCH', expected aarch64. This board target is RK3588 (arm64)."
fi

if [ -r /proc/device-tree/compatible ] && tr -d '\0' < /proc/device-tree/compatible | grep -qi 'rk3588'; then
  ok "SoC reports RK3588"
else
  warn "Could not confirm RK3588 from device-tree. Continuing — set up may not apply to this board."
fi

# ── 1. Kernel NPU driver (assert only — ships with the BSP kernel) ───────────
if [ ! -e /dev/rknpu ] && [ ! -d /sys/kernel/debug/rknpu ]; then
  MSG="RKNPU driver not present (no /dev/rknpu, no /sys/kernel/debug/rknpu).
     The driver is part of the vendor kernel — it is NOT installable from here.
     Flash an RK3588 image with rknpu ${RKNPU_DRIVER_TARGET} (Armbian vendor
     6.1 kernel or Ubuntu-Rockchip), then re-run this script."
  # In --dry-run let the operator preview the whole script on a non-NPU box.
  if [ "$DRY_RUN" -eq 1 ]; then warn "$MSG"; else die "$MSG"; fi
else
  ok "RKNPU device present"
fi

if [ -f /sys/kernel/debug/rknpu/version ]; then
  DRIVER_VER="$(cat /sys/kernel/debug/rknpu/version 2>/dev/null || true)"
  log "Kernel driver reports: ${DRIVER_VER:-unknown}"
  if [ -n "$DRIVER_VER" ] && ! echo "$DRIVER_VER" | grep -q "$RKNPU_DRIVER_TARGET"; then
    warn "Driver is not ${RKNPU_DRIVER_TARGET}. RKNPU<->RKLLM versions are coupled (DESIGN §14);
       mismatches can crash inference. Proceed only if you know they're compatible."
  fi
else
  warn "Cannot read driver version (need root + debugfs mounted). Skipping version assert."
fi

# ── 2. librkllmrt userspace runtime ──────────────────────────────────────────
INSTALLED_VER="$(cat "$VERSION_MARKER" 2>/dev/null || echo "")"
if [ -f "$LIB_DEST" ] && [ "$INSTALLED_VER" = "$RKLLM_VERSION" ] && [ "$FORCE" -eq 0 ]; then
  ok "librkllmrt ${RKLLM_VERSION} already installed ($LIB_DEST). Use --force to reinstall."
else
  command -v curl >/dev/null 2>&1 || die "curl is required to download the runtime. apt install curl."
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  log "Downloading librkllmrt ${RKLLM_VERSION}:"
  log "  $RKLLM_RUNTIME_URL"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "${c_dim}[dry-run]${c_off} curl -fL -> $LIB_DEST (+ ldconfig)"
  else
    curl -fL --retry 3 -o "$TMP" "$RKLLM_RUNTIME_URL" \
      || die "Download failed. If the upstream path moved, set RKLLM_RUNTIME_URL to the
       correct librkllmrt.so for v${RKLLM_VERSION} and re-run."
    # Verify it's actually an aarch64 shared object before trusting it.
    if command -v file >/dev/null 2>&1; then
      if ! file -b "$TMP" | grep -Eqi 'ELF.*(aarch64|ARM aarch64|shared object)'; then
        die "Downloaded file is not an aarch64 ELF shared object (got: $(file -b "$TMP")).
       The URL likely returned an HTML error page. Check RKLLM_RUNTIME_URL."
      fi
    else
      warn "'file' not available — skipping ELF sanity check on the download."
    fi
    install -m 0644 "$TMP" "$LIB_DEST"
    echo "$RKLLM_VERSION" > "$VERSION_MARKER"
    ldconfig
    ok "Installed librkllmrt ${RKLLM_VERSION} -> $LIB_DEST"
  fi
fi

# ── 3. NPU performance governor (best-effort) ────────────────────────────────
if [ "$SKIP_GOVERNOR" -eq 1 ]; then
  log "Skipping NPU governor (--skip-governor)."
else
  NPU_GOV_SET=0
  for gov in /sys/class/devfreq/*.npu/governor /sys/class/devfreq/fdab0000.npu/governor; do
    [ -w "$gov" ] || continue
    if grep -qw performance "${gov%governor}available_governors" 2>/dev/null; then
      run "echo performance > '$gov'"
      ok "NPU governor set to performance ($gov)"
      NPU_GOV_SET=1
    fi
  done
  [ "$NPU_GOV_SET" -eq 1 ] || warn "No writable NPU devfreq governor found — leaving kernel default."
fi

# ── 4. Device-node access (udev rule) ────────────────────────────────────────
if getent group "$RKNPU_DEV_GROUP" >/dev/null 2>&1; then
  log "Installing udev rule: /dev/rknpu -> group=$RKNPU_DEV_GROUP mode=$RKNPU_DEV_MODE"
  RULE="KERNEL==\"rknpu\", MODE=\"$RKNPU_DEV_MODE\", GROUP=\"$RKNPU_DEV_GROUP\""
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "${c_dim}[dry-run]${c_off} write $UDEV_RULE: $RULE"
  elif [ -f "$UDEV_RULE" ] && [ "$(cat "$UDEV_RULE")" = "$RULE" ]; then
    ok "udev rule already current ($UDEV_RULE)"
  else
    echo "$RULE" > "$UDEV_RULE"
    udevadm control --reload-rules 2>/dev/null || warn "udevadm reload failed (non-fatal)."
    udevadm trigger --name-match=rknpu 2>/dev/null || true
    ok "udev rule written ($UDEV_RULE)"
  fi
  log "The rkllama container passes /dev/rknpu through; ensure its process can access"
  log "the node (compose 'group_add: [$RKNPU_DEV_GROUP]' or matching GID)."
else
  warn "Group '$RKNPU_DEV_GROUP' does not exist — skipping udev rule. Set RKNPU_DEV_GROUP to an existing group."
fi

# ── 5. Light host prerequisite check (next step is `docker compose up`) ──────
if command -v docker >/dev/null 2>&1; then
  ok "docker present ($(docker --version 2>/dev/null | head -1))"
  docker compose version >/dev/null 2>&1 || warn "Docker Compose v2 not found — install the compose plugin."
else
  warn "docker not found. Install Docker + Compose v2 before 'docker compose --profile core up'."
fi

# ── 6. Verify ────────────────────────────────────────────────────────────────
echo
CHECK="$(dirname "$0")/check-npu.sh"
if [ -x "$CHECK" ] && [ "$DRY_RUN" -eq 0 ]; then
  log "Running check-npu.sh ..."
  "$CHECK" || die "Post-install check failed — see output above."
else
  log "Skipping check-npu.sh (dry-run or not executable). Run it manually to verify."
fi

echo
ok "NPU host setup complete. Next: docker compose --profile core up -d"
