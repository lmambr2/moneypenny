#!/usr/bin/env bash
# Moneypenny — one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/lmambr2/moneypenny/main/install.sh | bash
#   # ...or, from a clone:
#   ./install.sh
#
# Configures an OpenAI-compatible LLM backend. Defaults to Ollama (CPU/GPU),
# pulling a small Gemma model on first run. On the RK3588 the NPU gives ~no
# decode speedup (LLM decode is memory-bandwidth-bound — see ROADMAP), so it is
# opt-in via --llm npu rather than the default.
#
# It is idempotent: re-run any time. Flags below override the auto-detection.
#
# Usage:
#   ./install.sh [options]
#     --llm <npu|ollama|mock|URL>  LLM backend (default: auto by arch)
#     --model <name>               LLM model (default ollama: gemma-4-E2B GGUF; bigger box? gemma4:e4b-it-qat. npu: qwen3-4b-instruct-2507)
#     --with-voice                 also start Kokoro TTS (voice profile)
#     --with-server                also start a TeamSpeak 6 server container
#     --dir <path>                 install dir when bootstrapping (default: ./moneypenny)
#     --branch <name>              git branch to clone (default: main)
#     --no-build                   don't rebuild images (use what's present)
#     -y, --yes                    assume "yes" to all prompts (non-interactive)
#     -h, --help                   show this help

set -euo pipefail

REPO_URL="${MONEYPENNY_REPO:-https://github.com/lmambr2/moneypenny.git}"
RAW_BASE="https://raw.githubusercontent.com/lmambr2/moneypenny"

# ── defaults / flags ─────────────────────────────────────────────────────────
LLM="auto"; MODEL=""; INSTALL_DIR="moneypenny"; BRANCH="main"
WITH_VOICE=0; WITH_SERVER=0; WITH_RAG=0; NO_BUILD=0; ASSUME_YES=0

# ── pretty logging ───────────────────────────────────────────────────────────
if [ -t 1 ]; then
  c_b=$'\033[1m'; c_g=$'\033[32m'; c_y=$'\033[33m'; c_r=$'\033[31m'; c_c=$'\033[36m'; c_d=$'\033[2m'; c_0=$'\033[0m'
else c_b=""; c_g=""; c_y=""; c_r=""; c_c=""; c_d=""; c_0=""; fi
say()  { echo "${c_c}::${c_0} $*"; }
ok()   { echo "${c_g}✓${c_0} $*"; }
warn() { echo "${c_y}!${c_0} $*" >&2; }
die()  { echo "${c_r}✗ $*${c_0}" >&2; exit 1; }

usage() {
  cat <<'EOF'
Moneypenny — one-command installer.

  curl -fsSL https://raw.githubusercontent.com/lmambr2/moneypenny/main/install.sh | bash
  # ...or, from a clone:
  ./install.sh

Auto-detects your architecture and picks an OpenAI-compatible LLM backend:
  aarch64 + RK3588 NPU   -> rkllama (native NPU inference)
  x86-64 / anything else -> Ollama (CPU/GPU), pulls a small model on first run

Idempotent: re-run any time. Flags override the auto-detection.

Usage: ./install.sh [options]
  --llm <npu|ollama|mock|URL>  LLM backend (default: auto by arch)
  --model <name>               LLM model (ollama: gemma4:e4b-it-qat; remote: gemma-4-12B QAT; npu: qwen3-4b only)
  --with-voice                 also start Kokoro TTS (voice profile)
  --with-server                also start a TeamSpeak 6 server container
  --with-rag                   also start Qdrant + pull an embedding model (RAG knowledge base)
  --dir <path>                 install dir when bootstrapping (default: ./moneypenny)
  --branch <name>              git branch to clone (default: main)
  --no-build                   don't rebuild images (use what's present)
  -y, --yes                    assume "yes" to all prompts (non-interactive)
  -h, --help                   show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --llm) LLM="${2:?}"; shift ;;
    --model) MODEL="${2:?}"; shift ;;
    --with-voice) WITH_VOICE=1 ;;
    --with-server) WITH_SERVER=1 ;;
    --with-rag) WITH_RAG=1 ;;
    --dir) INSTALL_DIR="${2:?}"; shift ;;
    --branch) BRANCH="${2:?}"; shift ;;
    --no-build) NO_BUILD=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# Prompt that works even when the script is piped via curl|bash (reads /dev/tty).
