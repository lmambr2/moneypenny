#!/usr/bin/env bash
# Moneypenny — one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/lmambr2/moneypenny/main/install.sh | bash
#   # ...or, from a clone:
#   ./install.sh                 # text-interactive wizard when a TTY is available
#   ./install.sh -y              # non-interactive (auto defaults)
#   ./install.sh --interactive   # force wizard
#
# Two editions (docs/editions.md):
#   sbc    — Orange Pi / RK3588 edge (embeddings + tiny Whisper; chat often LAN)
#   server — x86_64 (local 12B chat + server Whisper ladder)
#
# Idempotent. Flags set defaults / skip wizard when -y is used.

set -euo pipefail

REPO_URL="${MONEYPENNY_REPO:-https://github.com/lmambr2/moneypenny.git}"
RAW_BASE="https://raw.githubusercontent.com/lmambr2/moneypenny"

# ── defaults / flags ─────────────────────────────────────────────────────────
EDITION="auto"; LLM="auto"; MODEL=""; INSTALL_DIR="moneypenny"; BRANCH="main"
WITH_VOICE=0; WITH_SERVER=0; WITH_RAG=0; WITH_MEMORY=0; NO_BUILD=0; ASSUME_YES=0
VOICE_PROFILE=""
# interactive: auto = wizard on TTY unless -y; 1 = force; 0 = never
INTERACTIVE="auto"
# Track CLI so the wizard can skip questions the user already answered.
FLAG_EDITION=0; FLAG_LLM=0; FLAG_MODEL=0
FLAG_VOICE=0; FLAG_RAG=0; FLAG_SERVER=0; FLAG_MEMORY=0

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

  ./install.sh                 # interactive wizard (TTY)
  ./install.sh -y              # non-interactive auto defaults
  curl … | bash                # interactive if a TTY is attached

Two editions (docs/editions.md):
  sbc    — RK3588 / Orange Pi edge (Whisper base NPU, E2B fallback, RAG on-device)
  server — x86_64 (Gemma 4 12B local, Whisper medium|large-v3)

Usage: ./install.sh [options]
  --interactive                force the text wizard
  --non-interactive, -y        no prompts; use flags + auto defaults
  --edition <sbc|server|auto>  Product edition (default: auto)
  --llm <npu|ollama|mock|URL>  LLM backend (default: ollama; npu opt-in on SBC)
  --model <name>               LLM model (sbc: E2B GGUF; server: 12B QAT; npu: npu-llm)
  --with-voice                 Whisper+Piper by edition (edge/server)
  --with-voice-edge            force Pi Whisper base (RKNN NPU) + piper
  --with-voice-server          force x86 Whisper medium + piper
  --with-server                also start a TeamSpeak 6 server container
  --with-rag                   Qdrant + embedding model (knowledge base)
  --no-rag                     disable RAG (non-interactive / wizard default override)
  --with-memory                MemPalace bridge (Phase 7 semantic memory + KG)
  --no-memory                  disable MemPalace profile
  --no-voice                   disable voice
  --dir <path>                 install dir when bootstrapping (default: ./moneypenny)
  --branch <name>              git branch to clone (default: main)
  --no-build                   don't rebuild images
  -h, --help                   show this help
EOF
}

NO_RAG=0; NO_VOICE=0; NO_MEMORY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --interactive) INTERACTIVE=1 ;;
    --non-interactive) INTERACTIVE=0; ASSUME_YES=1 ;;
    --edition) EDITION="${2:?}"; FLAG_EDITION=1; shift ;;
    --llm) LLM="${2:?}"; FLAG_LLM=1; shift ;;
    --model) MODEL="${2:?}"; FLAG_MODEL=1; shift ;;
    --with-voice) WITH_VOICE=1; FLAG_VOICE=1; NO_VOICE=0 ;;
    --with-voice-edge) WITH_VOICE=1; VOICE_PROFILE=edge; FLAG_VOICE=1; NO_VOICE=0 ;;
    --with-voice-server) WITH_VOICE=1; VOICE_PROFILE=server; FLAG_VOICE=1; NO_VOICE=0 ;;
    --with-voice-legacy)
      die "--with-voice-legacy was removed (V2). Use --with-voice / --with-voice-edge / --with-voice-server (Whisper+Piper)."
      ;;
    --no-voice) WITH_VOICE=0; FLAG_VOICE=1; NO_VOICE=1 ;;
    --with-server) WITH_SERVER=1; FLAG_SERVER=1 ;;
    --with-rag) WITH_RAG=1; FLAG_RAG=1; NO_RAG=0 ;;
    --no-rag) WITH_RAG=0; FLAG_RAG=1; NO_RAG=1 ;;
    --with-memory) WITH_MEMORY=1; FLAG_MEMORY=1; NO_MEMORY=0 ;;
    --no-memory) WITH_MEMORY=0; FLAG_MEMORY=1; NO_MEMORY=1 ;;
    --dir) INSTALL_DIR="${2:?}"; shift ;;
    --branch) BRANCH="${2:?}"; shift ;;
    --no-build) NO_BUILD=1 ;;
    -y|--yes) ASSUME_YES=1; INTERACTIVE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# I/O that works when piped via curl|bash (reads/writes /dev/tty when present).
