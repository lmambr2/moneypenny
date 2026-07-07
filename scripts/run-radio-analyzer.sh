#!/usr/bin/env bash
# Trigger the radio analyzer batch (docs/radio.md §9.5, OQ2).
# Requires: analyzer enabled in Settings → Radio/DJ, admin session cookie or token.
#
# Usage:
#   MONEYPENNY_URL=http://127.0.0.1:3000 ./scripts/run-radio-analyzer.sh
#   FORCE=1 ./scripts/run-radio-analyzer.sh   # re-analyze tracks that already have key+BPM
set -euo pipefail

BASE="${MONEYPENNY_URL:-http://127.0.0.1:3000}"
FORCE="${FORCE:-0}"
COOKIE_JAR="${COOKIE_JAR:-}"

curl_common=( -fsS -X POST "${BASE}/api/music/analyze" -H 'Content-Type: application/json' )
if [[ -n "$COOKIE_JAR" ]]; then
  curl_common+=( -b "$COOKIE_JAR" -c "$COOKIE_JAR" )
fi

body='{}'
if [[ "$FORCE" == "1" ]]; then
  body='{"force":true}'
fi

echo "POST ${BASE}/api/music/analyze (force=${FORCE})"
curl "${curl_common[@]}" -d "$body"
echo