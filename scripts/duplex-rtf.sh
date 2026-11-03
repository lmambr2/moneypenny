#!/usr/bin/env bash
# Measure Talker real-time factor. GA for AMD moshi.cpp Vulkan is RTF <= 1.15
# on the discrete Penny card (docs/personaplex-full-harness.md).
#
# Mock engine is a contract test, not a GPU measurement — exit 2.
# Unreachable adapter — exit 1.
# Product engine realtime=true — exit 0.
set -euo pipefail
DUPLEX_URL="${DUPLEX_URL:-http://127.0.0.1:8999}"
RTF_LIMIT="${RTF_LIMIT:-1.15}"

if ! curl -sf "${DUPLEX_URL}/health" >/tmp/mp-duplex-rtf.json; then
  echo "FAIL: cannot reach ${DUPLEX_URL}/health" >&2
  exit 1
fi

python3 - <<PY
import json, sys
j = json.load(open("/tmp/mp-duplex-rtf.json"))
engine = j.get("engine")
ok = j.get("ok") is True
loaded = j.get("loaded") is True
rtf = float(j.get("rtf") or 0)
realtime = j.get("realtime") is True
limit = float("${RTF_LIMIT}")
print("engine=%s ok=%s loaded=%s realtime=%s rtf=%s vram_mb=%s" % (
    engine, ok, loaded, realtime, rtf, j.get("vram_mb")))
if not ok:
    sys.exit(1)
if engine == "mock":
    print("skip: mock is not a GPU RTF measurement (need moshicpp-vulkan on the R9700)")
    sys.exit(2)
if engine not in ("moshicpp-vulkan", "moshi-cuda"):
    print("skip: engine %r is not a product Talker" % (engine,))
    sys.exit(2)
if not loaded:
    print("FAIL: Talker not loaded — warm() first")
    sys.exit(1)
if not realtime or rtf > limit:
    print("FAIL: RTF %.3f > %.2f (or realtime=false) — stay cascaded" % (rtf, limit))
    sys.exit(1)
print("OK: Talker real-time on this adapter")
PY