confirm() { # confirm "question" [default_yes=1]
  local q="$1" def="${2:-1}" ans
  [ "$ASSUME_YES" -eq 1 ] && return 0
  if [ -e /dev/tty ]; then
    printf '%s %s ' "$q" "$([ "$def" -eq 1 ] && echo '[Y/n]' || echo '[y/N]')" > /dev/tty
    read -r ans < /dev/tty || ans=""
  else
    # No TTY and no --yes: fall back to the default without blocking.
    ans=""
  fi
  ans="${ans:-$([ "$def" -eq 1 ] && echo y || echo n)}"
  [[ "$ans" =~ ^[Yy] ]]
}

have() { command -v "$1" >/dev/null 2>&1; }

echo "${c_b}┌─ Moneypenny installer ────────────────────────────────────┐${c_0}"
echo "${c_b}│${c_0} self-hosted TS6 AI + music assistant                      ${c_b}│${c_0}"
echo "${c_b}└───────────────────────────────────────────────────────────┘${c_0}"

# ── 1. locate (or fetch) the repo ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -d "$SCRIPT_DIR/bot" ]; then
  cd "$SCRIPT_DIR"
  ok "Running inside the Moneypenny repo ($(pwd))"
else
  say "Bootstrapping into ./$INSTALL_DIR"
  have git || die "git is required to fetch Moneypenny. Install git and re-run."
  if [ -d "$INSTALL_DIR/.git" ]; then
    ok "Existing clone found — updating"
    git -C "$INSTALL_DIR" pull --ff-only || warn "git pull failed; continuing with current checkout."
  else
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" \
      || die "git clone failed ($REPO_URL)."
  fi
  cd "$INSTALL_DIR"
fi

# ── 2. detect architecture / NPU and resolve the LLM backend ─────────────────
ARCH="$(uname -m)"
# Informational only now (auto defaults to ollama). On RK3588 vendor kernels the
# NPU isn't /dev/rknpu — it's a DRM render node (fdab0000.npu); detect either.
HAS_NPU=0; { [ -e /dev/rknpu ] || [ -e /sys/class/devfreq/fdab0000.npu ]; } && HAS_NPU=1
say "Architecture: ${c_b}${ARCH}${c_0}$([ "$HAS_NPU" -eq 1 ] && echo ' (RK3588 NPU detected)')"

if [ "$LLM" = "auto" ]; then
  # Default everyone to Ollama. Benchmarks (ROADMAP §Phase 4) showed the RK3588
  # NPU lands at the same ~4.9 tok/s as CPU for a 4B (decode is bandwidth-bound),
  # so the simpler Ollama path is the default; the NPU stays available via
  # --llm npu for those who want it.
  LLM="ollama"
fi

LLM_URL=""; PROFILES=("core"); COMPOSE_FILES=(-f docker-compose.yml)
case "$LLM" in
  npu)
    [ "$ARCH" = "aarch64" ] || warn "LLM 'npu' selected on ${ARCH}; the RK3588 NPU is aarch64-only."
    : "${MODEL:=qwen3-4b-instruct-2507}"; LLM_URL="http://rkllama:8080"
    PROFILES+=("npu"); COMPOSE_FILES+=(-f docker-compose.npu.yml)
    say "LLM backend: ${c_b}rkllama (native NPU)${c_0}, model ${MODEL}" ;;
  mock)
    : "${MODEL:=mock}"; LLM_URL="http://rkllama:8080"; PROFILES+=("npu")
    say "LLM backend: ${c_b}rkllama (mock — no real AI)${c_0}" ;;
  ollama)
    : "${MODEL:=hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL}"; LLM_URL="http://ollama:11434"; PROFILES+=("ollama")
    say "LLM backend: ${c_b}Ollama${c_0}, model ${MODEL}" ;;
  http://*|https://*)
    LLM_URL="$LLM"; : "${MODEL:=hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL}"
    say "LLM backend: ${c_b}external${c_0} ($LLM_URL), model ${MODEL}"; LLM="external" ;;
  *) die "Invalid --llm '$LLM' (use npu|ollama|mock|http(s)://URL)" ;;
