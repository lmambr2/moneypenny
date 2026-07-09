#!/usr/bin/env bash
# V1 under-music smoke — pure watchword/duck path (no live TS).
# Runs vitest cases that drive extractWatchwordCommand + under-music plan.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/bot"
echo "Voice under-music check (V1/H4)…"
npx vitest run src/voice/under-music.test.ts
echo "OK — progressive text wake + armed follow-up + smoke suite"
