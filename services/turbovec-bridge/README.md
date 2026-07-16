# turbovec-bridge

**Default vector store** for Moneypenny RAG (compose profile `rag`).

- **Vectors:** [TurboVec](https://github.com/RyanCodrai/turbovec) `IdMapIndex` (TurboQuant, compressed)
- **Payload / filters:** SQLite next to the index (classification allowlists, delete-by-source)
- **API:** tiny Qdrant-**shaped** REST subset used by `bot/src/rag/qdrant.ts` (class name historical; default URL is TurboVec)

There is **no** live Qdrant container in the stack. Do not start Qdrant for RAG.

## Run

```bash
docker compose --profile rag up -d --build turbovec
# bot expects:
# VECTOR_DB_URL=http://turbovec:6333
```

Data: Docker volume `turbovec-data` → `/data` (`*.tvim` + `payloads.sqlite`).

## After switching from Qdrant (legacy)

If you once ran Qdrant, those volumes are **not** migrated. With `ragEnabled`, the bot **reindexes doctrine from disk** on startup (`reindexDoctrine`). Or Library → Doctrine → Reindex.

## Tests

```bash
cd services/turbovec-bridge
python3 -m venv .venv && .venv/bin/pip install 'turbovec>=0.8.0,<0.9' numpy pytest
.venv/bin/python -m pytest -q test_server.py
```

Pure helpers (u64↔SQLite) run without TurboVec; ANN round-trip skips if the package is missing.

## Env

| Var | Default | Notes |
|-----|---------|--------|
| `PORT` | `6333` | |
| `TURBOVEC_DATA` | `/data` | |
| `TURBOVEC_BIT_WIDTH` | `4` | 2 / 3 / 4 |
| `TURBOVEC_NORMALIZE` | `1` | L2-normalize for cosine-style search |

## Notes

- Point ids are blake2b→u64; SQLite stores them as **signed** int64 (two's complement). Storing raw unsigned values with the high bit set raises `Python int too large to convert to SQLite INTEGER`.