_prompt() {
  if [ -e /dev/tty ]; then printf '%s' "$*" > /dev/tty; else printf '%s' "$*"; fi
}
_echo_tty() {
  if [ -e /dev/tty ]; then echo "$@" > /dev/tty; else echo "$@"; fi
}

# confirm "question" [default_yes=1]
confirm() {
  local q="$1" def="${2:-1}" ans
  [ "$ASSUME_YES" -eq 1 ] && return 0
  if [ -e /dev/tty ]; then
    printf '%s %s ' "$q" "$([ "$def" -eq 1 ] && echo '[Y/n]' || echo '[y/N]')" > /dev/tty
    read -r ans < /dev/tty || ans=""
  elif [ -t 0 ]; then
    printf '%s %s ' "$q" "$([ "$def" -eq 1 ] && echo '[Y/n]' || echo '[y/N]')"
    read -r ans || ans=""
  else
    ans=""
  fi
  ans="${ans:-$([ "$def" -eq 1 ] && echo y || echo n)}"
  [[ "$ans" =~ ^[Yy] ]]
}

# ask_line "prompt" "default" → sets REPLY
ask_line() {
  local q="$1" def="${2:-}" ans
  if [ -n "$def" ]; then
    _prompt "${q} [${def}]: "
  else
    _prompt "${q}: "
  fi
  if [ -e /dev/tty ]; then
    read -r ans < /dev/tty || ans=""
  elif [ -t 0 ]; then
    read -r ans || ans=""
  else
    ans=""
  fi
  REPLY="${ans:-$def}"
}

# ask_menu "prompt" default_index item1 item2 ... → sets REPLY to 1-based index
ask_menu() {
  local q="$1" def="$2"; shift 2
  local items=("$@") n=${#items[@]} i ans
  _echo_tty ""
  _echo_tty "${c_b}${q}${c_0}"
  for i in "${!items[@]}"; do
    local mark=" "
    [ "$((i + 1))" -eq "$def" ] && mark="*"
    _echo_tty "  ${mark} $((i + 1))) ${items[$i]}"
  done
  _prompt "  Choice [1-${n}] (default ${def}): "
  if [ -e /dev/tty ]; then
    read -r ans < /dev/tty || ans=""
  elif [ -t 0 ]; then
    read -r ans || ans=""
  else
    ans=""
  fi
  ans="${ans:-$def}"
  if ! [[ "$ans" =~ ^[0-9]+$ ]] || [ "$ans" -lt 1 ] || [ "$ans" -gt "$n" ]; then
    warn "Invalid choice — using ${def}."
    ans="$def"
  fi
  REPLY="$ans"
}

have() { command -v "$1" >/dev/null 2>&1; }

# True if we should run the text wizard.
want_interactive() {
  [ "$ASSUME_YES" -eq 1 ] && return 1
  [ "$INTERACTIVE" = "0" ] && return 1
  [ "$INTERACTIVE" = "1" ] && return 0
  # auto: need a controlling TTY (stdout or /dev/tty)
  [ -t 0 ] || [ -t 1 ] || [ -e /dev/tty ]
}

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

# ── 2. detect hardware ───────────────────────────────────────────────────────
ARCH="$(uname -m)"
# On RK3588 vendor kernels the NPU is a DRM render node (fdab0000.npu).
HAS_NPU=0; { [ -e /dev/rknpu ] || [ -e /sys/class/devfreq/fdab0000.npu ]; } && HAS_NPU=1
HAS_NVIDIA=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  HAS_NVIDIA=1
fi
HAS_AMD=0
if command -v rocm-smi >/dev/null 2>&1 || [ -e /dev/kfd ]; then
  HAS_AMD=1
fi

# Suggested edition from hardware (before wizard).
SUGGESTED_EDITION="server"
if [ -x ./scripts/detect-edition.sh ]; then
  SUGGESTED_EDITION="$(./scripts/detect-edition.sh | awk -F= '/^edition=/{print $2; exit}')"
else
  case "$ARCH" in aarch64|arm64) SUGGESTED_EDITION=sbc ;; *) SUGGESTED_EDITION=server ;; esac
