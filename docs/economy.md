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
| **SC Craft Tools API** (`sc-craft.tools`) | Optional **live** craft blueprints / BOMs (`!craft` fallback, `!econ blueprints`) |
| **SC Trade Tools API** (`sc-trade.tools`) | Optional **trade routes / buyers / itinerary** (`!trade`) — **requires API token** |
| **Org doctrine** (Library → Doctrine / RAG) | Real SOPs, locations, org-specific craft notes |
| Community UIs (scminer, star-crafting.com, SCMDB, …) | Human bookmarks; **no runtime scrape** |

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
| `ECONOMY_SCCRAFT` | `1` | Set `0` / `false` / `off` to disable sc-craft blueprints |
| `SCCRAFT_API_BASE` | `https://sc-craft.tools` | API host |
| `SCCRAFT_CACHE_TTL_MS` | `21600000` (6h) | Search/detail cache |
| `SCCRAFT_TIMEOUT_MS` | `8000` | Request timeout |
| `ECONOMY_SCTRADE` | `1` | Set `0` to disable `!trade` |
| `SC_TRADE_API_TOKEN` | _(empty)_ | **Required** for route tools (header `token`) — Patreon API licence |
| `SCTRADE_API_BASE` | `https://sc-trade.tools` | API host |
| `SCTRADE_CACHE_TTL_MS` | `1800000` (30m) | Route result cache |
| `SCTRADE_TIMEOUT_MS` | `45000` | Route search timeout |

### SC Craft Tools etiquette

Same posture as UEX: public JSON only (`/api/blueprints`, `/api/blueprints/:id`),
long cache, short timeout, `User-Agent: Moneypenny-OrgEconomy/…`, fail soft,
attribution on every blueprint reply. Fan project (Norkaan / HTTPS org) — not CIG.
**Not** star-crafting.com (no public API; do not scrape).

### SC Trade Tools etiquette

Official OpenAPI ([Swagger UI](https://sc-trade.tools/swagger-ui/index.html)).
Ship/location **catalog** GETs are open; **`/api/tools/*`** (routes, buyers,
itinerary, circuits) require header **`token`** (Patreon API licence).

| Rule | |
|------|--|
| Auth | `SC_TRADE_API_TOKEN` → request header `token` |
| Cache | Routes ~30 min; ship list ~6 h |
| Fail soft | Missing token / 403 / 429 → clear message, music unaffected |
| Attribution | Every `!trade` reply |
| Data quality | Community-reported prices — verify in-game |

Licence: [Patreon sc_trade_tools](https://www.patreon.com/cw/sc_trade_tools/membership).

---

## 3. Commands

Public by default (rights migration v3 + rank template).

```
!mine quantainium scu:32
!refine bexalite scu:32 method:dinyx
!craft quantum-core qty:2
!craft greatsword qty:1
!trade routes ship:Freelancer+MAX invest:200000 stops:2 loc:Stanton
!trade buyers Agricium scu:32
!trade ships hercules
!econ ores
!econ methods
!econ recipes
!econ blueprints greatsword
!econ prices bexalite
!econ search stileron
```

Flags: `scu:N`, `qty:N`, `method:name` (or `m:name`).  
Trade flags: `ship:`, `invest:`, `stops:`, `profit:time|pure`, `loc:`, `box:`, `from:`, `to:`, `id:`.

**Spelling:** catalog canonical is **Quantainium**; `quantanium` / `qt` are aliases.

`!craft` tries the **seed catalog** first, then **sc-craft.tools** when enabled.
`!trade` uses **sc-trade.tools** (token required for routes).
Seed refine numbers remain planning placeholders; live feeds are community data
(verify in-game for rare stock / hauling).

---

## 4. Architecture

```
!mine / !refine / !craft / !econ
        │
        ▼
bot/src/economy/service.ts   (handlers)
        │
        ├─▶ catalog.ts + orders.ts   (pure, offline)
        ├─▶ uex.ts                   (optional prices, cached)
        ├─▶ sc-craft.ts              (optional blueprints, cached)
        └─▶ sc-trade.ts              (optional routes; token for /tools)

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
