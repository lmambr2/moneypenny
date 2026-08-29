# Org economy — mining, refining, craft, trade

**Status:** shipped on `dev` / `master` (2026-07-09)  
**Policy:** sustainable data use — public JSON APIs only, long cache, fail-open, attribution. **No HTML scrapers.**

---

## 1. Commands (what operators type)

| Command | Purpose | Data source |
|---------|---------|-------------|
| `!mine <ore> [scu:N] [method:name]` | Mining pull + stability / souring clock | Offline seed (`catalog.ts`) |
| `!refine <ore> [scu:N] [method:name]` | Refine yield / time / cost **estimates** | Offline seed |
| `!craft <blueprint> [qty:N]` | Bill of materials for an **in-game** blueprint | **sc-craft.tools** (live) |
| `!workorder <item> xN` | Save a craft BOM×qty as an org work order | sc-craft + SQLite |
| `!work-items` | Sum open work orders → org material shopping list | SQLite aggregate |
| `!trade …` | Trade routes, buyers, itinerary, circuit | **sc-trade.tools** (live; **token** for tools) |
| `!econ ores` | List mineable ores | Offline seed |
| `!econ methods` | List refine methods | Offline seed |
| `!econ recipes` | Points at live craft (no offline fake BOMs) | Help text |
| `!econ blueprints <name>` | Search live blueprints | sc-craft.tools |
| `!econ prices <commodity>` | Sell/buy averages | **UEX** API |
| `!econ search <q>` | Search seed ores / methods | Offline seed |

All are **deterministic** (no LLM). `!ask` can inject seed ore/method context when the question matches industrial keywords.

Public by default (rights: mine/refine/craft/econ v3, trade v7).

### Dashboard (WebUI)

Signed-in members can open **`/economy`** (nav: **Economy**) for the same surface as chat:

| Tab | Actions |
|-----|---------|
| Work orders | Add / done / clear; org material shopping totals |
| Mine / refine | Seed calculators (SCU, method) |
| Craft | Blueprint search + BOM; save as work order |
| Trade | Routes + buyers (needs `SC_TRADE_API_TOKEN`) |
| Prices | UEX commodity averages |
| Catalog | Full ore table + refine methods |
| Cache | Disk cache stats + manual refresh |

REST (auth cookie, same origin): `/api/economy/*` — see § API below.

### Example commands (in-game names only)

```
!mine quantainium scu:32
!mine stileron scu:16
!refine quantainium scu:32 method:dinyx
!refine bexalite scu:32 method:cormack
!craft P4-AR qty:1
!craft Coda qty:2
!workorder P4-AR x3
!work-items
!workorder list
!workorder done 1
!econ blueprints P4-AR
!econ blueprints Coda
!econ prices quantainium
!econ prices agricium
!econ ores
!econ methods
!econ search stileron
!trade routes ship:Freelancer+MAX invest:200000 stops:2 profit:time loc:Stanton
!trade buyers Agricium scu:32 loc:Stanton
!trade ships Caterpillar
!trade itinerary from:Stanton+>+microTech+>+Port+Tressler+>+Platinum+Bay to:Stanton+>+Crusader+>+Yela+>+Grim+HEX ship:Freelancer invest:100000
!econ cache
!econ refresh
```

**Spelling:** seed ore **Quantainium** (game form); aliases `quantanium` / `qt` work.

**Flags**

| Surface | Flags |
|---------|--------|
| mine / refine / craft | `scu:N`, `qty:N`, `method:name` (or `m:name`) |
| trade | `ship:`, `invest:`, `stops:`, `profit:time\|pure`, `loc:`, `box:`, `from:`, `to:`, `id:`, `scu:` |
| Multi-word values | Use `+` for spaces: `ship:Freelancer+MAX`, `from:Stanton+>+…` |

---

## 2. Data sources

| Source | Role |
|--------|------|
| **Seed catalog** `bot/src/economy/catalog.ts` | Ores + rock stats snapshot + refine methods (offline) |
| **Seed import JSON** `bot/src/economy/data/` | Frozen one-shot import artifact (not read at runtime) |
| **UEX** `api.uexcorp.space` | Optional live commodity averages (`!econ prices`) |
| **SC Craft Tools** `sc-craft.tools` | Optional live **in-game** craft blueprints (`!craft`, `!econ blueprints`) |
| **SC Trade Tools** `sc-trade.tools` | Optional trade routes / buyers (`!trade`) — tools need **API token** |
| **SC Wiki API** `api.star-citizen.wiki` | Item/ship/location enrichment + **doctrine grounding** for `!ask` (from disk cache) |
| **SQLite L2 cache** table `economy_cache` (main bot DB) | Shared durable store for all of the above; auto-refresh; one-shot migrate from legacy JSON dir |
| **Org doctrine** | Real SOPs, pads, org craft notes (Library / private store) |
| scminer, star-crafting.com, SCMDB, … | Human bookmarks only — **not** wired at runtime |

