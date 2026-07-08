#!/usr/bin/env bash
# Point Pi chat at rkllama/npu-llm; keep embeddings on ollama.
# Run ON THE PI after Gemma4 NPU inference smoke-test passes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

set_kv() {
  local key="$1" val="$2" file="$ROOT/.env"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >>"$file"
  fi
}

set_kv RKLLAMA_URL http://rkllama:8080
set_kv RKLLAMA_MODEL npu-llm
set_kv EMBEDDING_URL http://ollama:11434

python3 - <<'PY'
import json
from pathlib import Path
p = Path("bot/data/config.json")
cfg = json.loads(p.read_text()) if p.exists() else {}
cfg["llmEnabled"] = True
cfg["llmUrl"] = "http://rkllama:8080"
cfg["llmModel"] = "npu-llm"
cfg.setdefault("embeddingUrl", "http://ollama:11434")
cfg.setdefault("embeddingModel", "embeddinggemma")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(cfg, indent=2) + "\n")
print("Updated", p)
PY

docker compose -f docker-compose.yml -f docker-compose.npu.yml --profile core --profile npu --profile ollama restart bot rkllama
echo "Smoke: curl -s http://127.0.0.1:8080/v1/chat/completions -d '{\"model\":\"npu-llm\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16}'"