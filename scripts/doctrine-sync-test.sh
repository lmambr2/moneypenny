#!/usr/bin/env bash
#
# Local doctrine git-sync smoke test (no SSH). Verifies post-receive → doctrine
# dir mirror including nested paths and git rm purge.
#
# Usage: ./scripts/doctrine-sync-test.sh
# Exit 0 on success, 1 on failure.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

REPO="$WORK/doctrine.git"
DOCTRINE="$WORK/doctrine-data"
CLONE="$WORK/clone"

echo "=== Doctrine Git Sync Test ==="

./scripts/setup-doctrine-repo.sh "$REPO" "$DOCTRINE" >/dev/null

git clone "$REPO" "$CLONE" >/dev/null 2>&1
cd "$CLONE"
git config user.email "test@moneypenny.local"
git config user.name "Moneypenny Test"

mkdir -p intel
cat > intel/intsum.md <<'MD'
---
classification: secret
tags: [intel]
---
# INTSUM
Alpha squad repositioned.
MD
git add intel/intsum.md
git commit -m "add intsum" >/dev/null
git push origin main >/dev/null

if [ ! -f "$DOCTRINE/intel/intsum.md" ]; then
  echo "FAIL: nested intsum.md not mirrored to doctrine dir" >&2
  exit 1
fi
echo "OK: nested push mirrored"

git rm intel/intsum.md
git commit -m "remove intsum" >/dev/null
git push origin main >/dev/null

if [ -f "$DOCTRINE/intel/intsum.md" ]; then
  echo "FAIL: removed file still present after git rm + push" >&2
  exit 1
fi
echo "OK: git rm purged from doctrine dir"

if [ ! -f "$DOCTRINE/.git-sync.log" ]; then
  echo "WARN: sync log not written (non-fatal)"
else
  echo "OK: sync log present"
fi

echo "Doctrine git sync test passed."