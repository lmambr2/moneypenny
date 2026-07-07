#!/usr/bin/env bash
# OQ3 — embedded tag coverage scan (radio.md §15.3).
# Runs inside the production bot container so music-metadata is already present.
#
# Usage:
#   ./scripts/oq3-tag-scan.sh [music-dir]
# Default music dir: /music in the container (host ./music or MUSIC_HOST_DIR bind).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${MONEYPENNY_BOT_CONTAINER:-moneypenny-bot-1}"
MUSIC_DIR="${1:-/music}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "FAIL: container '$CONTAINER' is not running — start the bot stack first." >&2
  exit 1
fi

if ! docker exec "$CONTAINER" test -f /app/dist/tools/library-tag-scan.js; then
  echo "FAIL: /app/dist/tools/library-tag-scan.js missing — rebuild the bot image (dev commit with OQ3 scan in dist)." >&2
  exit 1
fi

docker exec "$CONTAINER" node /app/dist/tools/library-tag-scan.js "$MUSIC_DIR"