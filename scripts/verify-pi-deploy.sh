#!/usr/bin/env bash
#
# Post-deploy verification on the Pi (via SSH) or locally (--local on the board).
#
# Usage:
#   ./scripts/verify-pi-deploy.sh
#   ./scripts/verify-pi-deploy.sh --local

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/deploy-common.sh
source "$ROOT/scripts/lib/deploy-common.sh"

LOCAL=0
BOT_CONTAINER="${BOT_CONTAINER:-moneypenny-bot-1}"
STT_CONTAINER="${STT_CONTAINER:-moneypenny-stt-whisper-1}"
PIPER_CONTAINER="${PIPER_CONTAINER:-moneypenny-piper-tts-1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) LOCAL=1; shift ;;
    -h|--help) exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

_run() {
  if [ "$LOCAL" -eq 1 ]; then
    "$@"
  else
    remote_ssh "$@"
  fi
}

_fail=0
_check() {
  local desc="$1"
  shift
  if "$@"; then
    _deploy_ok "$desc"
  else
    echo "FAIL: $desc" >&2
    _fail=1
  fi
}

echo "=== Moneypenny Pi deploy verify ==="
[ "$LOCAL" -eq 1 ] && echo "Mode: local" || echo "Host: $DEPLOY_HOST"
echo

_check "bot container running" \
  _run "docker inspect -f '{{.State.Running}}' $BOT_CONTAINER 2>/dev/null | grep -qx true"

_check "stt-whisper container running (dual-track STT)" \
  _run "docker inspect -f '{{.State.Running}}' $STT_CONTAINER 2>/dev/null | grep -qx true"

_check "piper-tts container running" \
  _run "docker inspect -f '{{.State.Running}}' $PIPER_CONTAINER 2>/dev/null | grep -qx true"

_cmd_markers=''
for c in "${DEPLOY_CRITICAL_COMMANDS[@]}"; do
  _cmd_markers+="grep -q '$c' /app/dist/bot/commands.js && "
done
_cmd_markers="${_cmd_markers%&& }"

_check "dist/commands.js has production COMMAND_MANIFEST markers" \
  _run "docker exec $BOT_CONTAINER sh -c \"$_cmd_markers\""

_check "dist/music/local.js exports findSongByVideoId" \
  _run "docker exec $BOT_CONTAINER grep -q findSongByVideoId /app/dist/music/local.js"

_check "dist/bot/voice/session.js has passive CPU gates" \
  _run "docker exec $BOT_CONTAINER grep -q passiveStreamFlushMs /app/dist/bot/voice/session.js"

_check "poke handler present in dist" \
  _run "docker exec $BOT_CONTAINER test -f /app/dist/bot/control/poke-handler.js"

_check "/music writable by container user (uid 1000)" \
  _run "docker exec $BOT_CONTAINER sh -c 'mkdir -p /music/youtube && touch /music/youtube/.deploy-verify && rm -f /music/youtube/.deploy-verify'"

_check "music volume is bind-mounted" \
  _run "docker inspect -f '{{range .Mounts}}{{if eq .Destination \"/music\"}}{{.Source}}{{end}}{{end}}' $BOT_CONTAINER | grep -q ."

_music_src="$(_run "docker inspect -f '{{range .Mounts}}{{if eq .Destination \"/music\"}}{{.Source}}{{end}}{{end}}' $BOT_CONTAINER" 2>/dev/null || true)"
if [ -n "$_music_src" ]; then
  echo "INFO: /music host source = $_music_src"
  _run "ls -la $_music_src $_music_src/youtube 2>/dev/null | head -5" || true
fi

_check "stt-whisper /health responds" \
  _run "docker exec $BOT_CONTAINER node -e \"fetch('http://stt-whisper:9000/health').then(r=>r.json()).then(j=>{if(!j.ok)process.exit(1)}).catch(()=>process.exit(1))\""

if _run "docker ps --format '{{.Names}}' | grep -q rkllama"; then
  _check "rkllama /health responds" \
    _run "docker exec $BOT_CONTAINER node -e \"fetch('http://rkllama:8080/health').then(r=>r.json()).then(j=>{if(j.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))\""
fi

echo
if [ "$_fail" -ne 0 ]; then
  echo "Pi deploy verification FAILED." >&2
  exit 1
fi
echo "Pi deploy verification passed."