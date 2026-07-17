# Station HTTP API — OpenAPI (PR-C2)

**Decision:** keep **REST** + OpenAPI discovery. **Do not** add tRPC or a second
RPC stack beside the Express routers.

| Surface | Auth | Purpose |
|---------|------|---------|
| **REST** `/api/*` | Cookie session (+ CSRF on mutators) | Vue WebUI + operators |
| **MCP** `/mcp` | Bearer token (`MCP_TOKEN`) | Agents (Grok Build) — separate contract |
| **WebSocket** `/ws` | Cookie + Origin | Player live events |

MCP and REST share domain logic (bot instance, rights) but are **not** dual
OpenAPI stacks — MCP tools are documented in [mcp-server.md](./mcp-server.md).

---

## Discovery

With the bot running:

```bash
curl -sS http://127.0.0.1:3000/api/openapi.json | head
# Interactive UI (Swagger UI, local assets via swagger-ui-dist)
open http://127.0.0.1:3000/api/docs
```

| Path | Auth | Notes |
|------|------|--------|
| `GET /api/openapi.json` | public | OpenAPI **3.0** document |
| `GET /api/docs` | public | Swagger UI (try-it-out; cookie auth for session routes) |
| `GET /api/health` | public | Liveness |

Document built from `bot/src/http/openapi/operations.ts` (catalog).  
Drift guard: `src/http/openapi/route-catalog-drift.test.ts` fails CI if Express
routes and the catalog diverge.

---

## Maintaining the catalog

When you add or remove an Express route under `web/api/*`:

1. Update `API_OPERATIONS` in `bot/src/http/openapi/operations.ts`
2. Run `npm run test:bot -- src/http/openapi`
3. Prefer accurate `auth` (`public` | `session` | `admin`) and a short `summary`

Full JSON Schema for every body is optional — key auth endpoints carry
request bodies; others document method/path/auth only.

---

## Auth notes

| Level | Meaning |
|-------|---------|
| `public` | No cookie |
| `session` | Valid `moneypenny_session` cookie |
| `admin` | Session + `role === admin` |

CSRF: browser mutators under `/api` need same-origin `Origin`/`Referer`
([hardening](./hardening.md)). Non-browser clients should send a matching Origin
or call from the SPA origin.

---

## Phase C map

| Step | Status |
|------|--------|
| **C1** Plugin `createWebServer` | Done |
| **C2** REST + OpenAPI (no dual stack) | This doc |
| **C3** Nest/Fastify DI | Deferred |