### Local cache + refresh (SQLite L2)

All live economy clients write through a **SQLite** table `economy_cache`
(default: **main bot DB**; override with `ECONOMY_CACHE_DB`):

| Layer | Role |
|-------|------|
| **L1** | In-process Maps / client fields (hot, inflight coalesce) |
| **L2** | SQLite `economy_cache` — exact key, TTL, size-capped (~2000 rows) |

| Source | What gets cached |
|--------|------------------|
| UEX | Full commodities list (SWR on stale) |
| sc-craft | Search results + **blueprint detail** by id |
| sc-trade | Ships + locations + **route/buyer** bodies (TTL **3d** routes / **7d** catalog) |
| sc-wiki | Game version, search + item detail for warm names (**14d**) |

TTLs assume **org planning, not live arb**, and SC **major patches ~monthly**.
After a big economy patch: run `!econ refresh` (or Cache tab) once.

**Stale-while-revalidate:** serve expired L2 immediately where implemented (UEX,
ships/locations); always fail-open to last good payload if network fails.

**Legacy:** one-shot import from `{dataDir}/economy-cache/**/*.json` if present
(old file cache). Safe to delete JSON after migrate.

**Refresh**

| Trigger | When |
|---------|------|
| Bot boot | Warm starts ~15s after start (non-blocking) |
| Interval | `ECONOMY_CACHE_REFRESH_MS` (default **7 days**) |
| Manual | `!econ refresh` · status: `!econ cache` · dashboard Cache tab |

`!ask` economy grounding reads **L2 only** (no network on the ask path).

### Offline craft seed

`CRAFT_RECIPES` is **empty on purpose**. Fake “structural frame kit” / “quantum-core blank” recipes were removed so operators never see non-game items as examples. Craft always resolves through **sc-craft.tools** (or fails open with a clear message).

### One-shot mining seed import

Rare maintainer HTML parse of public DataHub mining pages → `seed-import-*.json` → merge into `catalog.ts`. Not a product dependency. See `bot/src/economy/data/README.md`.

---

## 3. Env / etiquette

| Env | Default | Meaning |
|-----|---------|---------|
| `ECONOMY_UEX` | `1` | `0` disables UEX prices |
| `UEX_API_BASE` | `https://api.uexcorp.space` | |
| `UEX_CACHE_TTL_MS` | `604800000` (**7d**) | Commodities list L2 TTL |
| `UEX_PRICES_CACHE_TTL_MS` | `604800000` (**7d**) | Per-commodity terminal prices (supply) L2 TTL |
| `UEX_TIMEOUT_MS` | `8000` | |
| `UEX_API_KEY` | _(empty)_ | Optional Bearer — see **Decision: UEX key** below |
| `ECONOMY_SCCRAFT` | `1` | `0` disables sc-craft |
| `SCCRAFT_API_BASE` | `https://sc-craft.tools` | |
| `SCCRAFT_CACHE_TTL_MS` | `604800000` (**7d**) | |
| `SCCRAFT_TIMEOUT_MS` | `8000` | |
| `ECONOMY_SCTRADE` | `1` | `0` disables `!trade` |
| `SC_TRADE_API_TOKEN` | _(empty)_ | **Required** for `/api/tools/*` (header `token`) |
| `SCTRADE_API_BASE` | `https://sc-trade.tools` | |
| `SCTRADE_CACHE_TTL_MS` | `259200000` (**3d**) | Route cache |
| `SCTRADE_CATALOG_TTL_MS` | `604800000` (**7d**) | Ships/locations catalog |
| `SCTRADE_TIMEOUT_MS` | `45000` | Route search can be heavy |
| `ECONOMY_SCWIKI` | `1` | `0` disables SC Wiki enrichment |
| `SCWIKI_API_BASE` | `https://api.star-citizen.wiki` | |
| `SCWIKI_CACHE_TTL_MS` | `1209600000` (**14d**) | Wiki game-data TTL |
| `ECONOMY_CACHE_DIR` | `{dataDir}/economy-cache` | Legacy JSON dir (migrate only) |
| `ECONOMY_CACHE_DB` | _(empty → main bot DB)_ | Optional dedicated sqlite path for cache table |
| `ECONOMY_CACHE_MAX_ROWS` | `2000` | Soft cap; oldest `fetched_at` pruned |
| `ECONOMY_CACHE_REFRESH_MS` | `604800000` (**7d**) | Background re-warm interval |

Shared rules for every remote client:

- Identifiable `User-Agent: Moneypenny-OrgEconomy/…`
- Long cache, short timeout
- Fail soft (never block music)
- Attribution on every live reply
- Public JSON only — never scrape SPAs (including star-crafting.com)

