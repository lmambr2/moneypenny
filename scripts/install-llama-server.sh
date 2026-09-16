#!/usr/bin/env bash
# Install a systemd --user unit that keeps llama-server on :11434.
#
#   ./scripts/install-llama-server.sh
#   ./scripts/install-llama-server.sh --no-start
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/llama-cpp-env.sh
source "$ROOT/scripts/lib/llama-cpp-env.sh"

START=1
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    -h|--help)
      echo "Usage: $0 [--no-start]"
      exit 0
      ;;
    *) echo "unknown: $arg" >&2; exit 1 ;;
  esac
done

BIN="$(llama_server_bin)" || {
  echo "llama-server not found. Run ./scripts/build-llama-cpp-hip.sh first." >&2
  exit 1
}
[ -s "$(gemma4_target_gguf)" ] && [ -s "$(gemma4_draft_gguf)" ] || {
  echo "GGUFs missing. Run ./scripts/download-gemma4-qat-gguf.sh first." >&2
  exit 1
}

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="${UNIT_DIR}/llama-server-gemma4.service"
mkdir -p "$UNIT_DIR"

SERVE="${ROOT}/scripts/serve-llama-cpp-gemma4.sh"
chmod +x \
  "$ROOT/scripts/build-llama-cpp-hip.sh" \
  "$ROOT/scripts/download-gemma4-qat-gguf.sh" \
  "$ROOT/scripts/serve-llama-cpp-gemma4.sh" \
  "$ROOT/scripts/install-llama-server.sh"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=MoneyPenny llama.cpp Gemma 4 12B QAT (HIP gfx1201)
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
WorkingDirectory=${ROOT}
Environment=HIP_VISIBLE_DEVICES=${HIP_VISIBLE_DEVICES}
Environment=ROCR_VISIBLE_DEVICES=${ROCR_VISIBLE_DEVICES}
Environment=ROCM_PATH=${ROCM_PATH:-/opt/rocm}
Environment=HIP_PATH=${HIP_PATH:-/opt/rocm}
Environment=LLAMA_CPP_DIR=${LLAMA_CPP_DIR}
Environment=MONEYPENNY_GGUF_DIR=${MONEYPENNY_GGUF_DIR}
Environment=LLAMA_SERVER_HOST=${LLAMA_SERVER_HOST}
Environment=LLAMA_SERVER_PORT=${LLAMA_SERVER_PORT}
Environment=LLAMA_SERVER_ALIAS=${LLAMA_SERVER_ALIAS}
Environment=LD_LIBRARY_PATH=${ROCM_PATH:-/opt/rocm}/lib
ExecStart=${SERVE}
Restart=on-failure
RestartSec=3
# HIP graphs / model load can take a while
TimeoutStartSec=180

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable llama-server-gemma4.service
if [ "$START" -eq 1 ]; then
  # Do not share :11434 with Ollama.
  if ss -tln | grep -q ":${LLAMA_SERVER_PORT} "; then
    if ! systemctl --user is-active --quiet llama-server-gemma4.service; then
      echo "port ${LLAMA_SERVER_PORT} is already in use. Stop Ollama (or whatever owns it) first." >&2
      echo "  systemctl --user stop ollama 2>/dev/null; sudo systemctl stop ollama 2>/dev/null" >&2
      exit 1
    fi
  fi
  systemctl --user restart llama-server-gemma4.service
  echo "Started llama-server-gemma4.service"
else
  echo "Enabled (not started): $UNIT_PATH"
fi

echo
echo "Bot settings:"
echo "  llmUrl   = http://${LLAMA_SERVER_HOST}:${LLAMA_SERVER_PORT}"
echo "  llmModel = ${LLAMA_SERVER_ALIAS}"
echo "Logs: journalctl --user -u llama-server-gemma4 -f"
echo "Docs: docs/gpu-amd.md"
echo
echo "Keep embeddings off this port. CPU Ollama on :11435 is the usual split"
echo "(docker-compose.server.llamacpp.yml)."