fi
[ -n "$SUGGESTED_EDITION" ] || SUGGESTED_EDITION=server

say "Host: arch=${c_b}${ARCH}${c_0}$([ "$HAS_NPU" -eq 1 ] && echo ' · RK3588 NPU')$([ "$HAS_NVIDIA" -eq 1 ] && echo ' · NVIDIA')$([ "$HAS_AMD" -eq 1 ] && echo ' · AMD/ROCm')"
say "Suggested edition: ${c_b}${SUGGESTED_EDITION}${c_0}  (docs/editions.md)"
if [ "$HAS_AMD" -eq 1 ] && [ -x ./scripts/detect-gpu.sh ]; then
  say "AMD tip: prefer ${c_b}host Ollama${c_0} for 12B chat + whisper.cpp Vulkan STT (docs/gpu-amd.md)"
fi

# ── 2b. text-interactive wizard (TTY) ────────────────────────────────────────
run_wizard() {
  _echo_tty ""
  _echo_tty "${c_b}┌─ Interactive setup ───────────────────────────────────────┐${c_0}"
  _echo_tty "${c_b}│${c_0} Answer with a number or Y/n. Enter accepts the default.  ${c_b}│${c_0}"
  _echo_tty "${c_b}│${c_0} Flags you already passed are kept and not re-asked.      ${c_b}│${c_0}"
  _echo_tty "${c_b}└───────────────────────────────────────────────────────────┘${c_0}"

  # Edition
  if [ "$FLAG_EDITION" -eq 0 ]; then
    local ed_def=1
    [ "$SUGGESTED_EDITION" = "server" ] && ed_def=2
    ask_menu "Which edition is this host?" "$ed_def" \
      "SBC — Orange Pi / RK3588 edge (embed + tiny Whisper; chat often on LAN)" \
      "Server — x86 chat host / all-in-one (Gemma 12B + server Whisper)" \
      "Auto-detect (${SUGGESTED_EDITION})"
    case "$REPLY" in
      1) EDITION=sbc ;;
      2) EDITION=server ;;
      3) EDITION="$SUGGESTED_EDITION" ;;
    esac
  fi

  # Resolve edition string for later questions
  local ed_now="$EDITION"
  [ "$ed_now" = "auto" ] && ed_now="$SUGGESTED_EDITION"

  # LLM
  if [ "$FLAG_LLM" -eq 0 ]; then
    local llm_keys=() llm_labels=()
    llm_keys+=(ollama);  llm_labels+=("Ollama on this host (default — E2B on SBC, 12B on Server)")
    llm_keys+=(external); llm_labels+=("External / LAN Ollama URL (split-brain — recommended for SBC)")
    if [ "$HAS_NPU" -eq 1 ] || [ "$ed_now" = "sbc" ]; then
      llm_keys+=(npu); llm_labels+=("NPU rkllama offline (opt-in; not day-to-day chat)")
    fi
    llm_keys+=(mock); llm_labels+=("Mock LLM (no real AI — smoke tests only)")
    local llm_def=1
    [ "$ed_now" = "sbc" ] && llm_def=2   # prefer split-brain on SBC
    ask_menu "Chat LLM backend?" "$llm_def" "${llm_labels[@]}"
    local llm_choice="${llm_keys[$((REPLY - 1))]}"
    case "$llm_choice" in
      ollama) LLM=ollama ;;
      external)
        ask_line "LAN Ollama base URL (no trailing path)" "http://192.168.1.10:11434"
        LLM="$REPLY"
        if [ "$FLAG_MODEL" -eq 0 ]; then
          ask_line "Remote model name" "hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL"
          MODEL="$REPLY"
          FLAG_MODEL=1
        fi
        ;;
      npu) LLM=npu ;;
      mock) LLM=mock ;;
    esac
  fi

  # Optional model override for local ollama
  if [ "$FLAG_MODEL" -eq 0 ] && [ "$LLM" = "ollama" ]; then
    local def_model
    if [ "$ed_now" = "server" ]; then
      def_model="hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL"
    else
      def_model="hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL"
    fi
    if confirm "Use default model (${def_model})?" 1; then
      MODEL="$def_model"
    else
      ask_line "Ollama model name" "$def_model"
      MODEL="$REPLY"
    fi
  fi

  # RAG
  if [ "$FLAG_RAG" -eq 0 ]; then
    if confirm "Enable knowledge base / RAG (TurboVec + nomic-embed-text-v2-moe)?" 1; then
      WITH_RAG=1
    else
      WITH_RAG=0
    fi
  fi

  # Voice
  if [ "$FLAG_VOICE" -eq 0 ]; then
    if confirm "Enable voice (Whisper STT + Piper British TTS)?" 1; then
      WITH_VOICE=1
      if [ "$ed_now" = "sbc" ]; then
        VOICE_PROFILE=edge
      else
        VOICE_PROFILE=server
      fi
      # Optional profile override
      if confirm "Use recommended voice profile for this edition (${VOICE_PROFILE})?" 1; then
        :
      else
        ask_menu "Voice profile?" 1 \
          "edge — Whisper base NPU (SBC/ARM)" \
          "server — Whisper medium + Piper (x86/AMD)"
        case "$REPLY" in
          1) VOICE_PROFILE=edge ;;
          2) VOICE_PROFILE=server ;;
        esac
      fi
    else
      WITH_VOICE=0
    fi
  fi

  # MemPalace (Phase 7)
  if [ "$FLAG_MEMORY" -eq 0 ]; then
    if confirm "Enable MemPalace (per-user memory + org knowledge graph sidecar)?" 1; then
      WITH_MEMORY=1
    else
      WITH_MEMORY=0
    fi
  fi

  # Optional TS6 container
  if [ "$FLAG_SERVER" -eq 0 ]; then
    if confirm "Also start a TeamSpeak 6 server container? (skip if you already have TS6)" 0; then
      WITH_SERVER=1
    else
      WITH_SERVER=0
    fi
  fi

  # Summary + confirm
  _echo_tty ""
  _echo_tty "${c_b}── Plan ────────────────────────────────────────────────────${c_0}"
  _echo_tty "  Edition:  ${EDITION}"
  _echo_tty "  LLM:      ${LLM}${MODEL:+  model=${MODEL}}"
  _echo_tty "  RAG:      $([ "$WITH_RAG" -eq 1 ] && echo yes || echo no)"
  _echo_tty "  Memory:   $([ "$WITH_MEMORY" -eq 1 ] && echo yes || echo no)"
  _echo_tty "  Voice:    $([ "$WITH_VOICE" -eq 1 ] && echo "yes (${VOICE_PROFILE:-auto})" || echo no)"
  _echo_tty "  TS6 ctr:  $([ "$WITH_SERVER" -eq 1 ] && echo yes || echo no)"
  _echo_tty "  Build:    $([ "$NO_BUILD" -eq 1 ] && echo 'use existing images' || echo 'build images')"
  _echo_tty "${c_b}────────────────────────────────────────────────────────────${c_0}"
  if ! confirm "Proceed with this plan?" 1; then
    die "Aborted by user."
  fi
  ok "Wizard complete"
}

