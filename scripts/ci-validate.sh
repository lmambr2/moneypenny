#!/usr/bin/env bash
#
# Non-interactive validation suite for cron/CI. Runs fast checks that do not
# require a live TeamSpeak server unless --live is passed.
#
# Usage:
#   ./scripts/ci-validate.sh              # preflight + doctrine + voice mock
#   ./scripts/ci-validate.sh --live       # also run phase0 detached (needs TS6)
#   ./scripts/ci-validate.sh --voice-only
#
# Exit codes:
#   0  all selected checks passed
#   1  phase0 preflight failed
#   2  doctrine sync test failed
#   3  voice smoke failed
#   4  phase0 live validation failed / timed out

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LIVE=0
PHASE0_ONLY=0
VOICE_ONLY=0
DOCTRINE_ONLY=0
VOICE_MOCK=1
PHASE0_TIMEOUT="${PHASE0_TIMEOUT:-180}"

usage() {
  cat <<EOF
Moneypenny CI validation (non-interactive)

  $0 [options]

Options:
  --live            Run detached Phase 0 against real TS6 (needs .env + server)
  --phase0-only     Only Phase 0 preflight (--live adds detached run)
  --doctrine-only   Only doctrine git sync test
  --voice-only      Only voice sidecar smoke (stt-mock by default)
  --timeout SEC     Phase 0 detached timeout (default 180)
  -h, --help

  (Removed: --sherpa — legacy Moonshine/Kokoro path deleted in V2.)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --phase0-only) PHASE0_ONLY=1; shift ;;
    --doctrine-only) DOCTRINE_ONLY=1; shift ;;
    --voice-only) VOICE_ONLY=1; shift ;;
    --sherpa)
      echo "error: --sherpa removed (V2). Voice CI uses stt-mock; product is Whisper+Piper." >&2
      exit 2
      ;;
    --timeout) PHASE0_TIMEOUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

run_all=1
if [ "$PHASE0_ONLY" -eq 1 ] || [ "$DOCTRINE_ONLY" -eq 1 ] || [ "$VOICE_ONLY" -eq 1 ]; then
  run_all=0
fi

fail_phase0=0
fail_doctrine=0
fail_voice=0
fail_live=0

echo "=== Moneypenny CI Validate ==="
echo

if [ "$run_all" -eq 1 ] || [ "$PHASE0_ONLY" -eq 1 ]; then
  echo "--- Phase 0 preflight ---"
  if ./scripts/phase0-validate.sh --check-only --yes; then
    echo "OK: Phase 0 preflight"
  else
    echo "FAIL: Phase 0 preflight" >&2
    fail_phase0=1
  fi
  echo

  if [ "$LIVE" -eq 1 ]; then
    echo "--- Phase 0 live (detached) ---"
    if ./scripts/phase0-validate.sh --detach --timeout "$PHASE0_TIMEOUT" --yes --no-build; then
      echo "OK: Phase 0 live"
    else
      ec=$?
      echo "FAIL: Phase 0 live (exit $ec)" >&2
      fail_live=1
    fi
    echo
  fi
fi

if [ "$run_all" -eq 1 ] || [ "$DOCTRINE_ONLY" -eq 1 ]; then
  echo "--- Doctrine git sync ---"
  if ./scripts/doctrine-sync-test.sh; then
    echo "OK: doctrine sync"
  else
    echo "FAIL: doctrine sync" >&2
    fail_doctrine=1
  fi
  echo
fi

if [ "$run_all" -eq 1 ] || [ "$VOICE_ONLY" -eq 1 ]; then
  echo "--- Voice sidecars (stt-mock) ---"
  if ./scripts/voice-smoke.sh --up-mock --no-tts; then
    echo "OK: voice mock STT"
  else
    echo "FAIL: voice mock STT" >&2
    fail_voice=1
  fi
  echo
fi

if [ "$fail_phase0" -ne 0 ]; then exit 1; fi
if [ "$fail_doctrine" -ne 0 ]; then exit 2; fi
if [ "$fail_voice" -ne 0 ]; then exit 3; fi
if [ "$fail_live" -ne 0 ]; then exit 4; fi

echo "CI validation passed."