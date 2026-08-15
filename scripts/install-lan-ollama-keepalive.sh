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

# Persist the dummy TS6 files bind. /tmp is emptied on reboot and the
# generated bot unit then fails with statfs ... no such file or directory.
TMPFILES_DIR="${HOME}/.config/user-tmpfiles.d"
BOT_DROPIN="${HOME}/.config/systemd/user/container-moneypenny_bot_1.service.d"
install -d "${TMPFILES_DIR}" "${BOT_DROPIN}"
cat >"${TMPFILES_DIR}/moneypenny.conf" <<'EOF'
d /tmp/moneypenny-no-ts-files 0755 - - -
EOF
cat >"${BOT_DROPIN}/mkdir.conf" <<'EOF'
[Service]
ExecStartPre=-/usr/bin/mkdir -p /tmp/moneypenny-no-ts-files
EOF
cat >"${USER_UNIT_DIR}/moneypenny-host-prep.service" <<'EOF'
[Unit]
Description=Create Moneypenny host paths before containers start
Before=container-moneypenny_bot_1.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/mkdir -p /tmp/moneypenny-no-ts-files

[Install]
WantedBy=default.target
EOF
mkdir -p /tmp/moneypenny-no-ts-files
systemd-tmpfiles --user --create "${TMPFILES_DIR}/moneypenny.conf" 2>/dev/null || true

systemctl --user daemon-reload
systemctl --user enable --now moneypenny-host-prep.service
systemctl --user enable --now moneypenny-ollama-keepalive.timer
"${KEEP_SCRIPT}"

echo "User timer active:"
systemctl --user status moneypenny-ollama-keepalive.timer --no-pager || true

OVERRIDE_SRC="${SCRIPT_DIR}/lan-ollama-systemd-override.conf"
if command -v sudo >/dev/null && [[ -f "${OVERRIDE_SRC}" ]]; then
  if sudo -n true 2>/dev/null; then
    sudo -n mkdir -p /etc/systemd/system/ollama.service.d
    sudo -n cp "${OVERRIDE_SRC}" /etc/systemd/system/ollama.service.d/override.conf
    sudo -n systemctl daemon-reload
    sudo -n systemctl restart ollama
    echo "Applied Ollama systemd override (MAX_LOADED_MODELS=1)."
  else
    echo ""
    echo "Need sudo once to cap Ollama at one loaded model:"
    echo "  sudo mkdir -p /etc/systemd/system/ollama.service.d"
    echo "  sudo cp ${OVERRIDE_SRC} /etc/systemd/system/ollama.service.d/override.conf"
    echo "  sudo systemctl daemon-reload && sudo systemctl restart ollama"
  fi
fi
