#!/usr/bin/env bash
#
# Voice sidecar smoke test — probes STT (sherpa-stt / stt-mock) and Kokoro TTS.
#
# Usage:
#   ./scripts/voice-smoke.sh              # probe localhost defaults (sherpa :9000)
#   ./scripts/voice-smoke.sh --up         # start sherpa-stt + kokoro, then probe
#   ./scripts/voice-smoke.sh --up-mock    # fast CI path: stt-mock on :9001
#
# Exit 0 when every configured endpoint responds; 1 otherwise.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

UP=0
UP_MOCK=0
STT_URL="${STT_URL:-http://127.0.0.1:9000}"
TTS_URL="${TTS_URL:-http://127.0.0.1:8880}"
TTS_VOICE="${TTS_VOICE:-bf_emma}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-15}"
SHERPA_WARMUP="${SHERPA_WARMUP:-90}"

usage() {
  cat <<'EOF'
Voice sidecar smoke test

  ./scripts/voice-smoke.sh [--up | --up-mock] [--stt URL] [--tts URL]

Options:
  --up          docker compose --profile voice up -d (sherpa-stt + kokoro)
  --up-mock     docker compose --profile voice-dev up -d (stt-mock, port 9001)
  --stt URL     STT base URL (default http://127.0.0.1:9000)
  --tts URL     TTS base URL (default http://127.0.0.1:8880)
  --no-tts      skip Kokoro probe (STT only)
  -h, --help    show this help
EOF
}

SKIP_TTS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --up) UP=1; shift ;;
    --up-mock) UP_MOCK=1; shift ;;
    --stt) STT_URL="$2"; shift 2 ;;
    --tts) TTS_URL="$2"; shift 2 ;;
    --no-tts) SKIP_TTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "FAIL: curl is required" >&2
  exit 1
fi

echo "=== Moneypenny Voice Smoke Test ==="
echo "STT: $STT_URL"
if [ "$SKIP_TTS" -eq 0 ]; then
  echo "TTS: $TTS_URL (voice=$TTS_VOICE)"
else
  echo "TTS: (skipped)"
fi
echo

if [ "$UP_MOCK" -eq 1 ]; then
  echo "Starting voice-dev profile (stt-mock)…"
  docker compose --profile voice-dev up -d --build stt-mock
  STT_URL="http://127.0.0.1:9001"
  echo "Waiting for stt-mock…"
  sleep 2
elif [ "$UP" -eq 1 ]; then
  echo "Starting voice profile (sherpa-stt + kokoro)…"
  docker compose --profile voice up -d --build sherpa-stt kokoro
  STT_URL="http://127.0.0.1:9000"
  TTS_URL="http://127.0.0.1:8880"
  echo "Waiting for sherpa-stt (model load may take up to ${SHERPA_WARMUP}s)…"
  deadline=$((SECONDS + SHERPA_WARMUP))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -sf --max-time 3 "$STT_URL/health" | grep -q '"ok"'; then
      break
    fi
    sleep 3
  done
fi

fail=0

stt_base="${STT_URL%/}"
echo -n "STT GET /health … "
if curl -sf --max-time "$PROBE_TIMEOUT" "$stt_base/health" | grep -q '"ok"'; then
  echo "OK"
else
  echo "FAIL"
  fail=1
fi

echo -n "STT POST /asr … "
pcm="$(python3 -c 'print("x" * 128)')"
if resp="$(curl -sf --max-time "$PROBE_TIMEOUT" -X POST "$stt_base/asr" \
  -H 'Content-Type: application/octet-stream' \
  -H 'X-Sample-Rate: 16000' -H 'X-Channels: 1' \
  --data-binary "$pcm")" && echo "$resp" | grep -q '"text"'; then
  echo "OK ($(echo "$resp" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("text",""))' 2>/dev/null || echo '?'))"
else
  echo "FAIL"
  fail=1
fi

if [ "$SKIP_TTS" -eq 0 ]; then
  tts_base="${TTS_URL%/}"
  echo -n "TTS synthesis … "
  if curl -sf --max-time "$PROBE_TIMEOUT" -X POST "$tts_base/v1/audio/speech" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"kokoro\",\"input\":\"ok\",\"voice\":\"$TTS_VOICE\",\"response_format\":\"wav\"}" \
    -o /dev/null -w '%{http_code}' | grep -qE '^(200|201)$'; then
    echo "OK"
  else
    echo "FAIL (Kokoro may still be downloading models — retry in a minute)"
    fail=1
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "Voice smoke test passed."
  if [ "$UP_MOCK" -eq 1 ]; then
    echo "In Docker use http://stt-mock:9000 (host maps to :9001)."
  else
    echo "Configure in Settings: STT URL → http://sherpa-stt:9000"
  fi
  exit 0
fi
echo "Voice smoke test failed — check sidecar logs:"
echo "  docker compose --profile voice logs sherpa-stt kokoro"
echo "  docker compose --profile voice-dev logs stt-mock"
exit 1