if want_interactive; then
  run_wizard
else
  say "Non-interactive mode (use --interactive for the wizard, or run from a TTY)."
  # Opinionated defaults when -y and user did not pass feature flags:
  # keep historical behaviour (no rag/voice unless asked), except edition auto.
  :
fi

# Resolve edition (sbc | server).
if [ "$EDITION" = "auto" ]; then
  EDITION="$SUGGESTED_EDITION"
fi
case "$EDITION" in
  sbc|server) ;;
  *) die "Invalid --edition '$EDITION' (use sbc|server|auto)" ;;
esac
say "Edition: ${c_b}${EDITION}${c_0}"

# Compose multi-file: base + edition overlay (+ npu if selected later).
COMPOSE_FILES=(-f docker-compose.yml)
case "$EDITION" in
  sbc)    COMPOSE_FILES+=(-f docker-compose.sbc.yml) ;;
  server) COMPOSE_FILES+=(-f docker-compose.server.yml) ;;
esac

if [ "$LLM" = "auto" ]; then
  # Ollama is the default on both editions. NPU is opt-in (--llm npu).
  LLM="ollama"
fi

LLM_URL=""; PROFILES=("core")
case "$LLM" in
  npu)
    [ "$ARCH" = "aarch64" ] || warn "LLM 'npu' selected on ${ARCH}; the RK3588 NPU is aarch64-only."
    [ "$EDITION" = "sbc" ] || warn "NPU LLM on edition=${EDITION} is unusual; sbc is the intended host."
    : "${MODEL:=npu-llm}"; LLM_URL="http://rkllama:8080"
    PROFILES+=("npu"); COMPOSE_FILES+=(-f docker-compose.npu.yml)
    say "LLM backend: ${c_b}rkllama (native NPU)${c_0}, model ${MODEL}" ;;
  mock)
    : "${MODEL:=mock}"; LLM_URL="http://rkllama:8080"; PROFILES+=("npu")
    [ "$EDITION" = "sbc" ] && COMPOSE_FILES+=(-f docker-compose.npu.yml)
    say "LLM backend: ${c_b}rkllama (mock — no real AI)${c_0}" ;;
  ollama)
    if [ -z "$MODEL" ]; then
      if [ "$EDITION" = "server" ]; then
        MODEL="hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL"
      else
        MODEL="hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL"
      fi
    fi
    LLM_URL="http://ollama:11434"; PROFILES+=("ollama")
    say "LLM backend: ${c_b}Ollama${c_0}, model ${MODEL}" ;;
  http://*|https://*)
    LLM_URL="$LLM"
    : "${MODEL:=hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL}"
    if [ "$EDITION" = "sbc" ]; then
      PROFILES+=("ollama")
    fi
    say "LLM backend: ${c_b}external${c_0} ($LLM_URL), model ${MODEL}"; LLM="external" ;;
  *) die "Invalid --llm '$LLM' (use npu|ollama|mock|http(s)://URL)" ;;
