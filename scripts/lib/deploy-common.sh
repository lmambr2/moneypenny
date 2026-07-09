#!/usr/bin/env bash
# Shared helpers for deploy-preflight.sh, deploy-to-pi.sh, verify-pi-deploy.sh.
# Source this file; do not execute directly.

: "${DEPLOY_HOST:=dietpi@opi5}"
: "${DEPLOY_PATH:=/home/dietpi/moneypenny}"
: "${DEPLOY_SSH_OPTS:=-o ClearAllForwardings=yes}"

# Commands that exist only in the production fork — missing in built dist = bad deploy.
DEPLOY_CRITICAL_COMMANDS=(
  chevron7 playnext radio kg diary forget moveclient
)

# Source files that must exist before rsync (truncated-tree detector).
DEPLOY_CRITICAL_SOURCE_PATHS=(
  bot/src/bot/commands.ts
  bot/src/music/local.ts
  bot/src/rights/index.ts
  bot/src/radio/analyzer.ts
  bot/src/bot/voice/session.ts
  services/stt-rknn/server.py
  services/piper-tts/server.py
  scripts/rights-rank-gating.json
  docker-compose.yml
  docker-compose.sbc.yml
  docs/voice-backends.md
)

_deploy_die() {
  echo "deploy: $*" >&2
  exit 1
}

_deploy_ok() {
  echo "OK: $*"
}

_deploy_warn() {
  echo "WARN: $*" >&2
}

_deploy_root() {
  local script="${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}"
  while [[ -L "$script" ]]; do
    script="$(readlink "$script")"
  done
  cd "$(dirname "$script")/../.." && pwd
}

# Production fork fingerprint — rejects the slim /home/lane/moneypenny tree.
assert_production_fork() {
  local root="$1"
  local cmd_file="$root/bot/src/bot/commands.ts"
  local local_file="$root/bot/src/music/local.ts"

  [[ -d "$root/bot" ]] || _deploy_die "not a moneypenny repo: missing bot/ under $root"

  for rel in "${DEPLOY_CRITICAL_SOURCE_PATHS[@]}"; do
    [[ -f "$root/$rel" ]] || _deploy_die "production tree incomplete: missing $rel"
  done

  for marker in "${DEPLOY_CRITICAL_COMMANDS[@]}"; do
    grep -q "\"${marker}\"" "$cmd_file" \
      || _deploy_die "not production fork: COMMAND_MANIFEST missing \"$marker\" in $cmd_file"
  done

  grep -q 'findSongByVideoId' "$local_file" \
    || _deploy_die "truncated music/local.ts — findSongByVideoId missing (prior bad rsync)"

  if [[ "$root" == "/home/lane/moneypenny" && -d "/home/lane/Projects/moneypenny" ]]; then
    _deploy_die "refusing slim tree $root — deploy from /home/lane/Projects/moneypenny"
  fi
}

# Resolve a user-supplied path to a repo-relative file and reject repo-root landings.
resolve_deploy_relpath() {
  local root="$1"
  local user_path="$2"
  local abs rel

  if [[ "$user_path" = /* ]]; then
    abs="$user_path"
  else
    abs="$root/$user_path"
  fi

  abs="$(cd "$(dirname "$abs")" 2>/dev/null && pwd)/$(basename "$abs")" \
    || _deploy_die "path does not exist: $user_path"

  case "$abs" in
    "$root"/*) rel="${abs#"$root"/}" ;;
    *) _deploy_die "path outside repo: $user_path" ;;
  esac

  [[ -e "$root/$rel" ]] || _deploy_die "missing local path: $rel"
  printf '%s' "$rel"
}

remote_ssh() {
  ssh $DEPLOY_SSH_OPTS "$DEPLOY_HOST" "$@"
}

remote_rsync() {
  rsync -avz -e "ssh $DEPLOY_SSH_OPTS" "$@"
}