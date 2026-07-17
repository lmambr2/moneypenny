> **HISTORICAL ARCHIVE** — point-in-time audit/notes. Paths and stack may be stale
> (e.g. `bot/src/ts-protocol`, `web/server.ts`, Qdrant). Current operator truth:
> [AGENTS.md](../AGENTS.md), [docs/editions.md](./editions.md), [docs/ts6-client.md](./ts6-client.md),
> [docs/rag-embeddings.md](./rag-embeddings.md), [docs/http-openapi.md](./http-openapi.md).

# Security audit — Economy dashboard / API — 2026-07-09

**Scope:** New economy WebUI (`/economy`) and REST surface (`/api/economy/*`)
introduced in the same session. Complements
[security-audit-2026-07-09.md](./security-audit-2026-07-09.md) and
[economy.md](./economy.md).

**Method:** Source review of `bot/src/web/api/economy.ts`, mount in
`bot/src/web/server.ts`, Vue `Economy.vue`, work-order store, external clients
(sc-craft / sc-trade / UEX / cache refresh). Cross-check against existing auth,
CSRF, rate-limit, and admin patterns. Vitest on economy router.

**Non-goals:** Full app re-audit; live pen-test; trade-token secret storage
rotation (env only, unchanged).

---

## Executive summary

**Posture after remediation:** Economy is **session-authenticated**, **CSRF-gated**
on mutations (global `/api` stack), uses **parameterized SQL**, **fixed external
bases** (no user-controlled SSRF URLs), and **Vue text interpolation** (no
`v-html`). Residual risk matches the rest of the dashboard: a signed-in member is
trusted like a public TS chatter for shopping-list ops, with **stricter web
controls** on destructive / expensive actions.

**No Critical / High** findings after remediations in this pass.

| ID | Severity | Status |
|----|----------|--------|
| E-M1 | Medium | **Fixed** — rate limits on network / trade / refresh / mutations |
| E-M2 | Medium | **Fixed** — admin-only `DELETE /workorders` (clear all) + cache refresh |
| E-M3 | Medium | **Fixed** — no absolute cache path in JSON; `rootLabel` only |
| E-M4 | Medium | **Fixed** — process-wide single-flight refresh (`runEconomyCacheRefresh`) |
| E-L1 | Low | **Fixed** — max open work orders (100); location filter array cap |
| E-L2 | Low | **Fixed** — generic errors (no user-string echo / internal exception leak) |
| E-A1 | Accepted | Member can add/done WOs + burn modest external quota (rate-limited) |
| E-A2 | Accepted | `scTradeToken: boolean` recon (not the secret) |
| E-A3 | **Fixed** | TS `!workorder clear` now requires rights `workorder.clear` (admin); refresh still public on TS, admin on web |

---

## 1. Trust boundary

```
Browser SPA ──cookie session──► Express /api
                                 ├── requireAuth (all economy routes)
                                 ├── csrfOriginCheck (POST/DELETE)
                                 └── /api/economy/*
                                       ├── local seed (mine/refine/catalog)
                                       ├── SQLite work_orders (parameterized)
                                       └── outbound fixed hosts:
                                           sc-craft.tools · sc-trade.tools ·
                                           api.uexcorp.space · api.star-citizen.wiki
```

User input becomes **query/body strings** (length-capped) or **integers**
(clamped). It never becomes a filesystem path, shell command, or redirect URL.

---

## 2. Findings (pre-remediation → post)

### E-M1 — Unthrottled network proxy (DoS / quota burn)

| | |
|--|--|
| **Severity** | Medium |
| **Location** | `POST /trade/*`, `GET /craft|blueprints|prices`, `POST /cache/refresh` |
| **Threat** | Authenticated member floods expensive sc-trade (token quota, 45s) or multi-source refresh. |
| **Impact** | API token exhaustion, outbound connection pile-up, bot event-loop pressure. |
| **Fix** | Token-bucket limits: network 20@1/s, trade 8@0.25/s, refresh 2@1/min, mutate 30@2/s. |

### E-M2 — Any member could wipe board / force full refresh

