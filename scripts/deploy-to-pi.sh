#!/usr/bin/env bash
#
# Safe Pi deploy — preflight, guarded rsync, rebuild, post-verify.
#
# Usage:
#   ./scripts/deploy-to-pi.sh                    # full sync (no --delete) + bot build + verify
#   ./scripts/deploy-to-pi.sh --check          # preflight only
#   ./scripts/deploy-to-pi.sh --verify         # post-deploy verify only
#   ./scripts/deploy-to-pi.sh --files bot/src/bot/voice/session.ts
#   ./scripts/deploy-to-pi.sh --services bot,sherpa-stt
#   ./scripts/deploy-to-pi.sh --full-test        # preflight runs test:all
#
# NEVER use --delete unless you mean to wipe Pi-only files. Requires
# DEPLOY_ALLOW_DELETE=1 or interactive confirmation.
#
# Environment:
#   DEPLOY_HOST     (default dietpi@opi5)
#   DEPLOY_PATH     (default /home/dietpi/moneypenny)
#   DEPLOY_SSH_OPTS (default -o ClearAllForwardings=yes)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/deploy-common.sh
source "$ROOT/scripts/lib/deploy-common.sh"

CHECK_ONLY=0
VERIFY_ONLY=0
NO_BUILD=0
NO_VERIFY=0
ALLOW_DELETE=0
FULL_TEST=0
SERVICES=(bot)
declare -a FILE_PATHS=()

RSYNC_EXCLUDES=(
  --exclude '.git'
  --exclude 'node_modules'
  --exclude 'bot/node_modules'
  --exclude 'bot/web/node_modules'
  --exclude 'bot/data'
  --exclude 'models/npu-llm/*.rkllm'
  --exclude 'models/**/*.rkllm'
  --exclude '.env'
)

usage() {
  cat <<EOF
Safe Moneypenny deploy to Orange Pi

  $0 [options]

Options:
  --check          Run deploy-preflight only
  --verify         Run verify-pi-deploy only (no rsync)
  --files PATH...  Sync explicit repo-relative paths (validated destinations)
  --services LIST  Comma-separated compose services to rebuild (default: bot)
  --no-build       Rsync only — skip docker compose build
  --no-verify      Skip post-deploy verification
  --full-test      Preflight with npm run test:all
  --delete         Pass rsync --delete (requires DEPLOY_ALLOW_DELETE=1 or confirm)
  -h, --help

Examples:
  $0
  $0 --files bot/src/bot/voice/session.ts services/sherpa-stt/server.py --services bot,sherpa-stt
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --verify) VERIFY_ONLY=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    --no-verify) NO_VERIFY=1; shift ;;
    --full-test) FULL_TEST=1; shift ;;
    --delete) ALLOW_DELETE=1; shift ;;
    --services)
      IFS=',' read -ra SERVICES <<< "$2"
      shift 2
      ;;
    --files)
      shift
      while [[ $# -gt 0 && "$1" != --* ]]; do
        FILE_PATHS+=("$1")
        shift
      done
      ;;
    -h|--help) usage; exit 0 ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      FILE_PATHS+=("$1")
      shift
      ;;
  esac
done

preflight_args=()
[ "$FULL_TEST" -eq 1 ] && preflight_args+=(--full)

run_preflight() {
  "$ROOT/scripts/deploy-preflight.sh" "${preflight_args[@]}"
}

run_verify() {
  "$ROOT/scripts/verify-pi-deploy.sh"
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  run_preflight
  exit 0
fi

if [ "$VERIFY_ONLY" -eq 1 ]; then
  run_verify
  exit 0
fi

echo "=== Moneypenny deploy to Pi ==="
echo "Source:  $ROOT"
echo "Target:  $DEPLOY_HOST:$DEPLOY_PATH"
echo

run_preflight

if [ "$ALLOW_DELETE" -eq 1 ] && [ "${DEPLOY_ALLOW_DELETE:-}" != "1" ]; then
  echo "WARNING: rsync --delete can remove Pi-only files and cause regressions." >&2
  read -r -p "Type 'delete' to confirm --delete: " confirm
  [ "$confirm" = "delete" ] || _deploy_die "aborted — drop --delete or set DEPLOY_ALLOW_DELETE=1"
fi

remote_ssh "mkdir -p '$DEPLOY_PATH'"

if [ "${#FILE_PATHS[@]}" -gt 0 ]; then
  echo "--- Partial rsync (${#FILE_PATHS[@]} paths) ---"
  for p in "${FILE_PATHS[@]}"; do
    rel="$(resolve_deploy_relpath "$ROOT" "$p")"
    remote_ssh "mkdir -p '$DEPLOY_PATH/$(dirname "$rel")'"
    remote_rsync "$ROOT/$rel" "$DEPLOY_HOST:$DEPLOY_PATH/$rel"
    _deploy_ok "synced $rel"
  done
else
  echo "--- Full rsync (no --delete) ---"
  if [ "$ALLOW_DELETE" -eq 1 ]; then
    _deploy_warn "full sync WITH --delete — Pi-only files under DEPLOY_PATH may be removed"
    remote_rsync --delete "${RSYNC_EXCLUDES[@]}" "$ROOT/" "$DEPLOY_HOST:$DEPLOY_PATH/"
  else
    remote_rsync "${RSYNC_EXCLUDES[@]}" "$ROOT/" "$DEPLOY_HOST:$DEPLOY_PATH/"
  fi
  _deploy_ok "full tree synced"
fi

if [ "$NO_BUILD" -eq 0 ]; then
  echo "--- Docker rebuild: ${SERVICES[*]} ---"
  # docker compose expects space-separated service names (not commas)
  remote_ssh "cd '$DEPLOY_PATH' && docker compose build ${SERVICES[*]} && docker compose up -d --build ${SERVICES[*]}"
  _deploy_ok "containers rebuilt"
else
  _deploy_warn "skipped docker build (--no-build)"
fi

if [ "$NO_VERIFY" -eq 0 ]; then
  echo "--- Post-deploy verify ---"
  sleep 3
  run_verify
else
  _deploy_warn "skipped post-deploy verify (--no-verify)"
fi

echo
echo "Deploy complete."