# turbovec-bridge

Drop-in **vector store** for Moneypenny RAG. Replaces the old Qdrant container.

- **Vectors:** [TurboVec](https://github.com/RyanCodrai/turbovec) `IdMapIndex` (TurboQuant, compressed)
- **Payload / filters:** SQLite next to the index (classification allowlists, delete-by-source)
- **API:** tiny Qdrant-shaped REST subset used by `bot/src/rag/qdrant.ts`

## Run

```bash
docker compose --profile rag up -d --build turbovec
# bot expects:
# VECTOR_DB_URL=http://turbovec:6333
```

Data: Docker volume `turbovec-data` → `/data` (`*.tvim` + `payloads.sqlite`).

## After switching from Qdrant

Qdrant volumes are **not** migrated. With `ragEnabled`, the bot **reindexes doctrine from disk** on startup (`reindexDoctrine`). Or Library → Doctrine → Reindex.

## Env

| Var | Default | Notes |
|-----|---------|--------|
| `PORT` | `6333` | |
| `TURBOVEC_DATA` | `/data` | |
| `TURBOVEC_BIT_WIDTH` | `4` | 2 / 3 / 4 |
| `TURBOVEC_NORMALIZE` | `1` | L2-normalize for cosine-style search |
