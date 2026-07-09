# Example doctrine (templates only)

These Markdown files are **examples for private org knowledge bases**. They are
**not** loaded into RAG by default and are **not** your production doctrine.

| File | Use |
|------|-----|
| `economy-orders.example.md` | Mine/refine/craft SOPs, refine policy, QT rules, route/BOM placeholders |
| `mining-crew-brief.example.md` | Mining flight checklist |
| `logistics-glossary.example.md` | Shared logistics vocabulary |

## How to use (private)

1. Copy into your **private** store only:
   - Library → Doctrine (upload / New doc), or
   - Private `doctrine.git` wiki on the bot host, or
   - `bot/data/doctrine/` on the server (not a public GitHub tree)
2. Rename without `.example` (e.g. `ops/economy-orders.md`).
3. Fill **Routes**, craft BOMs, pad names — keep opsec out of public forks.
4. Enable RAG → `!reindex` if needed.
5. Verify: `!ask can we store raw quantainium overnight?`

## What stays public in this repo

- Product docs: `docs/economy.md`, `docs/rag-ingestion.md`, `docs/rag-ingestion-cheatsheet.md`
- Seed catalog + economy commands (no org routes)
- This `examples/` folder (generic templates only)

## What must stay private (never commit here)

- **Any real RAG corpus** — routes, pads, BOMs, INTSUMs, AARs, intel
- Files under `bot/data/doctrine/` or a host `doctrine.git` wiki
- A top-level `/doctrine/` tree (gitignored entirely in this repo)

`.gitignore` blocks `/doctrine/`, private doctrine trees, and non-example
files under `docs/examples/doctrine/`.
