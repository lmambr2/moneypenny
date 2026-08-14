#!/usr/bin/env bash
# Install RKNN Whisper weights on the Pi and verify the NPU backend loads.
#
# Why this exists: swapping the STT model is otherwise a hand-edit of a root-owned
# Docker volume with no undo, so this backs up first and can roll back.
#
# NOTE (2026-07-25): this script was written to test a hypothesis that turned out
# to be false — that the deployed weights were i8-quantized and that mis-transcribed
# voice commands were a quantization artifact (airockchip/rknn_model_zoo#314).
# A local `fp` reconversion of whisper base produced files byte-identical in SIZE
# to the deployed pair (encoder 44598316, decoder 159699025), which means the Pi
# has been running unquantized weights all along. 44.6MB for a ~20M-param encoder
# is fp16; an i8 build would be roughly half that. Mis-transcription is a base-model
# accuracy limit, not quantization. Keep the script for future model swaps; do not
# re-run the fp experiment.
#
#   ./scripts/install-rknn-whisper.sh enc.rknn dec.rknn      # install + verify
#   ./scripts/install-rknn-whisper.sh --rollback             # restore backup
#   ./scripts/install-rknn-whisper.sh --verify               # check what loaded
#
# Convert on an x86 host with rknn-toolkit2 (rgbmasheen), from rknn_model_zoo:
#   cd examples/whisper/python
#   python convert.py ../model/whisper_encoder_base_20s.onnx rk3588 fp
#   python convert.py ../model/whisper_decoder_base_20s.onnx rk3588 fp
# `fp` is the default dtype; `i8` is what produced the current weights.
set -euo pipefail

HOST="${DEPLOY_HOST:-dietpi@opi5}"
SSH_OPTS=(-o ClearAllForwardings=yes -o ConnectTimeout=15)
VOL="/var/lib/docker/volumes/moneypenny_whisper-models/_data/rknn"
BACKUP="$VOL/backup-i8"
COMPOSE_DIR="/home/dietpi/moneypenny"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

verify() {
  say "Backend the service actually loaded"
  remote "cd $COMPOSE_DIR && docker compose logs stt-whisper --tail 40 2>/dev/null \
    | grep -iE 'NPU Whisper ready|backend=|model_dtype|fallback' | tail -6"
  # The stt image has no curl — it is a Python service, so probe with urllib.
  say "Health"
  remote "cd $COMPOSE_DIR && docker compose exec -T stt-whisper python3 -c \
    'import urllib.request,sys
try:
    urllib.request.urlopen(\"http://127.0.0.1:9000/health\", timeout=5)
    print(\"  stt /health OK\")
except Exception as e:
    print(\"  stt /health FAILED:\", e); sys.exit(1)'" || true
}

case "${1:-}" in
  --verify)
    verify; exit 0 ;;
  --rollback)
    say "Restoring i8 backup"
    remote "sudo test -d $BACKUP" || die "no backup at $BACKUP"
    remote "sudo cp -a $BACKUP/whisper-base-encoder.rknn $BACKUP/whisper-base-decoder.rknn $VOL/"
    remote "cd $COMPOSE_DIR && docker compose restart stt-whisper" >/dev/null
    sleep 8; verify; exit 0 ;;
esac

ENC="${1:-}"; DEC="${2:-}"
[ -f "$ENC" ] && [ -f "$DEC" ] || die "usage: $0 <encoder.rknn> <decoder.rknn> | --rollback | --verify"

# RKNN containers start with the "RKNN" magic; catches an HTML error page or a
# stray ONNX being copied onto the live model.
for f in "$ENC" "$DEC"; do
  head -c 4 "$f" | grep -q "RKNN" || die "$f does not look like an .rknn (missing RKNN magic)"
done

say "Sizes (current deployed pair is enc 44598316 / dec 159699025, both fp)"
ls -lh "$ENC" "$DEC" | awk '{print "  ", $5, $9}'

say "Backing up current i8 weights → $BACKUP"
remote "sudo mkdir -p $BACKUP && sudo cp -a $VOL/whisper-base-encoder.rknn $VOL/whisper-base-decoder.rknn $BACKUP/ 2>/dev/null || true"

say "Installing"
scp "${SSH_OPTS[@]}" "$ENC" "$HOST:/tmp/enc.rknn" >/dev/null
scp "${SSH_OPTS[@]}" "$DEC" "$HOST:/tmp/dec.rknn" >/dev/null
remote "sudo cp /tmp/enc.rknn $VOL/whisper-base-encoder.rknn && \
        sudo cp /tmp/dec.rknn $VOL/whisper-base-decoder.rknn && \
        rm -f /tmp/enc.rknn /tmp/dec.rknn"

say "Restarting stt-whisper"
remote "cd $COMPOSE_DIR && docker compose restart stt-whisper" >/dev/null
sleep 10
verify

cat <<'EOF'

Next: say "moneypenny play dos gringos" in channel, then check the transcript:
  ssh dietpi@opi5 'cd ~/moneypenny && docker compose logs bot --since 5m \
    | grep -oE "\"transcript\":\"[^\"]*\""'

i8 produced "played Dose Gringos" for "play Dos Gringos" (word-boundary merge).
If fp transcribes it correctly, quantization was the cause.
Roll back any time with: ./scripts/install-rknn-whisper.sh --rollback
EOF