esac
if [ "$WITH_VOICE" -eq 1 ]; then
  if [ -z "$VOICE_PROFILE" ]; then
    case "$EDITION" in
      sbc) VOICE_PROFILE=edge ;;
      *)   VOICE_PROFILE=server ;;
    esac
  fi
  case "$VOICE_PROFILE" in
    edge)
      PROFILES+=("voice-edge")
      # Validated default: Whisper base on RK3588 NPU (RKNN). Falls back to
      # faster-whisper CPU if .rknn weights are missing (STT_FALLBACK).
      : "${STT_MODEL:=base}"
      : "${STT_DEVICE:=npu}"
      : "${STT_BACKEND:=rknn}"
      say "Voice: ${c_b}edge${c_0} (Whisper ${STT_MODEL} via RKNN NPU + piper; CPU fallback if no .rknn)"
      ;;
    server)
      PROFILES+=("voice-server")
      : "${STT_BACKEND:=whisper-cpp}"
      if [ "$HAS_AMD" -eq 1 ]; then
        : "${STT_MODEL:=large-v3-turbo}"
        : "${STT_DEVICE:=vulkan}"
        : "${WHISPER_VULKAN:=1}"
        say "Voice: ${c_b}server${c_0} (whisper.cpp Vulkan, model=${STT_MODEL} + piper; AMD)"
      elif [ "$HAS_NVIDIA" -eq 1 ]; then
        : "${STT_MODEL:=large-v3-turbo}"
        : "${STT_DEVICE:=cuda}"
        say "Voice: ${c_b}server${c_0} (whisper.cpp, model=${STT_MODEL}; NVIDIA untested)"
      else
        : "${STT_MODEL:=medium}"
        : "${STT_DEVICE:=cpu}"
        say "Voice: ${c_b}server${c_0} (whisper.cpp CPU, model=${STT_MODEL} + piper)"
      fi
      ;;
    legacy)
      die "VOICE_PROFILE=legacy was removed (V2). Use edge or server (Whisper+Piper)."
      ;;
    *) die "Invalid VOICE_PROFILE '$VOICE_PROFILE' (edge|server)" ;;
  esac
