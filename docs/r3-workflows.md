# R3 — Org document workflows

> DESIGN §R3. Continues [rag-ingestion.md](./rag-ingestion.md) (corpus loading) and
> [remote-llm.md](./remote-llm.md) (delegate analyst). Style mirrors
> [voice.md](./voice.md).

**Status:** shipped on `dev` (2026-07-06) — templated generation, doctrine save, Pandoc export.

---

## 1. Summary

R3 turns Moneypenny into a **voice/chat front-end for short org documents**:

- **INTSUMs** — intelligence summaries from operator bullet points
- **AARs** — after-action reports from bullet points
- **Analyst reports** — free-form tasks via the delegate model (`!analyst`)

Generated docs can be **saved into the doctrine corpus** (`-s` flag) and **exported to Word**
(`.docx`) via Pandoc from the Library UI. Long-context doc generation routes through the
**delegate analyst** (R1), not the on-Pi chat model.

Design rule: **short, templated docs where the human supplies key points** — the model fills
structure; it does not invent facts beyond what bullets imply.

---

## 2. Commands

All generation commands require:

1. **Delegate configured** — Settings → Delegate analyst URL/model (`llmDelegateUrl`)
2. **Rank** — `@analyst` group (admins by default); `intsum` and `aar` are in that group

| Command | Input | Output | Save path (`-s`) |
|---------|-------|--------|------------------|
| `!intsum [-s] [class:<level>] <bullets>` | `;` or `\|` separated points | Templated INTSUM markdown | `intel/intsum-YYYY-MM-DD.md` |
| `!aar [-s] [class:<level>] <bullets>` | same | Templated AAR markdown | `reports/aar-YYYY-MM-DD.md` |
| `!analyst [-s] [class:<level>] <task>` | free-form task | Delegate analysis | `reports/analyst-YYYY-MM-DD.md` |

**Examples:**

```
!intsum class:restricted alpha secured north ridge; comms degraded 20 min; no casualties
!aar -s objectives met; delay at exfil; recommend earlier comms check
!analyst -s class:secret Summarize last week's fleet movements from doctrine
```

**Async ack:** when posted via TeamSpeak chat/voice, the bot replies immediately
(`Drafting — I'll post the document here when ready.` / `Analyst on it…`) and posts the
full document when the delegate finishes (R1b pattern).

**Classification:** `class:secret` sets YAML frontmatter `classification:` for rank-gating
on retrieval. Defaults: `intsum` → `restricted`, `aar` → `unclassified`, `analyst` → `restricted`.

---

## 3. Generation pipeline

```
Operator bullets / task
        │
        ▼
ControlRouter (rank check: intsum | aar | analyst)
        │
        ▼
Delegate LLM (llmDelegateUrl) + optional RAG context
        │
        ├─▶ chat follow-up (formatted markdown)
        └─▶ optional -s → DoctrineStore + Qdrant ingest
```

Implementation:

- `bot/src/docs/workflow.ts` — parse, prompts, save paths
- `bot/src/docs/analyst.ts` — analyst parse + save path
- `bot/src/llm/index.ts` `generateWorkflowDoc()` — RAG-grounded workflow generation
- `bot/src/control/router.ts` `runWorkflow()` / `runDelegate()`
- `bot/src/bot/knowledge/service.ts` `saveWorkflowDoc()` / `saveAnalystDoc()`

Citation footers (`📎 Sources: …`) are stripped before doctrine save and export.

---

## 4. Pandoc export (Word / PDF)

**Goal (DESIGN §R3):** formal handoff without LibreOffice-headless — Pandoc only.

### API (admin)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/rag/doctrine/export/capabilities` | `{ pandoc: bool, formats: ["docx","pdf"] }` |
| `GET /api/rag/doctrine/:source/export?format=docx` | Download converted file |

### Dashboard

**Library → Doctrine** — **Export** button per doc (visible when `pandoc` is on PATH).

### Runtime requirements

- **Docker image** includes `pandoc` (see `bot/Dockerfile`).
- **PDF** (`format=pdf`) needs a PDF engine on the host image (optional; may fail without
  `texlive` or `weasyprint`). **DOCX** is the supported default.

### Errors

| Code | Meaning |
|------|---------|
| `PANDOC_UNAVAILABLE` | `pandoc` not installed (503) |
| `EMPTY` | Document body empty after strip (400) |
| `PANDOC_FAILED` | Conversion error (502) |

---

## 5. Non-goals (R3 scope)

- Full-transcript ingestion or multi-hour AARs on the Pi chat model
- LibreOffice-headless conversion
- Automatic email/distribution of exports
- Symlinking MemPalace into RAG

Route heavy, long-context work through `!analyst` + delegate model.

---

## 6. Acceptance checklist

- [x] `!intsum` / `!aar` parse bullets + `class:` + `-s`
- [x] Rank-gated via `@analyst` group
- [x] Async ack + follow-up post in channel
- [x] `-s` ingests to doctrine + Qdrant
- [x] `!analyst -s` saves to `reports/analyst-*.md`
- [x] Pandoc export API + Library Export button
- [x] `pandoc` in production Docker image

---

## 7. References

`DESIGN.md` §R3 · `bot/src/docs/{workflow,analyst,export}.ts` ·
`bot/src/web/api/rag.ts` · [rag-ingestion-cheatsheet](./rag-ingestion-cheatsheet.md)