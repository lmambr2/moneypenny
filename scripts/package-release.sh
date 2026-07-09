#!/usr/bin/env bash
# Build source release tarballs for Moneypenny editions (sbc | server | both).
#
#   ./scripts/package-release.sh
#   ./scripts/package-release.sh --edition sbc --version 1.0.0
#   ./scripts/package-release.sh --dry-run
#
# Writes dist/release/moneypenny-<edition>-<ver>.tar.gz + SHA256SUMS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EDITION="both"
VERSION=""
DRY_RUN=0
OUT_DIR="${ROOT}/dist/release"

usage() {
  cat <<'EOF'
Usage: ./scripts/package-release.sh [options]
  --edition <sbc|server|both>  Which package(s) (default: both)
  --version <ver>              Version string (default: git describe)
  --out <dir>                  Output directory (default: dist/release)
  --dry-run                    Validate compose + list files; no tarball
  -h, --help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --edition) EDITION="${2:?}"; shift ;;
    --version) VERSION="${2:?}"; shift ;;
    --out) OUT_DIR="${2:?}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

case "$EDITION" in
  sbc|server|both) ;;
  *) echo "Invalid --edition '$EDITION'" >&2; exit 1 ;;
esac

if [ -z "$VERSION" ]; then
  if git describe --tags --always --dirty 2>/dev/null | grep -q .; then
    VERSION="$(git describe --tags --always --dirty 2>/dev/null)"
  else
    VERSION="0.0.0-dev"
  fi
fi
# Sanitize for filenames
VERSION_SAFE="$(echo "$VERSION" | tr '/ ' '--')"

echo "==> Moneypenny package-release  version=${VERSION}  edition=${EDITION}"

# ── validate compose configs ─────────────────────────────────────────────────
validate_compose() {
  local overlay="$1"
  if ! command -v docker >/dev/null 2>&1; then
    echo "    (docker not available — skip compose config check for $overlay)"
    return 0
  fi
  if docker compose version >/dev/null 2>&1; then
    echo "    compose config: docker-compose.yml + $overlay"
    docker compose -f docker-compose.yml -f "$overlay" config >/dev/null
  else
    echo "    (docker compose v2 missing — skip config check)"
  fi
}

echo "==> Validating edition overlays"
validate_compose docker-compose.sbc.yml
validate_compose docker-compose.server.yml

# Required edition assets
need=(
  docker-compose.yml
  docker-compose.sbc.yml
  docker-compose.server.yml
  .env.example
  .env.example.sbc
  .env.example.server
  install.sh
  scripts/detect-edition.sh
  docs/editions.md
  RELEASES.md
  DESIGN.md
  ROADMAP.md
  README.md
  bot/Dockerfile
  bot/package.json
)
for f in "${need[@]}"; do
  [ -e "$f" ] || { echo "missing required file: $f" >&2; exit 1; }
done
echo "==> Required files present"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> dry-run OK (no tarball written)"
  exit 0
fi

mkdir -p "$OUT_DIR"
SUMS="${OUT_DIR}/SHA256SUMS"
: >"$SUMS"

# Stage under the output dir (not /tmp — model trees and full clones overflow tmpfs).
STAGE_ROOT="${OUT_DIR}/.stage"
rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE_ROOT"

package_one() {
  local ed="$1"
  local name="moneypenny-${ed}-${VERSION_SAFE}"
  local stage="${STAGE_ROOT}/${name}"

  echo "==> Staging ${name}"
  rm -rf "$stage"
  mkdir -p "$stage"

  # Source-only package: no node_modules, dist, runtime data, or multi-GB models.
  # Models are pulled by ollama / whisper / install on first boot.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude='.git/' \
      --exclude='node_modules/' \
      --exclude='bot/node_modules/' \
      --exclude='bot/web/node_modules/' \
      --exclude='bot/dist/' \
      --exclude='bot/web/dist/' \
      --exclude='bot/data/' \
      --exclude='.env' \
      --exclude='dist/' \
      --exclude='models/' \
      --exclude='**/__pycache__/' \
      --exclude='*.pyc' \
      --exclude='**/.venv/' \
      --exclude='.venv/' \
      --exclude='**/*.rkllm' \
      --exclude='**/*.gguf' \
      --exclude='**/*.onnx' \
      ./ "${stage}/"
  else
    tar -cf - \
      --exclude='./.git' \
      --exclude='./node_modules' \
      --exclude='./bot/node_modules' \
      --exclude='./bot/web/node_modules' \
      --exclude='./bot/dist' \
      --exclude='./bot/web/dist' \
      --exclude='./bot/data' \
      --exclude='./.env' \
      --exclude='./dist' \
      --exclude='./models' \
      --exclude='./.venv' \
      --exclude='__pycache__' \
      . | tar -xf - -C "${stage}"
  fi

  # Empty dirs for first boot (models pulled at runtime)
  mkdir -p "${stage}/bot/data" "${stage}/music/uploads" \
    "${stage}/models/npu-llm" "${stage}/models/convert"
  printf '%s\n' \
    "# Model weights are not shipped in the source release." \
    "# - Ollama pulls GGUFs on first install (see install.sh)." \
    "# - Whisper / Piper download into compose volumes on first start." \
    "# - Optional NPU: place .rkllm under models/npu-llm/ (SBC --llm npu)." \
    >"${stage}/models/README.md"

  printf '%s\n' "$ed" >"${stage}/.edition-default"
  if [ -f "${stage}/.env.example.${ed}" ]; then
    cp "${stage}/.env.example.${ed}" "${stage}/.env.example.ACTIVE"
  fi

  (cd "${stage}" && find . -type f | sort) >"${OUT_DIR}/MANIFEST-${ed}.txt"

  local tarball="${OUT_DIR}/${name}.tar.gz"
  echo "==> Writing ${tarball}"
  tar -C "$STAGE_ROOT" -czf "$tarball" "$name"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && sha256sum "$(basename "$tarball")") >>"$SUMS"
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$OUT_DIR" && shasum -a 256 "$(basename "$tarball")") >>"$SUMS"
  fi
  ls -lh "$tarball"
  rm -rf "$stage"
}

case "$EDITION" in
  both)
    package_one sbc
    package_one server
    ;;
  *)
    package_one "$EDITION"
    ;;
esac

rm -rf "$STAGE_ROOT"

echo
echo "==> Done. Artifacts in ${OUT_DIR}"
ls -lh "$OUT_DIR"
echo "Checksums:"
cat "$SUMS"
