#!/usr/bin/env bash
#
# Local checks before any Pi deploy. Fails fast on wrong tree, missing critical
# files, or rank-gating / command regressions.
#
# Usage:
#   ./scripts/deploy-preflight.sh              # markers + tsc + deploy-critical tests
#   ./scripts/deploy-preflight.sh --full       # also run npm run test:all
#   ./scripts/deploy-preflight.sh --markers    # tree fingerprint only (fast)
#
# Exit 0 when safe to deploy; non-zero otherwise.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/deploy-common.sh
source "$ROOT/scripts/lib/deploy-common.sh"

FULL=0
MARKERS_ONLY=0

usage() {
  cat <<EOF
Moneypenny deploy preflight (run locally before Pi rsync)

  $0 [--full] [--markers]

Options:
  --full       Run full test:all after critical tests (slower)
  --markers    Only assert production-fork files + COMMAND_MANIFEST markers
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --markers) MARKERS_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

echo "=== Moneypenny deploy preflight ==="
echo "Source: $ROOT"
echo

assert_production_fork "$ROOT"
_deploy_ok "production fork fingerprint"

if [ "$MARKERS_ONLY" -eq 1 ]; then
  echo "Preflight passed (markers only)."
  exit 0
fi

echo "--- Typecheck ---"
(cd "$ROOT/bot" && npx tsc --noEmit)
_deploy_ok "tsc --noEmit"

echo "--- Deploy-critical tests ---"
(
  cd "$ROOT/bot"
  npx vitest run \
    src/rights/rank-gating-template.test.ts \
    src/control/router.test.ts \
    src/music/local.test.ts \
    src/voice/pipeline.test.ts \
    src/bot/playback/engine.test.ts
)
_deploy_ok "deploy-critical vitest"

if [ "$FULL" -eq 1 ]; then
  echo "--- Full test suite ---"
  (cd "$ROOT/bot" && npm run test:all)
  _deploy_ok "test:all"
fi

echo
echo "Preflight passed — safe to run ./scripts/deploy-to-pi.sh"