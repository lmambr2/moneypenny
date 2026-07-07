#!/usr/bin/env bash
# OQ3 — embedded tag coverage scan (radio.md §15.3).
# Uses the bot image (music-metadata already installed). Works with read-only
# container rootfs — does not docker exec into the running bot.
#
# Usage:
#   ./scripts/oq3-tag-scan.sh [host-music-dir]
# Default: <repo>/music (host bind for ./music in .env).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${MONEYPENNY_BOT_CONTAINER:-moneypenny-bot-1}"
HOST_MUSIC="${1:-$ROOT/music}"
CONTAINER_MUSIC="/music"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "FAIL: container '$CONTAINER' is not running — start the bot stack first." >&2
  exit 1
fi

if [[ ! -d "$HOST_MUSIC" ]]; then
  echo "FAIL: music dir not found: $HOST_MUSIC" >&2
  exit 1
fi

IMAGE="$(docker inspect --format='{{.Config.Image}}' "$CONTAINER")"
SCAN_JS="$ROOT/bot/dist/tools/library-tag-scan.js"

run_scan() {
  local -a mounts=(-v "$HOST_MUSIC:$CONTAINER_MUSIC:ro")
  local entry="dist/tools/library-tag-scan.js"

  if docker run --rm --entrypoint test "$IMAGE" -f "/app/$entry" >/dev/null 2>&1; then
    docker run --rm "${mounts[@]}" "$IMAGE" node "$entry" "$CONTAINER_MUSIC"
    return
  fi

  if [[ -f "$SCAN_JS" ]]; then
    mounts+=(-v "$SCAN_JS:/app/$entry:ro")
    docker run --rm "${mounts[@]}" "$IMAGE" node "$entry" "$CONTAINER_MUSIC"
    return
  fi

  echo "FAIL: $entry not in image and $SCAN_JS missing." >&2
  echo "  git pull && docker compose build bot   # bake scan into image" >&2
  echo "  or: cd bot && npx tsc && re-run this script" >&2
  exit 1
}

run_scan