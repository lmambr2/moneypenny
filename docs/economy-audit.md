# Economy completeness audit — 2026-08-28

Point-in-time review of the org-economy subsystem on `dev` (`5e392dc`)
before adding Linux datarunner ingest. Live probes against Star Citizen
**4.10.0 LIVE** APIs the same day. Unit tests:
`cd bot && npx vitest run src/economy src/web/api/economy.test.ts` →
**18 files, 99 tests, all green**. Tests were not weakened.

Policy (unchanged): public JSON only, long cache, fail-open, attribution,
**no scrapers**. See [economy.md](./economy.md).

This is not a greenfield Star Citizen tool. Economy is already first-class
(`bot/src/economy/`, `/economy`, `!mine`/`!refine`/`!craft`/`!workorder`/
`!work-items`/`!trade`/`!econ`). The gap this audit names is **ingest of
raw terminal snapshots** — historically parked as OCR out-of-scope.

---

## Status legend

| Tag | Meaning |
|-----|---------|
| **WORKING** | Claimed behavior exists, wired, tests cover the real owner path (or a live probe succeeded) |
| **PARTIAL** | Code path exists but missing operator wiring, catalog drift, mocks hide a seam, or live data is optional |
| **BROKEN** | Code or catalog contradicts itself in-repo |
| **DEAD** | Documented non-goal or no code at all |

---

## Completeness matrix

