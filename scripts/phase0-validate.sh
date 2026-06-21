#!/usr/bin/env bash
#
# Phase 0 Validation Helper
#
# Validates that the bot connects to a real TeamSpeak 6 server and plays audio.
#
# Usage:
#   ./scripts/phase0-validate.sh [youtube-url-or-local-file]
#   ./scripts/phase0-validate.sh --detach --timeout 180
#   ./scripts/phase0-validate.sh --check-only
#
# Flags:
#   --check-only   Pre-flight only (docker, .env, TS6_HOST) — no containers started
#   --detach       Start bot detached, poll logs for PHASE 0 SUCCESS/FAILURE, exit
#   --timeout SEC  Max wait in --detach mode (default 300)
#   --yes, -y      Skip interactive .env prompt (non-TTY skips automatically)
#   --no-build     Omit --build on docker compose up

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEFAULT_TRACK="https://www.youtube.com/watch?v=hLOheGDwD_0"

CHECK_ONLY=0
DETACH=0
NO_BUILD=0
YES=0
TIMEOUT=300
TEST_TRACK=""

usage() {
  cat <<EOF
Moneypenny Phase 0 Validation Helper

  $0 [options] [test-track]

Options:
  --check-only     Verify docker + .env only (exit 0/1)
  --detach         Start bot in background and poll logs for result
  --timeout SEC    Detached wait limit (default 300)
  --yes, -y        Skip "edit .env" prompt
  --no-build       Do not pass --build to docker compose
  -h, --help       Show this help

Default test track: $DEFAULT_TRACK
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY=1; shift ;;
    --detach) DETACH=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) TEST_TRACK="$1"; shift ;;
  esac
done

if [ -z "$TEST_TRACK" ]; then
  TEST_TRACK="$DEFAULT_TRACK"
fi

log_banner() { echo "=== Moneypenny Phase 0 Validation ==="; echo; }

is_placeholder_host() {
  local h="${1,,}"
  case "$h" in
    ""|teamspeak|localhost|127.0.0.1|your.ts6*|your-ts6*|example.com|changeme|placeholder)
      return 0
      ;;
  esac
  return 1
}

load_env() {
  # shellcheck disable=SC1091
  set -a
  source .env
  set +a
}

preflight() {
  local ok=1
  log_banner
  echo "Phase 0 test track: $TEST_TRACK"
  echo

  if ! command -v docker >/dev/null 2>&1; then
    echo "FAIL: docker not found in PATH" >&2
    ok=0
  elif ! docker compose version >/dev/null 2>&1; then
    echo "FAIL: docker compose plugin not available" >&2
    ok=0
  else
    echo "OK: docker compose available"
  fi

  if [ ! -f .env ]; then
    echo "No .env found — creating from .env.example"
    cp .env.example .env
    echo
    echo "Edit .env and set at minimum:"
    echo "  TS6_HOST=your.ts6.server.or.ip"
    echo "  TS6_API_KEY=... (from TS6 web query UI)"
    echo
    if [ "$YES" -eq 0 ] && [ -t 0 ]; then
      read -r -p "Press Enter when you have edited .env …"
    else
      echo "(non-interactive — continuing with template .env)"
    fi
  fi

  load_env

  if is_placeholder_host "${TS6_HOST:-}"; then
    echo "FAIL: TS6_HOST is unset or still a placeholder (${TS6_HOST:-<empty>})" >&2
    echo "      Edit .env with your real TeamSpeak 6 server hostname or IP." >&2
    ok=0
  else
    echo "OK: TS6_HOST=${TS6_HOST}"
  fi

  if [ -z "${TS6_API_KEY:-}" ]; then
    echo "WARN: TS6_API_KEY is empty — connection may fail on TS6 (HTTP query key recommended)"
  else
    echo "OK: TS6_API_KEY is set"
  fi

  if [ "$ok" -eq 0 ]; then
    return 1
  fi
  echo
  echo "Pre-flight checks passed."
  return 0
}

wait_for_phase0_result() {
  local deadline=$((SECONDS + TIMEOUT))
  echo "Polling bot logs (timeout ${TIMEOUT}s) for PHASE 0 SUCCESS or FAILURE…"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local logs
    logs="$(docker compose logs bot 2>&1 || true)"
    if echo "$logs" | grep -q "PHASE 0 SUCCESS"; then
      echo
      echo "$logs" | grep -E "PHASE 0 (SUCCESS|FAILURE)|PHASE 0:" | tail -20
      echo
      echo "Phase 0 validation SUCCEEDED."
      return 0
    fi
    if echo "$logs" | grep -q "PHASE 0 FAILURE"; then
      echo
      echo "$logs" | grep -E "PHASE 0 (SUCCESS|FAILURE)|Phase 0:" | tail -30
      echo
      echo "Phase 0 validation FAILED — see logs above." >&2
      return 1
    fi
    sleep 5
  done
  echo "Timed out after ${TIMEOUT}s waiting for Phase 0 result." >&2
  echo "Last bot log lines:" >&2
  docker compose logs --tail 40 bot 2>&1 || true
  return 2
}

run_compose_up() {
  local -a args=(--profile core up)
  [ "$NO_BUILD" -eq 0 ] && args+=(--build)
  [ "$DETACH" -eq 1 ] && args+=(-d)
  args+=(bot)
  docker compose "${args[@]}"
}

# ── Main ─────────────────────────────────────────────────────────────────────

if ! preflight; then
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  exit 0
fi

export PHASE0_TEST_PLAY="$TEST_TRACK"

BUILD_NOTE=""
[ "$NO_BUILD" -eq 0 ] && BUILD_NOTE=" (with --build)"

if [ "$DETACH" -eq 1 ]; then
  echo "Starting bot detached${BUILD_NOTE}…"
  run_compose_up
  wait_for_phase0_result
  exit $?
fi

echo "Starting bot in foreground${BUILD_NOTE} — Ctrl+C to stop."
echo "Watch for PHASE 0 SUCCESS in the log output."
echo
run_compose_up