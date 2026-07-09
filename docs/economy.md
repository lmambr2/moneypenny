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
| **Disk cache** `data/economy-cache/` | Shared local store for all of the above; auto-refresh |
| **Org doctrine** | Real SOPs, pads, org craft notes (Library / private store) |
| scminer, star-crafting.com, SCMDB, … | Human bookmarks only — **not** wired at runtime |

### Local cache + refresh

All live economy clients write through a **disk cache** under the bot data dir
(`{dataDir}/economy-cache/` or `ECONOMY_CACHE_DIR`):

| Source | What gets cached |
|--------|------------------|
| UEX | Full commodities list |
| sc-craft | Search results + optional blueprint pages on warm |
| sc-trade | Ships + locations (+ route responses while TTL live) |
| sc-wiki | Game version, commodity pages, search + item detail for warm names |

**Stale-while-revalidate:** if the network fails, last good disk payload is still served.

**Refresh**

| Trigger | When |
|---------|------|
| Bot boot | Warm starts ~15s after start (non-blocking) |
| Interval | `ECONOMY_CACHE_REFRESH_MS` (default **6 hours**) |
| Manual | `!econ refresh` · status: `!econ cache` |

`!ask` economy grounding reads **disk only** (no network on the ask path).

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
| `UEX_CACHE_TTL_MS` | `21600000` (6h) | |
| `UEX_TIMEOUT_MS` | `8000` | |
| `UEX_API_KEY` | _(empty)_ | Optional |
| `ECONOMY_SCCRAFT` | `1` | `0` disables sc-craft |
| `SCCRAFT_API_BASE` | `https://sc-craft.tools` | |
| `SCCRAFT_CACHE_TTL_MS` | `21600000` (6h) | |
| `SCCRAFT_TIMEOUT_MS` | `8000` | |
| `ECONOMY_SCTRADE` | `1` | `0` disables `!trade` |
| `SC_TRADE_API_TOKEN` | _(empty)_ | **Required** for `/api/tools/*` (header `token`) |
| `SCTRADE_API_BASE` | `https://sc-trade.tools` | |
| `SCTRADE_CACHE_TTL_MS` | `1800000` (30m) | Route cache |
| `SCTRADE_TIMEOUT_MS` | `45000` | Route search can be heavy |
| `ECONOMY_SCWIKI` | `1` | `0` disables SC Wiki enrichment |
| `SCWIKI_API_BASE` | `https://api.star-citizen.wiki` | |
| `SCWIKI_CACHE_TTL_MS` | `43200000` (12h) | Wiki game-data TTL |
| `ECONOMY_CACHE_DIR` | `{dataDir}/economy-cache` | Disk cache root |
| `ECONOMY_CACHE_REFRESH_MS` | `21600000` (6h) | Background re-warm interval |

Shared rules for every remote client:

- Identifiable `User-Agent: Moneypenny-OrgEconomy/…`
- Long cache, short timeout
- Fail soft (never block music)
- Attribution on every live reply
- Public JSON only — never scrape SPAs (including star-crafting.com)

SC Trade tools licence: [Patreon sc_trade_tools](https://www.patreon.com/cw/sc_trade_tools/membership) · [Swagger](https://sc-trade.tools/swagger-ui/index.html)

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

## 6. Backlog (ops feedback — not v1)

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

## 7. Non-goals

- Live location heatmaps / in-world signature **scanners** (E-SIG is offline planning only)
- Loadout optimizers (lasers/modules)
- HTML scrape of scminer / star-crafting.com / SCMDB
- Invented offline craft items (seed craft stays empty)
- Full mission → blueprint ownership graph as a second product

---

## 8. Acceptance checklist (shipped)

- [x] `!mine` / `!refine` / `!craft` / `!workorder` / `!work-items` / `!econ` / `!trade` registered + public
- [x] Shopping-list replies (no step guidebooks)
- [x] Seed ores/methods offline without network
- [x] Craft via **in-game** blueprints only (sc-craft)
- [x] Optional UEX prices with cache + attribution
- [x] Optional sc-trade routes with token gate + attribution
- [x] SC Wiki enrichment + disk cache refresh
- [x] `!ask` economy keyword injection (seed + wiki cache)
- [x] No scrapers
- [ ] E-RAW / E-SIG / E-STN — see §6 backlog

---

## 9. Org doctrine (private)

Real logistics doctrine (routes, pads, preferred BPs) belongs in your **private** knowledge base.

Templates: [`docs/examples/doctrine/`](./examples/doctrine/) — copy privately, fill Routes / craft notes, reindex.

---

## 10. References

- UEX: [uexcorp.space](https://uexcorp.space/)
- SC Craft: [sc-craft.tools](https://sc-craft.tools/)
- SC Trade: [sc-trade.tools](https://sc-trade.tools/) · [Swagger](https://sc-trade.tools/swagger-ui/index.html)
- SC Wiki API: [api.star-citizen.wiki](https://api.star-citizen.wiki/)
- Seed: `bot/src/economy/catalog.ts`