| | |
|--|--|
| **Severity** | Medium |
| **Location** | `DELETE /workorders`, `POST /cache/refresh` |
| **Threat** | Compromised **member** session (not only admin) clears org shopping list or hammers refresh. |
| **Impact** | Data loss on board; unnecessary multi-API load. |
| **Fix** | Web: **admin-only** for clear-all and cache refresh. Members still add/done. TS chat clear/refresh stay public (documented product split). |

### E-M3 — Absolute filesystem path disclosure

| | |
|--|--|
| **Severity** | Medium (info disclosure) |
| **Location** | `GET /overview`, `GET /cache` → `cache.root` |
| **Threat** | Leaks data-dir layout / usernames on multi-tenant hosts. |
| **Fix** | Return `rootLabel` (last path segment only). |

### E-M4 — Concurrent refresh stampede

| | |
|--|--|
| **Severity** | Medium |
| **Location** | `POST /cache/refresh` vs scheduler `refreshEconomyCatalogs` |
| **Threat** | Parallel full warms without single-flight on the HTTP path. |
| **Fix** | Shared `runEconomyCacheRefresh()` used by scheduler + API. |

### E-L1 — Unbounded work-order growth / large loc arrays

| | |
|--|--|
| **Severity** | Low |
| **Fix** | `MAX_OPEN_WORK_ORDERS = 100`; location filters capped at 8 strings × 80 chars. |

### E-L2 — Error message hygiene

| | |
|--|--|
| **Severity** | Low |
| **Fix** | Generic 4xx/5xx messages; log details server-side. |

### Accepted residual

- **E-A1:** Members may add/done work orders and run craft/price/trade lookups (rate-limited). Matches public TS economy commands for a trusted org dashboard.
- **E-A2:** Boolean “token configured” helps the UI; secret never returned.
- **E-A3:** TS clear/refresh remain public — different trust model (presence on org channel vs browser session).

---

## 3. What was already solid

| Control | Notes |
|---------|--------|
| Auth | Mounted after `requireAuth` |
| CSRF | Global same-origin check on POST/DELETE |
| SQL | `WorkOrderStore` uses prepared statements |
| SSRF | Client base URLs from env/constants only |
| XSS | Economy.vue: no `v-html`; mustache-escaped text |
| Body size | Global 2mb JSON limit |
| Secrets | Trade token only via env / `hasToken()` boolean |
| Input clamps | qty, scu, invest, stops, limit all bounded |

---

## 4. Remediations landed (this pass)

| Change | File |
|--------|------|
| Rate limits + admin gates + caps + path redaction | `bot/src/web/api/economy.ts` |
| Single-flight refresh helper | `bot/src/economy/cache/refresh.ts` |
| Admin-only clear / refresh UI | `bot/web/src/views/Economy.vue` |
| Tests: path + member clear-deny | `bot/src/web/api/economy.test.ts` |

---

## 5. Operator guidance

1. Keep WebUI **localhost / LAN + TLS**; do not expose to the open internet without reverse-proxy auth (existing hardening).
2. Grant **member** accounts only to trusted org operators.
3. Protect `SC_TRADE_API_TOKEN` in env (never commit); rate limits reduce burn, they do not replace secret hygiene.
4. Prefer dashboard **clear all** only when intentional (admin); day-to-day use **Done** per order.

---

## 6. Checklist

- [x] Auth on all economy routes
- [x] CSRF on mutations
- [x] No absolute path in cache JSON
- [x] Admin-only clear-all + cache refresh (web)
- [x] Rate limits on network/trade/refresh/mutate
- [x] Work-order open cap
- [x] Single-flight refresh
- [x] Tests green for auth, WO CRUD, admin clear, cache label
- [x] Optional follow-up: audit log rows for clear-all / refresh — **done** (`economy.workorders_clear` / `economy.cache_refresh` actions; wired in `server.ts`)
- [x] Optional follow-up: per-user (not only IP) rate-limit keys for multi-user LAN NAT — **done** (session user id keyFn on all four economy limiters)
