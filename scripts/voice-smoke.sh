#!/usr/bin/env bash
# Voice sidecar smoke — dual-track Whisper STT + Piper TTS (product path).
#
#   ./scripts/voice-smoke.sh                    # probe localhost defaults
#   ./scripts/voice-smoke.sh --up-mock          # stt-mock (CI)
#   ./scripts/voice-smoke.sh --up edge          # voice-edge then probe
#   ./scripts/voice-smoke.sh --up server        # voice-server then probe
#   ./scripts/voice-smoke.sh --no-tts           # STT only
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STT_URL="${STT_URL:-http://127.0.0.1:9000}"
TTS_URL="${TTS_URL:-http://127.0.0.1:8880}"
UP=""
NO_TTS=0

usage() {
  cat <<'EOF'
Usage: ./scripts/voice-smoke.sh [--up edge|server|mock] [--up-mock] [--no-tts] [--stt URL] [--tts URL]

Product voice is Whisper + Piper. Legacy sherpa/Kokoro were removed (V2).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --up)
      UP="${2:?edge|server|mock}"
      shift 2
      ;;
    --up-mock) UP=mock; shift ;;
    --no-tts) NO_TTS=1; shift ;;
    --stt) STT_URL="$2"; shift 2 ;;
    --tts) TTS_URL="$2"; shift 2 ;;
    # Old flag: ignored (legacy sherpa path removed)
    --up-sherpa|--sherpa)
      echo "error: sherpa/Kokoro removed (V2). Use --up-mock, --up edge, or --up server." >&2
      exit 1
      ;;
    *) echo "unknown: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -n "$UP" ]; then
  case "$UP" in
    mock|voice-dev)
      STT_URL="${STT_URL:-http://127.0.0.1:9001}"
      echo "Starting voice-dev (stt-mock)…"
      docker compose -f docker-compose.yml --profile voice-dev up -d --build stt-mock
      # mock publishes 9001
      STT_URL="http://127.0.0.1:9001"
      ;;
    edge)
      echo "Starting voice-edge (stt-whisper + piper-tts)…"
      docker compose -f docker-compose.yml -f docker-compose.sbc.yml \
        --profile voice-edge up -d --build stt-whisper piper-tts
      STT_URL="http://127.0.0.1:9000"
      TTS_URL="http://127.0.0.1:8880"
      ;;
    server)
      echo "Starting voice-server (stt-whisper + piper-tts)…"
      export RENDER_GID="${RENDER_GID:-$(getent group render 2>/dev/null | cut -d: -f3 || echo 992)}"
      export VIDEO_GID="${VIDEO_GID:-$(getent group video 2>/dev/null | cut -d: -f3 || echo 44)}"
      docker compose -f docker-compose.yml -f docker-compose.server.yml \
        --profile voice-server up -d --build stt-whisper piper-tts
      STT_URL="http://127.0.0.1:9000"
      TTS_URL="http://127.0.0.1:8880"
      ;;
    *)
      echo "Use --up edge|server|mock" >&2
      exit 1
      ;;
  esac
  echo "Waiting for STT at ${STT_URL}…"
  for _ in $(seq 1 90); do
    if curl -sf "${STT_URL}/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

echo "=== STT ${STT_URL}/health ==="
if ! curl -sf "${STT_URL}/health" | tee /tmp/mp-stt-health.json; then
  echo "FAIL: STT health" >&2
  exit 1
fi
echo
python3 -c "import json,sys; j=json.load(open('/tmp/mp-stt-health.json')); sys.exit(0 if j.get('ok') else 1)" \
  || { echo "FAIL: STT not ok" >&2; exit 1; }

if [ "$NO_TTS" -eq 0 ]; then
  echo "=== TTS ${TTS_URL} ==="
  if curl -sf "${TTS_URL}/health" >/tmp/mp-tts-health.json 2>/dev/null; then
    cat /tmp/mp-tts-health.json
    echo
    python3 -c "import json,sys; j=json.load(open('/tmp/mp-tts-health.json')); sys.exit(0 if j.get('ok') else 1)" \
      || { echo "FAIL: TTS not ok" >&2; exit 1; }
  else
    code=$(curl -sS -o /tmp/mp-tts-smoke.wav -w "%{http_code}" \
      -X POST "${TTS_URL}/v1/audio/speech" \
      -H "Content-Type: application/json" \
      -d '{"model":"piper","input":"ok","voice":"en_GB-southern_english_female-low","response_format":"wav"}' \
      || true)
    if [ "$code" != "200" ] || [ ! -s /tmp/mp-tts-smoke.wav ]; then
      echo "FAIL: TTS speech (HTTP $code)" >&2
      exit 1
    fi
    echo "OK TTS speech → /tmp/mp-tts-smoke.wav ($(wc -c </tmp/mp-tts-smoke.wav) bytes)"
  fi
fi

echo
echo "Voice smoke OK."
echo "  sttUrl=http://stt-whisper:9000  ttsUrl=http://piper-tts:8880  textWakeFallback=true"
