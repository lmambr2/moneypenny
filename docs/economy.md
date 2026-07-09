# Org economy — mining / refining / crafting orders

**Status:** shipped on `dev` — deterministic order builders + optional UEX prices.  
**Policy:** sustainable, no scrapers, polite to data owners.

---

## 1. Summary

Moneypenny’s org assistant includes a **seed economy layer** for Star Citizen–style
industrial loops:

| Command | Purpose |
|---------|---------|
| `!mine <ore> [scu:N] [method:name]` | Mining pull order + stability / souring clock |
| `!refine <ore> [scu:N] [method:name]` | Refine yield / time / cost **estimates** |
| `!craft <recipe> [qty:N]` | Bill of materials + implied raw |
| `!econ …` | Browse catalog / UEX prices |

These are **deterministic** (no LLM). `!ask` still injects seed catalog context when
the question matches mining/refining/crafting keywords.

---

## 2. Data policy

| Source | Role |
|--------|------|
| **In-repo seed catalog** (`bot/src/economy/catalog.ts`) | Ore roster, rock stats snapshot, refine methods, illustrative craft BOMs |
| **Seed import JSON** (`bot/src/economy/data/`) | Frozen one-shot import artifact (not read at runtime) |
| **UEX Corp public API** (`api.uexcorp.space`) | Optional **live** sell/buy averages + commodity flags |
| **Org doctrine** (Library → Doctrine / RAG) | Real SOPs, locations, live craft recipes |
| Community UIs (scminer, SC DataHub, SCMDB, Golem, …) | Human bookmarks; **no runtime scrape** |

### One-shot seed import (allowed)

A **rare, targeted, maintainer-triggered** HTML parse of public DataHub mining
pages was used to freeze rock stats into the seed (`seed-import-2026-07.json` →
`catalog.ts`). That is intentional and attributed — not a product dependency.

| Rule | |
|------|--|
| Runtime bot | **Never** scrapes community sites |
| Live prices | UEX API only (cached, polite) |
| Refresh seed | Manual, infrequent, clear User-Agent, new snapshot file |
| SCMDB / scminer | Not scraped; operators use them in a browser |

See `bot/src/economy/data/README.md`.

### UEX client etiquette

- Long cache TTL (default **6 hours**)
- Short HTTP timeout
- Identifiable `User-Agent`: `Moneypenny-OrgEconomy/…`
- Fail soft if offline
- Attribution line on every price reply

| Env | Default | Meaning |
|-----|---------|---------|
| `ECONOMY_UEX` | `1` | Set `0` / `false` / `off` to disable prices |
| `UEX_API_BASE` | `https://api.uexcorp.space` | API host |
| `UEX_CACHE_TTL_MS` | `21600000` (6h) | Commodity list cache |
| `UEX_TIMEOUT_MS` | `8000` | Request timeout |
| `UEX_API_KEY` | _(empty)_ | Optional if UEX requires a key later |

---

## 3. Commands

Public by default (rights migration v3 + rank template).

```
!mine quantainium scu:32
!refine bexalite scu:32 method:dinyx
!craft quantum-core qty:2
!econ ores
!econ methods
!econ recipes
!econ prices bexalite
!econ search stileron
```

Flags: `scu:N`, `qty:N`, `method:name` (or `m:name`).

**Spelling:** catalog canonical is **Quantainium**; `quantanium` / `qt` are aliases.

Seed refine/craft numbers are **planning placeholders**, not cockpit-accurate game
exports. Prefer doctrine notes when precision matters.

---

## 4. Architecture

```
!mine / !refine / !craft / !econ
        │
        ▼
bot/src/economy/service.ts   (handlers)
        │
        ├─▶ catalog.ts + orders.ts   (pure, offline)
        └─▶ uex.ts                   (optional, cached)

!ask "how do I refine quantainium?"
        │
        ▼
LlmRuntime.retrieveContext
        └─▶ economyContextForQuestion()  (static seed only)
```

Implementation:

- `bot/src/economy/*`
- `COMMAND_MANIFEST` specials: `mine`, `refine`, `craft`, `econ`
- Rights delta v3 (`defaultAllow`)
- `docs/economy.md` (this file)

---

## 5. Maintaining the catalog after a patch

1. Prefer hand edits or doctrine for org-specific SOPs.
2. Optional: one-shot re-import of DataHub ores/refining → new `seed-import-*.json` → merge into `catalog.ts` (see `data/README.md`).
3. Confirm sell prices with `!econ prices <ore>` (UEX).
4. Do **not** add runtime scrapers or scheduled hammers against community UIs.

Illustrative craft recipes stay tiny on purpose — full fabricator graphs belong in
org doctrine or specialist sites operators open in a browser.

---

## 6. Non-goals

- Live location heatmaps / RS signature scanners
- Loadout optimizers (lasers/modules)
- Terminal-level trade route engines (use UEX in browser)
- Runtime scrape of any community SPA
- Full mission → blueprint graph (SCMDB is a human reference)

---

## 7. Acceptance checklist

- [x] `!mine` / `!refine` / `!craft` / `!econ` registered + public
- [x] Seed catalog offline without network
- [x] Optional UEX prices with cache + attribution
- [x] `!ask` economy keyword injection
- [x] Rights migration v3 for frozen rulesets
- [x] No scrapers

---

## 8. Org doctrine (private — examples only in-repo)

Real logistics doctrine (routes, pads, BOMs) should live in your **private**
knowledge base, not a public git tree.

**Templates** (copy → private Library / private wiki / `bot/data/doctrine/`):

| Example file | Contents |
|--------------|----------|
| [`docs/examples/doctrine/economy-orders.example.md`](./examples/doctrine/economy-orders.example.md) | Commands, refine policy, QT rules, route/BOM placeholders |
| [`docs/examples/doctrine/mining-crew-brief.example.md`](./examples/doctrine/mining-crew-brief.example.md) | Mining flight checklist |
| [`docs/examples/doctrine/logistics-glossary.example.md`](./examples/doctrine/logistics-glossary.example.md) | Shared vocabulary |

See [`docs/examples/doctrine/README.md`](./examples/doctrine/README.md). After
copying privately: RAG on → reindex → `!ask` grounds on your edits.

---

## 9. References

UEX: [uexcorp.space](https://uexcorp.space/) · seed: `bot/src/economy/catalog.ts` ·
commands: `bot/src/bot/commands.ts` · rights: `bot/src/rights/migrations.ts` ·
examples: `docs/examples/doctrine/`
