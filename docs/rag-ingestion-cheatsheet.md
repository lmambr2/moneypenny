---
classification: unclassified
tags: [ops, rag, ingestion, cheatsheet]
valid_until: 2027-06-21
---

# RAG & memory cheatsheet

Quick reference for operators and `@analyst`. **Rank-gating controls who can retrieve a doc; it does not load docs.** Loading is always an explicit ingest path below.

**Economy commands:** `!mine` / `!refine` / `!craft` / `!econ` (product).  
**Private logistics doctrine:** copy templates from `docs/examples/doctrine/` into
your **private** store (`bot/data/doctrine/` or host `doctrine.git`) — never into
this public GitHub tree. The public repo has **no** real RAG corpus.

---

## Two stores — do not confuse them

| Store | What it is | How content gets in | Editable? | Used by |
|-------|------------|---------------------|-----------|---------|
| **RAG / doctrine** | Org knowledge base — `.md` files under `bot/data/doctrine/`, embedded in Qdrant | Git push, Library upload, `moneypenny-drop`, manual file drop, `!intsum -s` / `!aar -s` | Yes — **Library → Doctrine** (web UI) | `!ask`, `!analyst` (citations) |
| **MemPalace** | Per-user conversational memory | `!remember <fact>` only (optional sidecar sync) | Via `!recall` / MemPalace dashboard — **not** doctrine | `!ask` for that user only |

**There is no symlink or auto-bridge from MemPalace → RAG.** Copy text into doctrine via an ingest path if you want it in the shared knowledge base.

---

## Prerequisites (RAG must be on)

1. Qdrant running (`docker compose --profile rag up -d`).
2. **Knowledge base** enabled in Settings (`ragEnabled: true`); restart if it was off at boot.
3. Embedding model reachable (default: `embeddinggemma` on Ollama).

Verify: Library lists doctrine docs; `!ask <question>` returns grounded answers.

---

## Load docs into RAG (pick one)

| Path | Best for | How |
|------|----------|-----|
| **Git wiki** | Multi-author, versioned | Push `.md` to `doctrine.git` → auto-sync to `bot/data/doctrine/` |
| **TS drop zone** | Non-technical members | Drop `.md` in channel `moneypenny-drop` (upload permission = security boundary) |
| **Web Library** | One-offs, editing | **Library → Doctrine** — upload, **+ New doc**, inline edit, **Reindex** |
| **Manual drop** | Host/automation | `scp` / `rsync` into `bot/data/doctrine/` (watcher re-embeds; `!reindex` forces full resync) |

Doc format: Markdown + optional frontmatter:

```markdown
---
classification: restricted
tags: [intel, fleet-ops]
valid_until: 2026-12-31
---

# Title
Body is chunked and embedded.
```

Omitted `classification` → `unclassified` (everyone can retrieve). See rank-gating doc for the clearance ladder — **that doc is about retrieval permissions, not ingestion.**

---

## Generate org docs (analyst commands)

| Command | Saves to doctrine? | Notes |
|---------|-------------------|-------|
| `!analyst <task>` / `!agent <task>` | **Only with `-s`** → `reports/analyst-YYYY-MM-DD.md` | Needs `@analyst` right + delegate URL configured |
| `!intsum [-s] [class:<level>] <bullets>` | **Only with `-s`** → `intel/intsum-YYYY-MM-DD.md` | Bullets separated by `;` or `\|` |
| `!aar [-s] [class:<level>] <bullets>` | **Only with `-s`** → `reports/aar-YYYY-MM-DD.md` | Same bullet syntax |

**Want a generated doc in the editable library?** Use `!intsum -s` or `!aar -s`, or copy `!analyst` chat output → Library upload / **+ New doc** → **Reindex**.

Use `!analyst -s` or `!intsum -s` / `!aar -s` to auto-save. Do not symlink MemPalace into RAG — unsupported.

---

## MemPalace & knowledge graph (Phase 7)

**Personal memory** (per-user, not doctrine):

- `!remember <fact>` / `!recall` / `!forget`
- Settings → **Per-user memory** + **MemPalace**; **Sync SQLite → MemPalace** backfills facts

**Org knowledge graph** (institutional, temporal — not doctrine files):

- `!kg remember <fact> [from:YYYY-MM-DD] [until:YYYY-MM-DD]` — analyst only
- `!kg who <name> [asof:YYYY-MM-DD]` — temporal lookup (“who was X as of date”)
- `!kg list` / `!kg forget <n|all>` — analyst for forget
- `!diary intel|logistics <fact> [from:…] [until:…]` — specialist diary entries
- Settings → **Org knowledge graph** (`kgEnabled`) injects KG into `!ask`

MemPalace sidecar stores per-user rooms + shared `org_kg` / diary rooms for semantic recall. Not a substitute for RAG doctrine.

---

## After you change doctrine

| Action | When |
|--------|------|
| `!reindex` | Full resync after bulk edits, `valid_until` deploy, or if search feels stale |
| `!ingeststatus` | Check last TS file-drop ingests (admin) |
| Library **Reindex** | Same as `!reindex` from the web UI |

---

## Rank-gating vs ingestion (common mistake)

- **Ingestion** = getting `.md` files into `bot/data/doctrine/` and Qdrant (table above).
- **Rank-gating** = which `classification` levels a member's TeamSpeak groups may **retrieve** during `!ask` / `!analyst`.

Config: `scripts/rights-rank-gating.json` → Settings rights JSON. Debug: Settings → **Rights debug** or `GET /api/bot/rights/debug`.

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `!analyst` says not configured | Settings → Delegate analyst URL/model |
| `!analyst` denied | Invoker needs `@analyst` in their server groups |
| Doc saved but `!ask` can't find it | `ragEnabled` on? Qdrant up? Run `!reindex` |
| Chunks missing for some members | Doc `classification` vs member's `doctrine:*` rights |
| Analyst answer wrong about ingestion | Cite **this cheatsheet** or `docs/rag-ingestion.md` — not rank-gating docs |

---

## See also (repo docs, not in RAG unless ingested)

- `docs/rag-ingestion.md` — full ingestion guide
- `docs/rank-gating.md` — TeamSpeak groups → command/doctrine permissions
- `docs/remote-llm.md` — delegate analyst setup