SC Trade tools licence: [Patreon sc_trade_tools](https://www.patreon.com/cw/sc_trade_tools/membership) · [Swagger](https://sc-trade.tools/swagger-ui/index.html)

### Decision: UEX API key (parked — operator, ~2026-07-09 evening)

**Status:** open — Lane to decide later (not blocking deploy).  
**Docs:** [UEX API 2.0](https://uexcorp.space/api/documentation/) · [My Apps](https://uexcorp.space/api/apps/) (Bearer token).

| Fact | Detail |
|------|--------|
| What we call | `GET /2.0/commodities` + per-id `commodities_prices` for supply (long TTL) |
| Without key | Works today (200 + data, probed 2026-07-09) |
| Official stance | Create an app → access token; Bearer auth; high rate budget |
| Client support | Already: `UEX_API_KEY` → `Authorization: Bearer` + `Authorization-Api` |
| User/wallet endpoints | Need a key — **we do not use them** |

**Options when deciding**

1. **Leave empty** — fine for casual Pi use while GETs stay open.  
2. **Set free app token** — recommended for production / good-citizen traffic; no code change.  
3. **`ECONOMY_UEX=0`** — seed-only; no live prices.

**Not the same as** `SC_TRADE_API_TOKEN` (required for trade routes/buyers).

**Action when decided:** set env on host/compose → restart bot. No PR required unless UEX starts requiring auth on `commodities` (client already ready).

---

## 4. Architecture

```
!mine / !refine          → catalog.ts + orders.ts (offline)
!craft / !econ blueprints → sc-craft.ts → disk cache
!econ prices             → uex.ts → disk cache
!trade                   → sc-trade.ts → disk cache (token for tools)
!econ cache|refresh      → cache/store + cache/refresh
!econ ores|methods|search → catalog.ts

!ask "how do I refine quantainium?"
        → economyContextForQuestion()
           seed ores/methods + sc-wiki disk snippets (no network)
```

Code: `bot/src/economy/*` · commands in `bot/src/bot/commands.ts` · rights
`bot/src/rights/migrations.ts` (v3 mine/refine/craft/econ · v7 trade · v8 workorder).

---

## 5. Maintaining after a patch

1. Hand-edit ore/method seed or re-import DataHub snapshot → `catalog.ts`.
2. Craft BOMs: refresh via sc-craft (no seed craft list to maintain).
3. Prices: `!econ prices <commodity>` (UEX).
4. Trade: set `SC_TRADE_API_TOKEN`; use exact ship/shop names from `!trade ships` / sc-trade UI.
5. Do **not** add scrapers or cron hammers against community UIs.

---

## 6. Backlog

### 6a. Community code lifts — **shipped** 2026-07-09

Pure TS reimpl of SuperCargo / HAULER OPS ideas (MIT ideas only — no Electron/OCR).

| ID | Status | Where |
|----|--------|--------|
| **E-BOX** | Shipped | `boxes.ts` `calculateBoxes` → `!work-items` / craft lines / dashboard chips (`2×32`) |
| **E-FUZZY** | Shipped | `fuzzy.ts` → `findOre` / methods / craft score / trade ships / UEX names / `!econ search` |
| **E-UEX-SUP** | Shipped | `uex.ts` `getTerminalPrices` + `supplyPct` / top terminals on `!econ prices` + `/api/economy/prices` |
| **E-FOOT** | Shipped | crate footprints + `largestCrateThatFits`; trade ships list; `GET /api/economy/boxes?scu=&maxBox=` |
| **E-SNAP** | Park | Still covered by **E-CACHE** SWR for ships/locations |

**Out of scope (never core):** OCR, game-log watchers, RSI scrapers, Hyperswarm, SPA backends, 3D packing.

### 6b. Ops feedback (park until wanted)

Parked after org feedback: **shopping list first**, not a guidebook. Build when
someone actually wants them on the board.

| ID | Item | Notes | Priority |
|----|------|--------|----------|
| **E-RAW** | Reverse refine → raw ore | From `!work-items` refined totals, work back via method yield (e.g. Dinyx ~45%) to raw SCU needed. Opt-in only (e.g. `!work-items raw method:dinyx`). **Not necessary soon** — quality friction means miners over-mine anyway. |
| **E-SIG** | Node sensor signatures | For a given ore: possible rock/node signature combos + amount of rocks per node (planning helper). Ops already run a small offline Python script for “all possible node sigs for a given ore” — candidate to port or import as a seed/table, not a live scanner. **Useful, not first.** |
| **E-STN** | Station refine modifiers | Yield can differ HUR-L1 vs Seraphim etc. Only after method-rate basics are trusted. |

Do **not** expand `!mine` / `!refine` back into multi-step SOP text.

**TS6 chat:** no reliable color BBCode. Unstable ores (Quantainium / other
critical·volatile seed entries) are marked with **⚠️** emoji on shopping lists
(`!craft`, `!workorder`, `!work-items`, `!mine`).

---

## 7. Dashboard API (`/api/economy`)

All routes require a signed-in session (global `/api` auth + CSRF on mutations).
Network-proxy routes are rate-limited; see [security-audit-economy-2026-07-09.md](./security-audit-economy-2026-07-09.md).

| Method | Path | Notes |
|--------|------|--------|
| GET | `/overview` | Catalog meta, client flags, cache summary, open WO count |
| GET | `/ores?q=` | Seed ores |
| GET | `/methods` | Refine methods |
| GET | `/mine?ore=&scu=&method=` | Structured mine order |
| GET | `/refine?ore=&scu=&method=` | Structured refine yield |
| GET | `/blueprints?q=` | sc-craft search (rate-limited) |
| GET | `/craft?q=&qty=` | Resolved BOM (rate-limited) |
| GET | `/prices?q=` | UEX snapshot + optional `supply` (rate-limited) |
| GET | `/boxes?scu=&maxBox=` | E-BOX/E-FOOT crate breakdown (+ optional ship max box) |
| GET | `/workorders` | Open orders + aggregated materials (includes `boxes` per line) |
| POST | `/workorders` | `{ item, qty }` — resolve BOM + save (cap 100 open) |
| DELETE | `/workorders/:id` | Mark done (any member) |
| DELETE | `/workorders` | Clear all — **admin only** |
| GET | `/trade/ships?q=` | Ship catalog |
| POST | `/trade/routes` | `{ ship, invest, stops, profit, loc }` (stricter rate limit) |
| POST | `/trade/buyers` | `{ commodity, scu, loc }` |
| POST | `/trade/itinerary` | `{ from, to, ship, invest, … }` shop→shop |
| POST | `/trade/circuit` | `{ id, ship, invest, … }` loop from a route id |
| GET | `/cache` | Disk cache stats (`rootLabel` only — no absolute path) |
| POST | `/cache/refresh` | Warm catalogs — **admin only** + single-flight |
| POST | `/ingest/terminal-snapshot` | Linux datarunner JSON — **admin session or `ECONOMY_INGEST_TOKEN` Bearer** |
| GET | `/ingest/snapshots` | List snapshots |
| POST | `/ingest/snapshots/:id/accept` | Re-accept (admin) |
| POST | `/ingest/snapshots/:id/reject` | Drop from local cache (admin) |

Local snapshots that are **newer than the UEX cache** win on `!econ prices` /
`GET /prices`. UEX remains fallback. Linux runner: [linux-datarunner-plan.md](./linux-datarunner-plan.md).

**Clear policy:** web `DELETE /workorders` and TS `!workorder clear` both require **admin**
(`workorder.clear` rights token on TS; session admin on web).

Vue: `bot/web/src/views/Economy.vue` · router `/economy`.

---

## 8. Non-goals

- Live location heatmaps / in-world signature **scanners** (E-SIG is offline planning only)
- Loadout optimizers (lasers/modules)
- HTML scrape of scminer / star-crafting.com / SCMDB
- Invented offline craft items (seed craft stays empty)
- Full mission → blueprint ownership graph as a second product

---

## 9. Acceptance checklist (shipped)

- [x] `!mine` / `!refine` / `!craft` / `!workorder` / `!work-items` / `!econ` / `!trade` registered + public
- [x] Shopping-list replies (no step guidebooks)
- [x] Seed ores/methods offline without network
- [x] Craft via **in-game** blueprints only (sc-craft)
- [x] Optional UEX prices with cache + attribution
- [x] Optional sc-trade routes with token gate + attribution
- [x] SC Wiki enrichment + disk cache refresh
- [x] `!ask` economy keyword injection (seed + wiki cache)
- [x] Dashboard `/economy` + `/api/economy/*` (view + change work orders, lookups, cache refresh)
- [x] No scrapers
- [ ] E-RAW / E-SIG / E-STN — see §6 backlog

---

## 10. Org doctrine (private)

Real logistics doctrine (routes, pads, preferred BPs) belongs in your **private** knowledge base.

Templates: [`docs/examples/doctrine/`](./examples/doctrine/) — copy privately, fill Routes / craft notes, reindex.

---

## 11. References

- UEX: [uexcorp.space](https://uexcorp.space/)
- SC Craft: [sc-craft.tools](https://sc-craft.tools/)
- SC Trade: [sc-trade.tools](https://sc-trade.tools/) · [Swagger](https://sc-trade.tools/swagger-ui/index.html)
- SC Wiki API: [api.star-citizen.wiki](https://api.star-citizen.wiki/)
- Seed: `bot/src/economy/catalog.ts`
