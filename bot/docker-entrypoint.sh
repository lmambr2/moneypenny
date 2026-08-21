#!/bin/sh
# Keep yt-dlp current on the writable data volume. YouTube extractor breakage
# is a weekly event; the image binary is a floor, nightly self-update is the
# real fix. Fail-open: a GitHub blip must not block the bot starting.
set -eu
BIN_DIR="${YTDLP_BIN_DIR:-/app/data/bin}"
BIN="${YTDLP_BIN:-$BIN_DIR/yt-dlp}"
mkdir -p "$BIN_DIR"

size() {
  wc -c <"$1" 2>/dev/null || echo 0
}

if [ ! -x "$BIN" ] || [ "$(size "$BIN")" -lt 100000 ]; then
  if [ -x /usr/local/bin/yt-dlp ] && [ "$(size /usr/local/bin/yt-dlp)" -ge 100000 ]; then
    cp /usr/local/bin/yt-dlp "$BIN"
    chmod a+rx "$BIN"
  fi
fi

if [ "${YTDLP_AUTO_UPDATE:-1}" != "0" ] && [ -x "$BIN" ]; then
  "$BIN" --update-to nightly >/tmp/yt-dlp-update.log 2>&1 || true
fi

if [ "$#" -eq 0 ]; then
  set -- node dist/index.js
fi
exec "$@"
