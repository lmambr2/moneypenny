#!/usr/bin/env bash
# Full doctrine re-embed → TurboVec (force). English corpus; uses active EMBEDDING_MODEL.
#
# Usage (from repo root, stack up with rag profile):
#   ./scripts/reembed-doctrine.sh
#   EMBEDDING_MODEL=bge-large-en-v1.5 ./scripts/reembed-doctrine.sh
#   ./scripts/reembed-doctrine.sh --wipe-index   # clear TurboVec collection files first
#
# Reads doctrine files + SQLite registry from bot data volume; rebuilds vectors
# for every .md with force:true (ignores byte-identical skip).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WIPE=0
for a in "$@"; do
  case "$a" in
    --wipe-index) WIPE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

DC=(docker compose)
if [ -f docker-compose.sbc.yml ] && grep -q 'MONEYPENNY_EDITION=sbc' .env 2>/dev/null; then
  DC=(docker compose -f docker-compose.yml -f docker-compose.sbc.yml)
elif [ -f docker-compose.server.yml ] && grep -q 'MONEYPENNY_EDITION=server' .env 2>/dev/null; then
  DC=(docker compose -f docker-compose.yml -f docker-compose.server.yml)
fi

if ! "${DC[@]}" ps bot --status running 2>/dev/null | grep -q bot; then
  echo "bot container not running. Start with: ${DC[*]} --profile core --profile ollama --profile rag up -d" >&2
  exit 1
fi

if [ "$WIPE" -eq 1 ]; then
  echo "Wiping TurboVec collection artifacts for moneypenny_docs…"
  "${DC[@]}" exec -T turbovec python3 - <<'PY' || true
from pathlib import Path
import sqlite3
data = Path("/data")
for p in data.glob("moneypenny_docs*"):
    print("remove", p)
    p.unlink(missing_ok=True)
db = data / "payloads.sqlite"
if db.exists():
    c = sqlite3.connect(str(db))
    c.execute("DELETE FROM points WHERE collection = ?", ("moneypenny_docs",))
    c.execute("DELETE FROM collections WHERE name = ?", ("moneypenny_docs",))
    c.commit()
    print("cleared sqlite rows for moneypenny_docs")
PY
  "${DC[@]}" restart turbovec
  sleep 2
fi

MODEL_ENV=()
if [ -n "${EMBEDDING_MODEL:-}" ]; then
  MODEL_ENV=(-e "EMBEDDING_MODEL=${EMBEDDING_MODEL}")
  echo "Using EMBEDDING_MODEL=${EMBEDDING_MODEL}"
fi

echo "Force re-embedding all doctrine sources (this can take a long time on SBC CPU)…"
"${DC[@]}" exec -T "${MODEL_ENV[@]}" bot node --input-type=module <<'NODE'
import path from "node:path";
import { createDatabase } from "./dist/data/database.js";
import { DoctrineStore } from "./dist/data/doctrine.js";
import {
  EmbeddingsClient,
  VectorClient,
  RetrievalStore,
} from "./dist/rag/index.js";
import { reindexDoctrineSources } from "./dist/rag/doctrine-ingest.js";
import { loadConfig } from "./dist/data/config.js";
import { createLogger } from "./dist/logger.js";

const DATA = "/app/data";
const config = loadConfig(path.join(DATA, "config.json"));
const logger = createLogger();
const db = createDatabase(path.join(DATA, "moneypenny.db"));
const doctrine = new DoctrineStore(db.db, DATA, logger);
const embUrl = (
  config.embeddingUrl ||
  config.llmUrl ||
  process.env.EMBEDDING_URL ||
  process.env.RKLLAMA_URL ||
  "http://ollama:11434"
).replace(/\/$/, "");
const model =
  process.env.EMBEDDING_MODEL ||
  config.embeddingModel ||
  undefined;
const emb = new EmbeddingsClient({
  baseUrl: embUrl,
  model,
  timeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || "600000", 10) || 600_000,
  logger,
});
const vectorStore = new VectorClient({
  baseUrl: config.vectorDbUrl || process.env.VECTOR_DB_URL || "http://turbovec:6333",
  logger,
});
const retrieval = new RetrievalStore({
  embeddings: emb,
  vectorStore,
  collection: config.ragCollection || "moneypenny_docs",
  topK: config.ragTopK || 4,
  logger,
});
await retrieval.init();
const files = doctrine.files();
console.log(
  JSON.stringify(
    {
      model: emb.getModel(),
      embUrl,
      files: files.length,
      fileList: files,
    },
    null,
    2,
  ),
);
const docs = await reindexDoctrineSources(retrieval, doctrine, files, { force: true });
const chunks = docs.reduce((n, d) => n + d.chunks, 0);
console.log(
  JSON.stringify(
    {
      reindexed: docs.length,
      chunks,
      docs: docs.map((d) => ({
        source: d.source,
        chunks: d.chunks,
        classification: d.classification,
      })),
    },
    null,
    2,
  ),
);
process.exit(0);
NODE

echo "Done. Verify: docker compose exec turbovec python3 -c \"import sqlite3;c=sqlite3.connect('/data/payloads.sqlite');print(c.execute('select count(*) from points').fetchone())\""
