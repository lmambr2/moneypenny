#!/usr/bin/env bash
#
# Phase 0 Validation Helper
# Usage: ./scripts/phase0-validate.sh [youtube-url-or-local-file]
#
# Defaults to the built-in Moneypenny demo/unit-test video if no argument given.
# This script helps you quickly validate that the bot can connect to a real
# TeamSpeak 6 server and play audio (the core of Phase 0).

set -euo pipefail

echo "=== Moneypenny Phase 0 Validation Helper ==="
echo

if [ -z "${1:-}" ]; then
  # Default to the canonical Moneypenny unit test + startup demo video.
  # (You can still pass any YouTube URL or local filename from MUSIC_DIR.)
  TEST_TRACK="https://www.youtube.com/watch?v=hLOheGDwD_0"
  echo "No test-track supplied — using default Moneypenny demo/unit-test track:"
  echo "  $TEST_TRACK"
  echo
else
  TEST_TRACK="$1"
fi

echo "Phase 0 test track: $TEST_TRACK"

# Create a minimal .env for Phase 0 if one doesn't exist
if [ ! -f .env ]; then
  echo "No .env found. Creating a Phase 0 template..."
  cp .env.example .env
  echo
  echo "Please edit .env now and set at minimum:"
  echo "  TS6_HOST=your.ts6.server.or.ip"
  echo "  TS6_API_KEY=... (get this from your TS6 server)"
  echo
  read -p "Press Enter when you have edited .env ..."
fi

export PHASE0_TEST_PLAY="$TEST_TRACK"

echo "Starting with Phase 0 test playback: $TEST_TRACK"
echo

docker compose --profile core up --build bot