fi
[ "$WITH_SERVER" -eq 1 ] && PROFILES+=("server")
if [ "$WITH_RAG" -eq 1 ]; then
  PROFILES+=("rag")
  if [ -z "${EMBED_MODEL:-}" ]; then
    if [ "$EDITION" = "server" ]; then
      EMBED_MODEL="bge-large-en-v1.5"
    else
      EMBED_MODEL="nomic-embed-text-v2-moe"
    fi
  fi
  if [ "$LLM" = "external" ] && [[ ! " ${PROFILES[*]} " =~ " ollama " ]]; then
    PROFILES+=("ollama")
  fi
  say "RAG: ${c_b}TurboVec${c_0} + embedding model ${EMBED_MODEL}"
fi
if [ "$WITH_MEMORY" -eq 1 ]; then
  PROFILES+=("memory")
  say "Memory: ${c_b}MemPalace bridge${c_0} (enable toggles in Settings after first boot)"
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

# ── 5. .env (create from edition template; ensure session secret + LLM vars) ──
if [ ! -f .env ]; then
  if [ -f ".env.example.${EDITION}" ]; then
    cp ".env.example.${EDITION}" .env
    ok "Created .env from .env.example.${EDITION}"
  else
    cp .env.example .env
    ok "Created .env from .env.example"
  fi
fi
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
set_env MONEYPENNY_EDITION "$EDITION"
set_env RKLLAMA_URL "$LLM_URL"
set_env RKLLAMA_MODEL "$MODEL"
# Persist compose multi-file + profiles so bare `docker compose up -d` works.
COMPOSE_FILE_VAL="docker-compose.yml"
case "$EDITION" in
  sbc)    COMPOSE_FILE_VAL="docker-compose.yml:docker-compose.sbc.yml" ;;
  server) COMPOSE_FILE_VAL="docker-compose.yml:docker-compose.server.yml" ;;
esac
# Include npu overlay in COMPOSE_FILE when selected.
if [[ " ${PROFILES[*]} " =~ " npu " ]] && [ -f docker-compose.npu.yml ]; then
  COMPOSE_FILE_VAL="${COMPOSE_FILE_VAL}:docker-compose.npu.yml"
fi
set_env COMPOSE_FILE "$COMPOSE_FILE_VAL"
set_env COMPOSE_PROFILES "$(IFS=,; echo "${PROFILES[*]}")"
if [ "$WITH_RAG" -eq 1 ]; then
  set_env VECTOR_DB_URL "http://turbovec:6333"
  set_env EMBEDDING_MODEL "$EMBED_MODEL"
  if [ "$EDITION" = "sbc" ]; then
    set_env EMBEDDING_URL "http://ollama:11434"
    set_env EMBEDDING_TIMEOUT_MS "600000"
  else
    set_env EMBEDDING_URL "http://ollama:11434"
  fi
fi
if [ "$WITH_MEMORY" -eq 1 ]; then
  set_env MEMPALACE_URL "http://mempalace-bridge:8090"
fi
if [ "$WITH_VOICE" -eq 1 ] && [ "$VOICE_PROFILE" != "legacy" ]; then
  set_env STT_URL "http://stt-whisper:9000"
  set_env TTS_URL "http://piper-tts:8880"
  # STT_* already set above by VOICE_PROFILE (edge → base/npu/rknn; server → medium/…).
  if [ "${VOICE_PROFILE}" = "edge" ]; then
    set_env STT_MODEL "${STT_MODEL:-base}"
    set_env STT_DEVICE "${STT_DEVICE:-npu}"
    set_env STT_BACKEND "${STT_BACKEND:-rknn}"
    set_env STT_FALLBACK "faster-whisper"
    set_env RKNN_MODELS_DIR "/models/rknn"
  else
    set_env STT_MODEL "${STT_MODEL:-large-v3-turbo}"
    set_env STT_DEVICE "${STT_DEVICE:-vulkan}"
    set_env STT_BACKEND "${STT_BACKEND:-whisper-cpp}"
    if [ "${STT_BACKEND}" = "whisper-cpp" ]; then
      set_env WHISPER_VULKAN "${WHISPER_VULKAN:-1}"
    fi
  fi
  if [ "${VOICE_PROFILE}" = "edge" ]; then
    set_env PIPER_VOICE "en_GB-cori-medium"
    set_env PIPER_MODEL "/models/en_GB-cori-medium.onnx"
  else
    set_env PIPER_VOICE "en_GB-cori-high"
    set_env PIPER_MODEL "/models/en_GB-cori-high.onnx"
  fi
