#!/usr/bin/env bash
#
# Phase 0 Validation Helper
# Usage: ./scripts/phase0-validate.sh [youtube-url-or-local-file]
#
# This script helps you quickly validate that the bot can connect to a real
# TeamSpeak 6 server and play audio (the core of Phase 0).

set -euo pipefail

echo "=== Moneypenny Phase 0 Validation Helper ==="
echo

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <test-track>"
  echo "  test-track can be a YouTube URL or a filename in your MUSIC_DIR"
  echo
  echo "Example:"
  echo "  $0 https://youtu.be/dQw4w9wgccc"
  echo "  $0 'my-test-track.mp3'"
  exit 1
fi

TEST_TRACK="$1"

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