esac
[ "$WITH_VOICE" -eq 1 ]  && PROFILES+=("voice")
[ "$WITH_SERVER" -eq 1 ] && PROFILES+=("server")
# RAG (Phase 5): Qdrant + EmbeddingGemma (Gemma-family) on all arches.
if [ "$WITH_RAG" -eq 1 ]; then
  PROFILES+=("rag")
  : "${EMBED_MODEL:=embeddinggemma}"
  say "RAG: ${c_b}Qdrant${c_0} + embedding model ${EMBED_MODEL}"
fi

# ── 3. Docker + Compose ──────────────────────────────────────────────────────
if ! have docker; then
  warn "Docker is not installed."
  if confirm "Install Docker now via the official get.docker.com script (needs sudo)?"; then
    curl -fsSL https://get.docker.com | sudo sh || die "Docker install failed."
    sudo systemctl enable --now docker 2>/dev/null || true
    ok "Docker installed."
  else
    die "Docker is required. Install it, then re-run: https://docs.docker.com/engine/install/"
  fi
fi

# Pick a working docker invocation (with sudo if the daemon isn't reachable as us).
SUDO=""
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1 || sudo docker info >/dev/null 2>&1; then
    SUDO="sudo"; warn "Using sudo for docker (add yourself to the 'docker' group to avoid this)."
  else
    die "Cannot talk to the Docker daemon. Is it running? (sudo systemctl start docker)"
  fi
fi
dc() { $SUDO docker compose "${COMPOSE_FILES[@]}" "$@"; }
$SUDO docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin not found. Install it and re-run."
# Podman and Docker map bind-mount ownership differently (rootless podman remaps
# the container uid into a subuid range) — detect it so the data dir is set up right.
RUNTIME="docker"
if docker --version 2>/dev/null | grep -qi podman || $SUDO docker info 2>/dev/null | grep -qi podman; then RUNTIME="podman"; fi
ok "Container engine: ${RUNTIME} ($($SUDO docker --version | awk '{print $3}' | tr -d ,))"

# ── 4. NPU host setup (native backend only) ──────────────────────────────────
if [ "$LLM" = "npu" ]; then
  if [ -f host-setup/install-npu.sh ]; then
    say "Preparing the NPU host (librkllmrt runtime, udev, governor)…"
    sudo bash host-setup/install-npu.sh || die "NPU host setup failed (see above)."
  else
    warn "host-setup/install-npu.sh missing — skipping; native inference may not work."
  fi
fi

