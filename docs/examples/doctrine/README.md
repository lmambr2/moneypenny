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

- Product docs: `docs/economy.md`
- Seed catalog + commands (no org routes)
- This `examples/` folder (generic templates)

## What should stay private

- Real mining locations / schedules  
- Pad codes, org store locations, blueprint sources  
- Restricted/secret doctrine (`classification:` frontmatter)

The public `doctrine/ops/` tree in this repo is limited to **product** ops
cheatsheets (e.g. RAG ingestion), not org logistics.
