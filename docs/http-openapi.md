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
```

- **Public** (no session): `GET /api/openapi.json`, `GET /api/health`
- Document built from `bot/src/http/openapi/operations.ts` (catalog)
- Renderer: `bot/src/http/openapi/document.ts` → OpenAPI **3.0**

Import into Postman, Insomnia, or any OpenAPI 3 viewer. No Swagger UI is
bundled on-device (SBC footprint); point an external viewer at the JSON.

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