# ── 5. .env (create from template; ensure a real session secret + LLM vars) ──
[ -f .env ] || { cp .env.example .env; ok "Created .env from .env.example"; }
set_env() { # set_env KEY VALUE  — update in place or append
  local k="$1" v="$2"
  if grep -qE "^[#[:space:]]*${k}=" .env; then
    # portable in-place edit
    sed -i.bak -E "s|^[#[:space:]]*${k}=.*|${k}=${v}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}
# Generate a session secret if it's still the placeholder/empty.
if grep -qE '^BOT_SESSION_SECRET=(change-me.*)?$' .env; then
  secret="$( (openssl rand -hex 32 2>/dev/null) || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  set_env BOT_SESSION_SECRET "$secret"; ok "Generated BOT_SESSION_SECRET"
fi
set_env RKLLAMA_URL "$LLM_URL"
set_env RKLLAMA_MODEL "$MODEL"
# Persist active compose profiles so `docker compose up -d` (no flags) restarts
# the same stack after reboot.
set_env COMPOSE_PROFILES "$(IFS=,; echo "${PROFILES[*]}")"
if [ "$WITH_RAG" -eq 1 ]; then
  set_env VECTOR_DB_URL "http://qdrant:6333"
  set_env EMBEDDING_MODEL "$EMBED_MODEL"
fi
[ "$LLM" = "npu" ] && set_env RKLLM_BACKEND native
# Default the music library to a local, writable folder. Respect a real custom
# value, but replace the template placeholder (/mnt/music) most hosts won't have.
cur_music="$(grep -E '^MUSIC_DIR=' .env | head -1 | cut -d= -f2- || true)"
if [ -z "$cur_music" ] || [ "$cur_music" = "/mnt/music" ]; then set_env MUSIC_DIR "./music"; fi
ok "Configured .env (LLM=$LLM_URL, model=$MODEL)"

# ── 6. host directories + permissions ────────────────────────────────────────
mkdir -p models bot/data music/uploads
# The bot runs as uid 1000 inside the container and must own /app/data (the
# bind-mounted bot/data) to write its SQLite DB, config.json, logs, avatars.
if [ "$RUNTIME" = "podman" ] && [ -z "$SUDO" ]; then
  # Rootless podman remaps container uid 1000 to a host subuid — chown inside the
  # user namespace so the container (not the host user) ends up owning it.
  podman unshare chown -R 1000:1000 bot/data 2>/dev/null \
    && ok "bot/data mapped to uid 1000 in the podman user namespace" \
    || warn "podman unshare chown failed — the bot may not be able to write /app/data."
elif [ "$(stat -c %u bot/data 2>/dev/null || echo 0)" != "1000" ]; then
  $SUDO chown -R 1000:1000 bot/data 2>/dev/null \
    && ok "bot/data owned by uid 1000" \
    || warn "Could not chown bot/data to 1000:1000 — the bot may fail to write state."
else
  ok "bot/data already owned by uid 1000"
fi
# Web + file-drop uploads land in music/uploads/ (container /music/uploads).
if [ "$RUNTIME" = "podman" ] && [ -z "$SUDO" ]; then
  podman unshare chown -R 1000:1000 music 2>/dev/null \
    && ok "music/ mapped to uid 1000 in the podman user namespace" \
    || warn "podman unshare chown music/ failed — uploads may fail (ENOENT/EACCES)."
elif [ "$(stat -c %u music 2>/dev/null || echo 0)" != "1000" ]; then
  $SUDO chown -R 1000:1000 music 2>/dev/null \
    && ok "music/ owned by uid 1000" \
    || warn "Could not chown music/ to 1000:1000 — file-drop/web uploads may fail."
fi

# ── 7. build + start ─────────────────────────────────────────────────────────
PROFILE_FLAGS=(); for p in "${PROFILES[@]}"; do PROFILE_FLAGS+=(--profile "$p"); done
say "Starting: profiles [${PROFILES[*]}]$([ "$NO_BUILD" -eq 1 ] && echo '' || echo ' (building images — first run is slow)')"
if [ "$NO_BUILD" -eq 1 ]; then
  dc "${PROFILE_FLAGS[@]}" up -d
else
  dc "${PROFILE_FLAGS[@]}" up -d --build
fi
ok "Containers up."

# ── 8. pull the Ollama model ─────────────────────────────────────────────────
if [ "$LLM" = "ollama" ]; then
  say "Pulling Ollama model '${MODEL}' (first time downloads ~2.6 GB)…"
  for i in 1 2 3 4 5; do
    dc exec -T ollama ollama --version >/dev/null 2>&1 && break
    sleep 3
  done
  if dc exec -T ollama ollama pull "$MODEL"; then
    ok "Model '${MODEL}' ready."
  else
    warn "Model pull didn't complete. Finish it later with:"
    warn "  docker compose --profile ollama exec ollama ollama pull $MODEL"
  fi
  # Embedding model for RAG (served by the same ollama).
  if [ "$WITH_RAG" -eq 1 ]; then
    say "Pulling embedding model '${EMBED_MODEL}'…"
    dc exec -T ollama ollama pull "$EMBED_MODEL" && ok "Embedding model ready." \
      || warn "Pull later: docker compose --profile ollama exec ollama ollama pull $EMBED_MODEL"
  fi
fi

# ── 9. done ──────────────────────────────────────────────────────────────────
echo
echo "${c_g}${c_b}Moneypenny is up.${c_0}"
echo "  ${c_b}Web UI:${c_0} http://localhost:3000   ${c_d}(localhost-only by default)${c_0}"
echo "  ${c_d}First run: open the UI, create the admin account, add your TS6 server + a bot.${c_0}"
echo
echo "  ${c_d}Logs:${c_0}    docker compose ${COMPOSE_FILES[*]} ${PROFILE_FLAGS[*]} logs -f bot"
echo "  ${c_d}Stop:${c_0}    docker compose ${PROFILE_FLAGS[*]} down"
echo "  ${c_d}LAN access + TLS: see DESIGN.md §11 (don't expose :3000 unfirewalled).${c_0}"
