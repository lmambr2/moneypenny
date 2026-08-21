#!/usr/bin/env bash
# Refresh the writable yt-dlp zipapp used by the Moneypenny bot.
# Safe to run while the bot is up — the next yt-dlp exec picks up the new file.
set -euo pipefail

DEST="${YTDLP_BIN:-/media/storage/moneypenny/bot/data/bin/yt-dlp}"
NIGHTLY_URL="${YTDLP_NIGHTLY_URL:-https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp}"
mkdir -p "$(dirname "$DEST")"

if [[ -x "$DEST" ]] && "$DEST" --update-to nightly >/dev/null 2>&1; then
  echo "yt-dlp self-updated: $("$DEST" --version)"
  exit 0
fi

tmp="${DEST}.new"
if curl -fsSL --max-time 60 -o "$tmp" "$NIGHTLY_URL"; then
  chmod a+rx "$tmp"
  if "$tmp" --version >/dev/null 2>&1; then
    mv -f "$tmp" "$DEST"
    echo "yt-dlp replaced from nightly: $("$DEST" --version)"
    exit 0
  fi
fi
rm -f "$tmp"
echo "yt-dlp update failed — left $DEST as-is" >&2
exit 1
