# RAG embeddings (TurboVec)

English-only doctrine corpus. Vectors live in **TurboVec** (`VECTOR_DB_URL=http://turbovec:6333`).

## Models

| Edition | Default `EMBEDDING_MODEL` | Notes |
|---------|---------------------------|--------|
| **SBC** | `nomic-embed-text-v2-moe` | Fast, 768-d, Ollama library |
| **Server** | `bge-large-en-v1.5` | Higher quality; reindex after switch |

Override in `.env` or Settings → `embeddingModel`. Empty `config.json` field falls back to env, then edition default.

## Normalization

`EmbeddingsClient` **L2-normalizes** every vector before return. TurboVec also normalizes on upsert/search (`TURBOVEC_NORMALIZE=1`). Safe for cosine.

## Chunking

| Param | Default | Approx tokens (English ~4 chars/tok) |
|-------|---------|--------------------------------------|
| `maxChars` | 2048 | ~512 |
| `overlap` | 200 | ~50 |

Heading-aware split first, then size-bound (`bot/src/rag/chunk.ts`).

## Optional reranker

Set `RERANKER_URL` to a TEI (or compatible) service exposing `POST /rerank` or `/v1/rerank` with `bge-reranker-large` (or `RERANKER_MODEL`).

```bash
RERANKER_URL=http://reranker:80
RERANKER_MODEL=bge-reranker-large
```

When unset, ANN order from TurboVec is used as-is.

## Pull models

```bash
# One-shot compose helper (profiles ollama + rag)
docker compose --profile ollama --profile rag run --rm ollama-embed-pull

# Or:
docker compose --profile ollama exec ollama ollama pull nomic-embed-text-v2-moe
# Server quality:
docker compose --profile ollama exec ollama ollama pull bge-large-en-v1.5
```

## Full re-embed (after model change)

Changing embed model changes vector dim (e.g. 768 → 1024). Wipe the collection and rebuild:

```bash
./scripts/reembed-doctrine.sh --wipe-index
# or keep collection if same dim:
./scripts/reembed-doctrine.sh
EMBEDDING_MODEL=bge-large-en-v1.5 ./scripts/reembed-doctrine.sh --wipe-index
```

Reads doctrine from disk + SQLite registry (`doctrine_docs`), force-embeds every file, upserts into TurboVec.

## Benchmark / smoke

1. Pull model, re-embed, check point count:
   ```bash
   docker compose exec turbovec python3 -c \
     "import sqlite3;c=sqlite3.connect('/data/payloads.sqlite');print(c.execute('select count(*) from points').fetchone())"
   ```
2. Settings → RAG test query, or `!ask` with a doctrine fact.
3. Unit tests: `cd bot && npm test -- src/rag`
