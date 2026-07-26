#!/usr/bin/env bash
#
# Safe x86 server deploy (rootless Podman) — pull, build, recreate, verify.
#
# Usage:
#   ./scripts/deploy-server.sh                    # pull + build bot + recreate + verify
#   ./scripts/deploy-server.sh --verify           # post-deploy checks only
#   ./scripts/deploy-server.sh --no-pull          # deploy the tree as-is on the host
#   ./scripts/deploy-server.sh --no-build         # recreate without rebuilding
#   ./scripts/deploy-server.sh --services bot,stt-whisper
#
# Environment:
#   DEPLOY_HOST      (default allie@192.168.1.89)
#   DEPLOY_PATH      (default /media/storage/moneypenny)
#   DEPLOY_SSH_OPTS  (default -o ClearAllForwardings=yes -o ConnectTimeout=20)
#
# Why this script exists — three podman-compose behaviours that silently
# produce a WRONG but running deployment if you drive it by hand:
#
#   1. COMPOSE_FILE in .env is NOT honoured. A bare `docker compose up -d`
#      drops the rootless overlay, and the bot comes back on bridge networking
#      with BIND_ADDRESS=0.0.0.0 — publishing the admin UI on every LAN
#      interface. This script always passes all three -f flags explicitly.
#   2. `up` RESTARTS an existing stopped container instead of recreating it, so
#      an environment change appears to deploy while the old env is still live.
#      This script removes the container first.
#   3. podman-compose has no `rm` subcommand, so `compose rm` errors out.
#      Use `podman rm -f <name>`.
#
# It then ASSERTS the outcome rather than trusting exit codes, because the
# failure mode above is a healthy container running the wrong config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Capture the caller's overrides BEFORE sourcing: deploy-common.sh assigns Pi
# defaults (dietpi@opi5) at source time, so a `${DEPLOY_HOST:-...}` afterwards
# would silently inherit the decommissioned Pi instead of the x86 server.
_caller_host="${DEPLOY_HOST:-}"
_caller_path="${DEPLOY_PATH:-}"
_caller_ssh="${DEPLOY_SSH_OPTS:-}"

# shellcheck source=scripts/lib/deploy-common.sh
source "$ROOT/scripts/lib/deploy-common.sh"

DEPLOY_HOST="${_caller_host:-allie@192.168.1.89}"
DEPLOY_PATH="${_caller_path:-/media/storage/moneypenny}"
DEPLOY_SSH_OPTS="${_caller_ssh:--o ClearAllForwardings=yes -o ConnectTimeout=20}"

# The overlay MUST come last so its host-network/bind settings win.
COMPOSE_FLAGS='-f docker-compose.yml -f docker-compose.server.yml -f docker-compose.rootless-fix.yml'

VERIFY_ONLY=0
NO_PULL=0
NO_BUILD=0
SERVICES="bot"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) VERIFY_ONLY=1 ;;
    --no-pull) NO_PULL=1 ;;
    --no-build) NO_BUILD=1 ;;
    --services) SERVICES="${2:?--services needs a comma list}"; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) _deploy_die "unknown argument: $1" ;;
  esac
  shift
done

# The remote login shell is fish; wrap everything so we get bash semantics.
remote() {
  # shellcheck disable=SC2086  # DEPLOY_SSH_OPTS holds several flags; splitting is intended.
  ssh $DEPLOY_SSH_OPTS "$DEPLOY_HOST" bash -lc "$(printf '%q' "cd $DEPLOY_PATH && $*")"
}

verify() {
  local fail=0

  # 1. The regression this script exists to prevent. Under host networking the
  #    admin UI must be on loopback; 0.0.0.0 means the overlay was dropped.
  local bind
  bind="$(remote "ss -tlnp 2>/dev/null | grep ':3000 ' | awk '{print \$4}' | head -1")" || true
  if [[ "$bind" == 127.0.0.1:3000 ]]; then
    _deploy_ok "admin UI bound to loopback ($bind)"
  else
    _deploy_warn "admin UI bound to '${bind:-<nothing>}' — expected 127.0.0.1:3000."
    _deploy_warn "The rootless overlay was probably dropped (see note 1 in this script)."
    fail=1
  fi

  # 2. Health endpoint. Assert on the payload, not just a 200.
  local health
  health="$(remote "curl -s --max-time 10 http://127.0.0.1:3000/api/health")" || true
  if [[ "$health" == *'"status":"ok"'* ]]; then
    _deploy_ok "bot health ok"
  else
    _deploy_warn "bot health did not report ok: ${health:-<no response>}"
    fail=1
  fi
  case "$health" in
    *'"native":true'*) _deploy_ok "opus native codec loaded" ;;
    *) _deploy_warn "opus native codec NOT loaded — the bot cannot emit audio"; fail=1 ;;
  esac

  # 3. TeamSpeak. A bot that is up but not connected looks identical to success
  #    from the health endpoint alone.
  if remote "docker logs moneypenny_bot_1 2>&1 | tail -200 | grep -qa 'connected to server'"; then
    _deploy_ok "connected to TeamSpeak"
  else
    _deploy_warn "no 'connected to server' in recent bot logs"
    fail=1
  fi

  # 4. STT sidecar — voice is silently dead without it.
  local stt
  stt="$(remote "curl -s --max-time 10 http://127.0.0.1:9000/health")" || true
  if [[ "$stt" == *'"modelLoaded": true'* || "$stt" == *'"modelLoaded":true'* ]]; then
    _deploy_ok "STT model loaded ($(sed -n 's/.*"model": *"\([^"]*\)".*/\1/p' <<<"$stt"))"
  else
    _deploy_warn "STT model not loaded: ${stt:-<no response>}"
    fail=1
  fi

  [[ $fail -eq 0 ]] || _deploy_die "verification FAILED — see warnings above"
  _deploy_ok "all post-deploy checks passed"
}

if [[ $VERIFY_ONLY -eq 1 ]]; then
  verify
  exit 0
fi

echo "==> Deploying to $DEPLOY_HOST:$DEPLOY_PATH (services: $SERVICES)"

if [[ $NO_PULL -eq 0 ]]; then
  echo "==> git pull"
  # Deliberately NOT piped to tail: a pipeline reports the LAST command's exit
  # status, which would mask a failed pull as success.
  remote "git pull --ff-only"
  remote "git log --oneline -1"
  dirty="$(remote "git status --porcelain | wc -l")"
  [[ "$dirty" == "0" ]] || _deploy_warn "$dirty uncommitted change(s) on the host — deploying them as-is"
fi

IFS=',' read -r -a svc_list <<< "$SERVICES"

if [[ $NO_BUILD -eq 0 ]]; then
  echo "==> build: ${svc_list[*]}"
  remote "docker compose $COMPOSE_FLAGS build ${svc_list[*]}"
fi

echo "==> recreate: ${svc_list[*]}"
for svc in "${svc_list[@]}"; do
  # See note 2/3: remove first, or `up` silently restarts the old container
  # with the old environment.
  remote "podman rm -f moneypenny_${svc}_1 >/dev/null 2>&1 || true"
done
remote "docker compose $COMPOSE_FLAGS up -d ${svc_list[*]}"

echo "==> waiting for the bot to settle"
remote "for i in \$(seq 1 30); do curl -sf --max-time 5 http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 3; done"

verify
