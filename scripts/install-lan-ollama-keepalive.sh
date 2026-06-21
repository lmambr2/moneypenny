#!/usr/bin/env bash
# Install Ollama keep-alive on a LAN LLM workstation (run ON that host).
# System override needs sudo; user timer works without it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEP_SCRIPT="${HOME}/bin/moneypenny-ollama-keepalive.sh"
USER_UNIT_DIR="${HOME}/.config/systemd/user"

install -d "${HOME}/bin" "${USER_UNIT_DIR}"
install -m 0755 "${SCRIPT_DIR}/lan-ollama-keepalive.sh" "${KEEP_SCRIPT}"
cp -f "${SCRIPT_DIR}/lan-ollama-systemd-override.conf" "${HOME}/bin/moneypenny-ollama-systemd-override.conf" 2>/dev/null || true

cat >"${USER_UNIT_DIR}/moneypenny-ollama-keepalive.service" <<EOF
[Unit]
Description=Refresh Ollama keep_alive for Moneypenny chat model

[Service]
Type=oneshot
ExecStart=${KEEP_SCRIPT}
EOF

cat >"${USER_UNIT_DIR}/moneypenny-ollama-keepalive.timer" <<EOF
[Unit]
Description=Ping Ollama every 4 minutes so the 12B model stays loaded

[Timer]
OnBootSec=30s
OnUnitActiveSec=4min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now moneypenny-ollama-keepalive.timer
"${KEEP_SCRIPT}"

echo "User timer active:"
systemctl --user status moneypenny-ollama-keepalive.timer --no-pager || true

if command -v sudo >/dev/null && [[ -f "${SCRIPT_DIR}/lan-ollama-systemd-override.conf" ]]; then
  echo ""
  echo "Optional (sudo): set server-wide default keep_alive:"
  echo "  sudo mkdir -p /etc/systemd/system/ollama.service.d"
  echo "  sudo cp ${SCRIPT_DIR}/lan-ollama-systemd-override.conf /etc/systemd/system/ollama.service.d/override.conf"
  echo "  sudo systemctl daemon-reload && sudo systemctl restart ollama"
fi