| Surface | Claims | Code | Tests | Live 4.10 (2026-08-28) | Status |
|---------|--------|------|-------|------------------------|--------|
| Seed catalog `catalog.ts` | Offline ores + refine methods | `ORES` / `REFINE_METHODS`; `CATALOG_AS_OF` = 2026-07-08 DataHub+UEX snapshot | `catalog.test.ts` | n/a (offline) | **WORKING** |
| Seed import JSON | Frozen one-shot, not runtime | `data/seed-import-2026-07.json` + README | none (artifact) | n/a | **WORKING** (maintainer only) |
| `!mine` / `GET /mine` | Mining pull + stability clock | `orders.ts` `buildMineOrder` → `service.ts` / `economy.ts` | orders + service + API | n/a | **WORKING** |
| `!refine` / `GET /refine` | Yield / time / cost **estimates** | `buildRefineOrder`; method % same for every ore | orders + API (Dinyx 32 SCU → 14.4) | n/a | **WORKING** |
| `!craft` / `GET /craft` | In-game BOM via sc-craft | `sc-craft.ts` search+detail; seed `CRAFT_RECIPES` empty on purpose | sc-craft + service + API (mocked client) | `GET https://sc-craft.tools/api/blueprints?page=1&limit=2` → 200, `items[]` with `ingredients` | **WORKING** (live optional; tests mock) |
| `!econ blueprints` / `GET /blueprints` | Search live BPs | `ScCraftClient.search` | service + API | same host 200 | **WORKING** |
| `!workorder` / CRUD `/workorders` | Save BOM×qty to SQLite | `work-orders.ts` table `work_orders`; cap 100 | work-orders + work-order-service + API | n/a | **WORKING** |
| `!work-items` | Sum open WOs | `aggregateWorkOrders` + E-BOX crates | work-order-service | n/a | **WORKING** |
| `!workorder clear` | Admin-only wipe | TS rights `workorder.clear`; web `requireAdmin` | work-order-service + API member-deny | n/a | **WORKING** |
| E-BOX / E-FOOT `boxes.ts` | SCU → crates; ship max box | `calculateBoxes` / `largestCrateThatFits`; `GET /boxes` | boxes.test.ts | n/a | **WORKING** |
| E-FUZZY `fuzzy.ts` | Typo match ores/ships/UEX names | wired in catalog, sc-craft, sc-trade, uex, `/ores` | fuzzy.test.ts | n/a | **WORKING** |
| `!trade` / `/trade/*` | Routes, buyers, itinerary, circuit | `sc-trade.ts` OpenAPI tools; **token required** for `/api/tools/*`; ships/locations open GET | sc-trade.test.ts (mocked POST); API ships untested beyond enable flags | `GET /api/ships` 200 (87 ships); `GET /api/locations` 200 (201); POST `/api/tools/trades` without token/body → 400 validation (not 401 first) | **PARTIAL** — catalog GETs live; route tools need `SC_TRADE_API_TOKEN` (not in `.env.example`) |
| `!econ prices` / `GET /prices` | UEX sell/buy avg + supply | `uex.ts` `GET /2.0/commodities` + `/2.0/commodities_prices?id_commodity=` | uex.test.ts injects `fetchCommodities` / `fetchTerminalPrices` | `api.uexcorp.space` **and** `api.uexcorp.uk` `/2.0/commodities` 200, 205 rows; prices for id=1 → 33 terminals | **PARTIAL** — live API works; default base is still `.space` (UEX now recommends `.uk`); **no local snapshot overlay** |
| `GET /commodities` | Full UEX list for Prices dropdown | economy router | API test with mock list | same as prices | **WORKING** |
| E-UEX-SUP supply % | Terminal stock vs avg | `buildSupplyHint` | uex.test.ts | live rows include `price_sell`, `scu_sell_stock*` | **WORKING** |
| SC Wiki client | Enrich + `!ask` grounding from **L2 only** | `sc-wiki.ts` `/api/search`, `/api/{kind}/{slug}`, `/api/game-versions/default` | sc-wiki.test.ts mocked | `/api/game-versions/default` 200 `4.10.0-LIVE.12519617`; search Quantainium 200 | **WORKING** |
| SQLite L2 cache | `economy_cache` in main DB; SWR; 7d refresh | `cache/store.ts` + `cache/refresh.ts`; boot `initEconomyDiskCache` + scheduler | store + refresh tests (`:memory:` / tmp dir) | n/a | **WORKING** |
| `!econ cache` / `GET /cache` | Stats without absolute path | `cacheRootLabel`; chat `formatCacheStatus` | refresh + API | n/a | **WORKING** |
| `!econ refresh` / `POST /cache/refresh` | Warm catalogs; web **admin**; TS public | HTTP uses `runEconomyCacheRefresh` (single-flight). **Chat calls `refreshEconomyCatalogs()` directly** | refresh.test.ts covers single-flight of the helper, not the chat path | n/a | **BROKEN** (chat bypasses single-flight) |
| Dashboard `/economy` | Same surface as chat | `Economy.vue` tabs: work, mine/refine, craft, trade, prices, catalog, cache | no Vue unit tests for this view | n/a | **WORKING** (UI); no ingest tab |
| REST `/api/economy/*` | Session + CSRF + rate limits | `createEconomyRouter`; mounted after `requireAuth` | economy.test.ts (cookie auth, no CSRF in that harness) | n/a | **WORKING** |
| OpenAPI catalog | Drift guard vs Express | `operations.ts` + `route-catalog-drift.test.ts` | drift test is method+path only | n/a | **BROKEN** — `POST /cache/refresh` catalogued as **session**, code is **admin** |
| Env / Settings | UEX / sc-trade / wiki / cache keys | Clients read `process.env`; compose `env_file: .env` | `.env.example` **has zero economy keys**; Settings.vue **has no economy panel** | n/a | **PARTIAL** — code wired; operators cannot discover keys from `.env.example` |
| MCP `econ_run` / `workorder_run` / `work_items` | Same as `!mine` etc. | `mcp/tools.ts` + `mcp/server.ts`; workorder clear needs admin profile | mcp/tools.test.ts | n/a | **WORKING** |
| LLM tools | Economy function-calling | **None.** `llm/tools.ts` is music/moderation. `!ask` injects seed + wiki L2 via `context.ts` | context.test.ts | n/a | **WORKING** as designed (deterministic commands; ask is keyword inject) |
| Rights | mine/refine/craft/econ v3; trade v7; workorder v8 | `rights/migrations.ts` | rights tests elsewhere | n/a | **WORKING** |
| Terminal snapshot ingest | — | **No table, no route, no runner** | none | n/a | **DEAD** |
| UEX `data_submit` | — | No submit client | none | docs live; `data_parameters` 4.10.0, eval 90d | **DEAD** (Phase 2) |

---

## Per-feature notes (claims vs code vs tests)

### 1. Seed mine / refine

1. **Claims:** shopping-list estimates; Quantainium spelling; ⚠️ on unstable ores.
2. **Code:** `orders.ts` + `material-flags.ts` + `format.ts`. No network.
3. **Tests:** real seed data, not mocks.
4. **Live:** n/a. Seed dated **2026-07-08** — still usable for planning on 4.10; rock stats may have drifted.
5. **Gaps:** E-RAW / E-SIG / E-STN parked in economy.md §6b. Not must-fix.

### 2. Craft / work orders

1. **Claims:** in-game blueprints only; empty offline craft seed.
2. **Code:** `ScCraftClient` → `https://sc-craft.tools` (override `SCCRAFT_API_BASE`); L2 keys `search:` / `detail:`.
3. **Tests:** injected `fetchSearch` / `resolveBlueprint`. No live HTTP in CI (correct).
4. **Live:** blueprint JSON shape still matches (`id`, `blueprint_id`, `name`, `ingredients`, `craft_time_seconds`).
5. **Gaps:** none blocking. Work-order create 502s if sc-craft is down (fail message is generic).

### 3. Trade

