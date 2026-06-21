#!/usr/bin/env bash
# Gemma 4 GGUF (incl. unsloth QAT) needs Ollama >= 0.30 — the old curl installer
# binary at /usr/local/bin/ollama (0.23.x) cannot load architecture "gemma4".
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

NEW_BIN="/usr/bin/ollama"
if [[ ! -x "$NEW_BIN" ]]; then
  echo "pacman ollama not found at $NEW_BIN — install: sudo pacman -S ollama" >&2
  exit 1
fi

echo "Current client: $(/usr/local/bin/ollama --version 2>/dev/null || echo missing)"
echo "Pacman binary:    $($NEW_BIN --version)"

UNIT="/etc/systemd/system/ollama.service"
if grep -q 'ExecStart=/usr/local/bin/ollama' "$UNIT"; then
  sed -i 's|ExecStart=/usr/local/bin/ollama serve|ExecStart=/usr/bin/ollama serve|' "$UNIT"
  echo "Updated $UNIT → ExecStart=/usr/bin/ollama serve"
fi

systemctl daemon-reload
systemctl restart ollama
sleep 2
systemctl is-active ollama
curl -sf http://127.0.0.1:11434/api/tags >/dev/null
echo "Ollama listening on :11434 with $($NEW_BIN --version)"

MODEL="${1:-hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL}"
echo "Pulling $MODEL (skip if already present)…"
sudo -u ollama OLLAMA_HOST=127.0.0.1:11434 "$NEW_BIN" pull "$MODEL"

echo "Tool-calling smoke test…"
curl -sf http://127.0.0.1:11434/v1/chat/completions -d "{
  \"model\":\"$MODEL\",
  \"messages\":[{\"role\":\"user\",\"content\":\"play jazz\"}],
  \"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"play_music\",\"description\":\"Play\",\"parameters\":{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"}},\"required\":[\"query\"]}}}],
  \"tool_choice\":\"auto\"
}" | grep -q play_music && echo "OK: tool_calls work"