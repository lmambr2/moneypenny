#!/usr/bin/env bash
# Keep sidecar URLs on loopback for host-network bot (Podman/TS6 layout).
set -euo pipefail
CFG=/media/storage/moneypenny/bot/data/config.json
python3 - <<'PY'
import json
from pathlib import Path
p=Path("/media/storage/moneypenny/bot/data/config.json")
c=json.loads(p.read_text())
want={
  "mempalaceUrl":"http://127.0.0.1:8090",
  "streamBridgeUrl":"http://127.0.0.1:8081",
  "vectorDbUrl":"http://127.0.0.1:6333",
  "embeddingUrl":"http://127.0.0.1:11434",
  "llmUrl":"http://127.0.0.1:11434",
}
changed=False
for k,v in want.items():
  if c.get(k)!=v:
    print(f"{k}: {c.get(k)!r} -> {v!r}")
    c[k]=v
    changed=True
v=c.setdefault("voice",{})
if isinstance(v,dict):
  for k,u in [("sttUrl","http://127.0.0.1:9000"),("ttsUrl","http://127.0.0.1:8880")]:
    if v.get(k)!=u:
      print(f"voice.{k}: {v.get(k)!r} -> {u!r}")
      v[k]=u
      changed=True
if changed:
  p.write_text(json.dumps(c, indent=2)+"\n")
  print("wrote config")
else:
  print("config already host-net correct")
PY