1. **Claims:** routes/buyers/itinerary/circuit; token for tools.
2. **Code:** `header token: SC_TRADE_API_TOKEN`; open `GET /api/ships` and `/api/locations`.
3. **Tests:** body builders + mocked POSTs. Does not prove token header against live Swagger.
4. **Live:** ship/location catalogs 200 without token.
5. **Gaps:** token not in `.env.example`. Dashboard Trade tab shows a token-missing hint (good).

### 4. UEX prices

1. **Claims:** `!econ prices` sell/buy averages + top terminals; optional Bearer `UEX_API_KEY`.
2. **Code:** unauthenticated GET works; Bearer sent if `UEX_API_KEY` set. Default host **`api.uexcorp.space`**. Prompt/docs also mention `UEX_API_TOKEN` — **not read**.
3. **Tests:** fully injected. They would stay green if the live path 404'd.
4. **Live:** both `.space` and `.uk` returned 205 commodities. UEX docs (2026) **recommend `.uk`** after the 2025-08-22 infra split.
5. **Gaps:** no ingest; 7d TTL is org-planning not arb (intentional). No precedence for local snapshots.

### 5. Cache refresh

1. **Claims:** boot+interval+`!econ refresh`; single-flight (E-M4).
2. **Code:** `runEconomyCacheRefresh` is used by HTTP + scheduler. **`handleEcon("refresh")` calls `refreshEconomyCatalogs()`** — a second in-flight HTTP refresh can overlap the scheduler.
3. **Tests:** single-flight helper tested; command path not.
4. **Live:** n/a.
5. **Gaps:** must-fix the chat call site. OpenAPI auth mismatch (below).

### 6. Dashboard + OpenAPI

1. **Claims:** all `/api/economy/*` session; clear-all and refresh admin.
2. **Code:** matches security audit except OpenAPI lists refresh as session.
3. **Tests:** API auth/admin clear; drift test does **not** check `auth` field.
4. **Gaps:** catalog `POST /api/economy/cache/refresh` auth=`session` vs `requireAdmin`.

### 7. Operator wiring

1. **Claims:** economy.md §3 env table.
2. **Code:** clients read env. Compose bot uses `env_file: .env`, so keys flow if present.
3. **Tests:** `.env.example` inline-comment guard only — **does not require economy keys to exist**.
4. **Gaps:** `.env.example` / `.env.example.sbc` / `.env.example.server` omit economy. Settings UI has no UEX/sc-trade fields (secrets-in-env is acceptable if documented).

### 8. Ingest / datarunner

1. **Claims:** economy.md §6a “Out of scope (never core): OCR…”. Feature-roadmap E-SNAP parked.
2. **Code:** none.
3. **Tests:** none.
4. **Live:** UEX `POST /2.0/data_submit` documented; `secret-key` header; screenshot required for 90-day new-runner eval; `data_parameters` `evaluation_period_days: 90`, PTU reports off.
5. **Gaps:** this is the Phase 2 product, not a regression of shipped chat commands.

---

## Punch-list

### Must-fix (in-repo unfinished / contradictory)

| ID | Item | Owner |
|----|------|--------|
| **A-ENV** | Document economy keys in `.env.example` (and aliases `UEX_API_TOKEN`, ingest token). Compose already passes `.env`. | `.env.example` |
| **A-SFLIGHT** | `!econ refresh` must call `runEconomyCacheRefresh`, not `refreshEconomyCatalogs` directly. | `service.ts` |
| **A-OAPI** | OpenAPI `POST /api/economy/cache/refresh` auth → `admin`. | `operations.ts` |
| **A-UEXHOST** | Default UEX base → `https://api.uexcorp.uk` (keep `UEX_API_BASE` override; `.space` still works). | `uex.ts` |
| **A-INGEST** | No terminal-snapshot ingest, no local-vs-UEX precedence, no Linux runner. Required for Phase 2; **not** a rewrite of radio/voice/music. | new |

### Nice-to-have (do not block)

| ID | Item |
|----|------|
| N1 | Settings.vue economy panel (enable flags only; keep secrets in env) |
| N2 | Vue unit tests for Economy.vue |
| N3 | Live smoke test (opt-in) against UEX/sc-craft |
| N4 | E-RAW / E-SIG / E-STN (economy.md backlog) |
| N5 | E-UEX-KEY operator decision (parked) |
| N6 | Seed catalog bump after 4.10 mining patch |
| N7 | MCP `econ_run` does not include `work-items` (separate tool already) |

---

## What this phase will **not** do

- Invent a second economy product or guidebook UI
- Touch radio, voice, or music
- Scrape UEX / sc-trade / Erkul / RSI HTML
- Copy Shebuka / Olrik / SC Trade Companion OCR code
- Weaken existing vitest cases

Follow-up docs: [sc-economy-tooling.md](./sc-economy-tooling.md),
[linux-datarunner-plan.md](./linux-datarunner-plan.md).