fi
[ "$LLM" = "npu" ] && set_env RKLLM_BACKEND native
# Default the music library to a local, writable folder. Respect a real custom
# value, but replace the template placeholder (/mnt/music) most hosts won't have.
cur_music="$(grep -E '^MUSIC_DIR=' .env | head -1 | cut -d= -f2- || true)"
if [ -z "$cur_music" ] || [ "$cur_music" = "/mnt/music" ]; then set_env MUSIC_DIR "./music"; fi
ok "Configured .env (edition=$EDITION, LLM=$LLM_URL, model=$MODEL)"

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
    # Also run one-shot pull service when defined (idempotent).
    dc --profile ollama --profile rag run --rm ollama-embed-pull 2>/dev/null \
      || true
  fi
fi

# ── 9. done ──────────────────────────────────────────────────────────────────
echo
echo "${c_g}${c_b}Moneypenny is up.${c_0}  edition=${c_b}${EDITION}${c_0}"
echo "  ${c_b}Web UI:${c_0} http://localhost:3000   ${c_d}(localhost-only by default)${c_0}"
echo "  ${c_d}First run: open the UI, create the admin account, add your TS6 server + a bot.${c_0}"
if [ "$EDITION" = "sbc" ] && { [ "$LLM" = "ollama" ] || [ "$LLM" = "external" ]; }; then
  echo "  ${c_d}SBC tip: llmUrl → LAN 12B (e.g. http://192.168.1.89:11434); E2B is offline fallback (docs/remote-llm.md).${c_0}"
fi
if [ "$EDITION" = "server" ] && [ "$HAS_AMD" -eq 1 ]; then
  echo "  ${c_d}AMD: host Ollama for chat; ./scripts/download-whisper-ggml.sh; docs/gpu-amd.md${c_0}"
  echo "  ${c_d}31B analyst: ./scripts/check-analyst-vram.sh then Settings toggle (off by default).${c_0}"
fi
if [ "$WITH_VOICE" -eq 1 ] && [ "${VOICE_PROFILE:-}" != "legacy" ]; then
  echo "  ${c_d}Voice: Settings → voice + textWakeFallback; dual-track STT + piper (docs/voice-backends.md).${c_0}"
  if [ "$EDITION" = "server" ]; then
    echo "  ${c_d}STT models: ./scripts/download-whisper-ggml.sh medium${c_0}"
  else
    echo "  ${c_d}SBC STT: Whisper base on NPU (RKNN). Export: MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh → models/rknn/.${c_0}"
  fi
fi
if [ "$WITH_MEMORY" -eq 1 ]; then
  echo "  ${c_d}Memory: Settings → Per-user memory + MemPalace + Org KG; URL ${MEMPALACE_URL:-http://mempalace-bridge:8090} (docs/memory.md).${c_0}"
  echo "  ${c_d}Smoke: !remember <fact> → !ask about it → !forget all. Analysts: !kg / !diary.${c_0}"
fi
echo
echo "  ${c_d}Logs:${c_0}    docker compose ${COMPOSE_FILES[*]} ${PROFILE_FLAGS[*]} logs -f bot"
echo "  ${c_d}Stop:${c_0}    docker compose ${COMPOSE_FILES[*]} ${PROFILE_FLAGS[*]} down"
echo "  ${c_d}Editions:${c_0} docs/editions.md · ${c_d}AMD:${c_0} docs/gpu-amd.md · ${c_d}TLS:${c_0} DESIGN.md §11"
