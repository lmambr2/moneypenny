# Changelog

Notable changes to Moneypenny. Dates are when the work landed on `master`/`dev`.

This project is developed with AI coding assistants; this log records **which
assistant** authored each batch of work, since not every commit carries a
`Co-Authored-By` trailer. Attribution here is the source of truth.

## 2026-07-17

### Fix: voice pause/resume lost the same song
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Root cause (round 1):** soft `player.pause()` destroyed by TTS "Paused";
  resume no-op'd; radio seed-pool restocked.
- **Root cause (round 2):** suppress/savedMusic armed *after* TTS — so "Paused"
  TTS trackEnd **restored music**, then leftover suppress made "Resumed" TTS
  **hold the queue** (kept playing after pause; silence after resume).
- **Fix:** pause checkpoint + hard stop; re-seek on resume; radio respects
  `isUserPaused()`; **preparePlaybackControlReply before TTS**; speak() never
  captures savedMusic while pause suppress is armed.
- Honest replies: "Already paused" / "Nothing to resume" / "Already playing"

## 2026-07-16

### Six-track: arm native, bridges, live feedback, VectorClient, Nest, audit
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Arm native audio:** Dockerfile `TARGETARCH` notes; `audio-native` README Pi-native path;
  host build still `./scripts/build-audio-native.sh` (+ optional cross)
- **Stream bridges:** [docs/stream-bridges.md](./docs/stream-bridges.md), compose comments,
  `.env.example` / Settings dual-URL hints (`TIDAL_BRIDGE_URL` / `SPOTIFY_BRIDGE_URL`)
- **Live station feedback:** `getLiveStatus` adds `voice` / `rag` / `feedback[]`; Live.vue
  auto-refresh + feedback panel
- **Rename:** `QdrantClient` → **`VectorClient`** (`bot/src/rag/vector-client.ts`)
- **Nest controllers:** `SystemController` owns public health / OpenAPI / docs HTML;
  `SYSTEM_BUNDLE_NEST` + `registerOpenApiStatic`
- **Historical audits:** HISTORICAL ARCHIVE banners on security-audit* + audit-findings + honeybbq plan

### Docs + audit: post-architecture cleanup
**Author: Grok (xAI), driven by Lane Ambrose.**

- Living docs updated: TurboVec (not Qdrant), nomic/bge embeds, Nest HTTP,
  `@moneypenny/ts6-client`, brain `/v1/turn`, packages layout (DESIGN/AGENTS)
- Editions, remote-llm, rag-ingestion*, roadmap, feature-roadmap, mcp-server,
  http-openapi, ts6-client status tables aligned with shipped stack
- Light code cleanup (optional-chain, comment accuracy)

### Ops: napi scripts, OpenAPI UI, catalog drift, station backlog UX
**Author: Grok (xAI), driven by Lane Ambrose.**

- `./scripts/build-audio-native.sh` (+ optional arm64 cross); `npm run build:native:arm64`
- Swagger UI at **`GET /api/docs`** (`swagger-ui-dist`); JSON still `/api/openapi.json`
- OpenAPI route↔catalog drift test + deploy-preflight gate
- Settings: doctrine prewarm callout, under-music checklist, ACE-Step mock/worker status
- ACE-Step health surfaces `mock` / `workerConfigured` from adapter

### Audio native + Nest HTTP (PR-B4 / PR-C3)
**Author: Grok (xAI), driven by Lane Ambrose.**

- **B4** `@moneypenny/audio-native` — Rust N-API Opus + energy RMS/VAD (libopus);
  encoder/VAD prefer native, fall back to `@discordjs/opus` / TS RMS
- **C3** NestJS domain modules + Express adapter (default `HTTP_FRAMEWORK=nest`);
  `HTTP_FRAMEWORK=plugins` keeps pure Express plugins
- Domain modules: system, mcp, session, brain, station-api, spa, websocket
- Docker build installs Rust + `libopus-dev` (native optional; fallback still works)

### Brain: Phase D turn transport (propose / dispose)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `bot/src/brain/` — `completeTurn`, `InProcessBrain`, `HttpBrain`, `disposeToolProposals`
- Harness uses brain → bot dispose (rights/dry-run unchanged)
- `POST /v1/turn` admin API (optional `executeTools`); OpenAPI tag `brain`
- `BRAIN_URL` env: empty = in-process LLM+RAG; set = remote `POST {url}/v1/turn`
- Soft-fail on brain outage (no music block); docs: [docs/brain-boundary.md](./docs/brain-boundary.md)

### HTTP: REST + OpenAPI catalog (PR-C2)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Keep REST only — **no tRPC dual stack**
- `bot/src/http/openapi/operations.ts` — operation catalog (session, player, bot, music, rag, economy, users, audit)
- `GET /api/openapi.json` public discovery (OpenAPI 3.0)
- Docs: [docs/http-openapi.md](./docs/http-openapi.md)
- MCP remains separate Bearer surface (`/mcp`), not listed as cookie routes

### HTTP: extract createWebServer plugins (PR-C1)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `bot/src/http/app.ts` — `createWebServer` composition only
- Plugins: security, public routes, MCP, session, protected API, static SPA, WebSocket
- Domain routers remain under `bot/src/web/api/*` (behavior-preserving)
- Removed monolithic `bot/src/web/server.ts`
- Security-headers test uses shared `securityHeadersMiddleware`

### Packages: `@moneypenny/ts6-client` public surface + dual-protocol docs (PR-B2 / B3)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Host imports only the package root (no subpath imports in bot)
- Documented public surface: connect / text / voice / file-drop + `TS3ClientEventMap`
- Barrel export surface locked by `public-api.test.ts`
- Dual-protocol detect docs: [docs/ts6-client.md](./docs/ts6-client.md) + package README
- PR-B4 (Rust Opus/VAD) explicitly deferred until profiled need

### Packages: extract `@moneypenny/ts6-client` (PR-B1)
**Author: Grok (xAI), driven by Lane Ambrose.**

- npm workspaces under `bot/` (`packages/*`)
- Moved `bot/src/ts-protocol/*` → `bot/packages/ts6-client` (`@moneypenny/ts6-client`)
- Logger decoupled via local `Ts6Logger` interface (pino-compatible inject)
- Bot imports package by name; Docker copies workspace package into runtime image
- Package owns its vitest suite

## 2026-07-15

### Control: CommandRegistry + middleware skeleton (PR-A1)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `bot/src/control/registry.ts` — handlers + middleware pipeline
- `bot/src/control/middleware.ts` — rightsGate / audioGuard / logInvoker helpers
- ControlRouter executes via registry (behavior-preserving)
- CommandSpec gains optional `rightsToken` / `llmTool` / `voiceScope` metadata

### Control: registerBotCommands on registry (PR-A2)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `registerBotCommands(registry, host)` is the primary handler installer
- `registerBotCommandHandlers(router, host)` → thin wrapper over `router.getRegistry()`
- Asserts every resolved/delegated/special command is registered
- Manifest `llmTool` aliases for play_music / queue / skip / now_playing / …

### Control: tool-map replaces toolCallToCommand switch (PR-A3)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `bot/src/control/tool-map.ts` — SPECIAL_TOOL_MAPPERS + manifest aliases
- `toolCallToCommand` re-exported from router for existing imports
- Registry `mapToolCall` / `toolToCommand` use shared map

### Control: thin ControlRouter (PR-A4)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `clarify-service.ts` — injectable MemoryClarifyService
- `deterministic-gates.ts` — rights / demo / radio / audio gates
- `llm-path.ts` — ask / intent / delegate / workflow execution
- ControlRouter is orchestration only (~515 LOC, down from ~910)

### RAG embeddings: nomic-embed-text-v2 / bge-large (replace embeddinggemma)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Defaults: SBC `nomic-embed-text-v2-moe`, Server `bge-large-en-v1.5`
- L2-normalize embeddings client-side for cosine/TurboVec
- Chunk defaults ~512 tokens / 50-token overlap (2048/200 chars)
- Optional `RERANKER_URL` + `bge-reranker-large` cross-encoder
- `./scripts/reembed-doctrine.sh` (+ `--wipe-index`); compose `ollama-embed-pull`
- Docs: [docs/rag-embeddings.md](./docs/rag-embeddings.md)

### MCP server for Grok Build (Phase 1 + 2)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Opt-in streamable HTTP MCP at `/mcp` (`MCP_ENABLED` + `MCP_TOKEN`)
- Phase 1: status_*, music play/add/skip/pause/ban, `rag_ask` / `rag_search`,
  `harness_turn` — same ControlRouter as dashboard/`!`
- Phase 2: `music_stop`/`clear`/`volume`/`mode`/`history`, `radio_set`,
  `doctrine_list`/`reindex`/`ingest_status`, `memory_*`, `harness_turns`
- Design: [docs/mcp-server.md](./docs/mcp-server.md); example
  `.grok/config.toml.example` + skill

### MCP finish: durable audit + packaging
**Author: Grok (xAI), driven by Lane Ambrose.**

- Every tool outcome audited (`mcp.tool` / `mcp.tool.denied` / `mcp.tool.error`)
- `runMcpTool` shared path for HTTP + tests; RELEASES smoke step for MCP enablement

### MCP Phase 3 + polish + TurboVec docs debt
**Author: Grok (xAI), driven by Lane Ambrose.**

- Phase 3 tools: `econ_run`, `workorder_run`, `work_items`, `generate_music`,
  `mod_mute`/`mod_kick` (moderation only when `MCP_ENABLE_MODERATION=1`)
- High-impact confirm: ban/stop/clear/mod need `confirm: true` (`MCP_REQUIRE_CONFIRM`)
- Operator docs: TurboVec as live vector store (README/ROADMAP/DESIGN/AGENTS)

### RAG: replace Qdrant with TurboVec bridge
**Author: Grok (xAI), driven by Lane Ambrose.**

- `services/turbovec-bridge` (TurboQuant IdMapIndex + SQLite payloads)
- Compose `turbovec` profile; `VECTOR_DB_URL=http://turbovec:6333`

### TurboVec bridge audit / bughunt
**Author: Grok (xAI), driven by Lane Ambrose.**

- SQLite id mapping regression tests (high-bit u64 ↔ signed int64)
- Hardened empty/missing collection search/delete (no process crash)
- `test_server.py` + README test recipe; operator docs no longer say “start Qdrant”

## 2026-07-10

### Library: Normalize doctrine formatting from the dashboard
**Author: Grok (xAI), driven by Lane Ambrose.**

- Admin **Library → Doctrine → Normalize formatting** (`POST /api/rag/doctrine/reformat`)
- Same heading/frontmatter pass as the host CLI; re-embeds only changed files

### Radio: ground doctrine rewrites in source (not meta regex only)
**Author: Grok (xAI), driven by Lane Ambrose.**

- User message = doctrine text only (stop putting "speak a bumper" in the prompt)
- Accept LLM rewrite only if content-words overlap source; else clipped prose
- Meta-regex stays as a secondary reject


### Music: block rap / hip-hop / R&B by default
**Author: Grok (xAI), driven by Lane Ambrose.**

- Station policy `musicBlockedGenres` (default rap, hip hop, hip-hop, R&B family)
- Filters `!play`/`!add` search, radio seed restock, and resolve/play
- Settings → **Blocked genres**; empty list disables the ban

## 2026-07-09

### Docs: README/ROADMAP radio sync
**Author: Grok (xAI), driven by Lane Ambrose.**

- README: radio seed mix, `!add` priority, alone-stop, voice reliability; test counts
- ROADMAP Phase 9 status updated for 2026-07 polish

### Radio: auto-DJ seed mix ~33% local / ~66% YouTube
**Author: Grok (xAI), driven by Lane Ambrose.**

- Seed restock searches local **and** YouTube (mega-mix filtered); default **⅔** external
- Profile knobs: `seedSources`, `seedExternalRatio`; Settings toggles + external %
- Spotify/Tidal free-text still via `playlistRefs`; seed **URLs** can use stream bridge

### Radio: stop speaking agent/rewrite instructions as bumpers
**Author: Grok (xAI), driven by Lane Ambrose.**

- Sanitize doctrine/memory LLM output — reject “rephrase / word limit / tone guide” echoes
- Skip ops cheatsheets & rank-gating RAG hits for on-air bumpers; fall back to clipped prose
- Log spoken `script` on bumper build; safer SOURCE/ANNOUNCEMENT prompt shape

### Radio: user !add jumps ahead of auto-DJ fill
**Author: Grok (xAI), driven by Lane Ambrose.**

- Queue songs carry `source: "user" | "radio"`
- Human adds insert before the first radio-fill track; radio restock still appends
- `!add` / web add report “up next #n”

### Economy: longer cache TTLs (org planning, monthly patches)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Defaults: UEX + craft **7d**, wiki **14d**, trade routes **3d**, catalog **7d**
- Background re-warm `ECONOMY_CACHE_REFRESH_MS` default **7d** (was 6h)
- After major SC patches: `!econ refresh` once

### Security: remediate Medium/Low from reliability+RAG audit
**Author: Grok (xAI), driven by Lane Ambrose.**

- Deep-merge nested config (`mergeBotConfig`); claim-check AbortSignal + delimited revise
- Barge-in restores `savedMusic`; doctrine ids by content hash; injection log LRU
- Clarify pending per invoker; playbook tool-name allowlist; voiceError* knobs

### Security audit: reliability + RAG/memory (findings + H-REL-1 fix)
**Author: Grok (xAI), driven by Lane Ambrose.**

- [docs/security-audit-reliability-rag-2026-07-09.md](./docs/security-audit-reliability-rag-2026-07-09.md)
- **Fixed:** stopBot mid-reconnect could revive bot / force autoStart — generation cancel + `startBot({ fromReconnect })`

### Reliability: event-driven reconnect + exp backoff (S-OC3)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `ReconnectScheduler` on remote disconnect for `autoStart` bots (`2s → 60s`)
- Intentional `stopBot` / `disconnect()` does not bounce; watchdog skips in-flight
- Config: `reconnect.eventDriven` (default true), `baseMs`, `maxMs`

### Reliability: voice transport self-heal (S-OC2)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `sendVoice` failures: 5 in 30s → `voiceTransportUnhealthy` → event reconnect
- Does **not** trip on Opus decode/DTX; healthy send streak clears window

### Reliability: speech barge-in (S-OC1)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `SpeechQueue` serializes TTS; inbound speech aborts bot TTS when `ttsBargeIn`
- Program music not stopped unless it was held for that TTS (`savedMusic`)
- Settings: Voice → Barge-in

### RAG/memory/intent: P1–P5 foundations (flags default off)
**Author: Grok (xAI), driven by Lane Ambrose.**

- **P2** typed budgets + injection dedup (`memory/turn-context`, wired into `LlmModule.ask`)
- **P5** `computeMemoryAxes` on eval-loop
- **P1** claim-check re-retrieve (`rag/claim-check`, `ragClaimCheck.enabled`)
- **P4** clarify-once (`control/clarify`, `intentClarifyOnce`)
- **P3** playbook store (`memory/playbooks`) — capture/retrieve ready; inject when enabled
- Design: [docs/rag-claim-check-and-typed-memory.md](./docs/rag-claim-check-and-typed-memory.md)

### Docs: TS6 ServerQuery command reference
**Author: Grok (xAI), driven by Lane Ambrose.**

- Add [docs/ts6-serverquery-commands.md](./docs/ts6-serverquery-commands.md) —
  TS6 query verb cheat sheet (grouped + alphabetical), Moneypenny path map
  (full client vs HTTP Query vs SSH), design rules
- Command overview adapted from MIT [jxcsx/ts6-query-web-interface](https://github.com/jxcsx/ts6-query-web-interface) `cmds.txt`
- Cross-link from [docs/feature-roadmap.md](./docs/feature-roadmap.md)

### Docs: openclaw-teamspeak steal notes (3 gaps only)
**Author: Grok (xAI), driven by Lane Ambrose.**

- [docs/openclaw-teamspeak-steal-notes.md](./docs/openclaw-teamspeak-steal-notes.md) —
  keep S-OC1 barge-in, S-OC3 reconnect backoff, S-OC2 narrow transport self-heal;
  dump identity/VoiceBuffer/global STT queue/OpenClaw host (already better)

### Docs: five RAG/memory/intent upgrades (design only)
**Author: Grok (xAI), driven by Lane Ambrose.**

- [docs/rag-claim-check-and-typed-memory.md](./docs/rag-claim-check-and-typed-memory.md) —
  **P1** claim-check re-retrieve, **P2** typed budgets + injection dedup,
  **P3** procedural playbooks, **P4** clarify-once, **P5** R3 memory eval axes;
  all flags default off; music fail-open unchanged

### Radio: alone-stop via honeybbq enter/leave/moved
**Author: Grok (xAI), driven by Lane Ambrose.**

- Wire **`clientEnter` / `clientLeave` / `clientMoved`** through `TS3Client`
- On membership change: `listClients` → human count → alone-stop / resume
- **0 humans** (only bot) → stop + clear queue; **≥1** after stop → auto-program
- `emptyChannelStopSeconds`: **0** immediate (default), **N** grace, **-1** off
- Idle poll kept as **backup** only; alone-stop ignores voice activity TTL
- Docs: [docs/radio.md](./docs/radio.md)

### Security/bug sweep addendum: web deps, recordings, yt-dlp scheme guard
**Author: Claude Fable 5 (Anthropic), driven by Lane Ambrose.**

- **Web deps:** `bot/web` npm audit had 7 vulns (1 high) — `npm audit fix` bumped
  `form-data` (high, CRLF injection) + `postcss`; removed **unused** `node-vibrant`
  dependency (never imported; carried the remaining 5 moderates). Now **0 vulns**.
- **Recordings upload cap fix:** base64 recording bodies hit the global 2 MB JSON
  limit → uploads over ~1.5 MB failed 413. Scoped `70mb` parser for
  `/api/bot/recordings` (matches `writeRecording`'s 50 MiB cap; admin-gated route).
- **Recordings download header:** `Content-Disposition` echoed the raw
  `:name` param; now sanitized via `safeRecordingBasename` before lookup + header.
- **yt-dlp URL guard:** `safeYtDlpMediaUrl` treated non-http(s) URLs
  (`ftp://youtube.com/…`) as bare ids, bypassing the public-URL check; now rejects
  any non-http(s) scheme. Tests added for all three fixes.
- **Economy audit follow-ups closed:** audit log rows for work-order clear-all and
  cache refresh (`economy.workorders_clear` / `economy.cache_refresh`); per-user
  (session id) rate-limit keys on all economy limiters; `!econ cache` chat output
  redacts the absolute cache path (shared `cacheRootLabel` in the store); scheduler
  first-warm timeout tracked/unref'd and cancelled on stop.
- Audit notes appended to [docs/security-audit-2026-07-09.md](./docs/security-audit-2026-07-09.md).

### Economy: community code lifts (E-BOX / E-FUZZY / E-UEX-SUP / E-FOOT)
**Author: Grok (xAI), driven by Lane Ambrose.**

- **E-BOX** — `boxes.ts` greedy SCU→crates (`64` → `2×32`); wired into `!work-items`, craft BOM lines, dashboard
- **E-FOOT** — crate footprints + `largestCrateThatFits`; trade ships show max crate; `GET /api/economy/boxes`
- **E-FUZZY** — `fuzzy.ts` typos/confusables for ores, methods, craft, trade ships, UEX, `!econ search`
- **E-UEX-SUP** — per-commodity `commodities_prices` (12h TTL) → supply % + top terminals on prices
- Docs: [docs/BUILD.md](./docs/BUILD.md) · [docs/economy.md §6a](./docs/economy.md)

### Economy: community code lifts roadmapped
**Author: Grok (xAI), driven by Lane Ambrose.**

- High-value pure-TS lifts from open haul tools ordered; research bookmarks retired

### Economy: SQLite L2 cache
**Author: Grok (xAI), driven by Lane Ambrose.**

- Replace file JSON cache with SQLite table `economy_cache` (default: main bot DB)
- One-shot migrate from legacy `data/economy-cache/**/*.json`
- SWR for UEX commodities + trade ships/locations; craft **detail** + trade **routes/buyers** on L2
- Inflight coalesce for trade ships/routes/buyers; row cap (`ECONOMY_CACHE_MAX_ROWS`)
- Docs: [docs/economy.md](./docs/economy.md) § Local cache

### Economy: full dashboard panel + residual close-out
**Author: Grok (xAI), driven by Lane Ambrose.**

- Vue **`/economy`** panel (nav + mobile): work orders, mine/refine, craft, trade, prices, catalog, cache
- REST **`/api/economy/*`** — craft/prices/trade routes·buyers·**itinerary·circuit**, work orders, cache
- **Security:** rate limits; admin clear-all (web) + TS `workorder.clear` rights token; path redaction;
  max 100 open WOs; single-flight refresh; boot-time WO/cache init
- Dedicated tests: catalog, format, uex, cache/refresh, work-order-service, API
- Docs: [docs/economy.md](./docs/economy.md) · [security-audit-economy-2026-07-09.md](./docs/security-audit-economy-2026-07-09.md)

### Economy: TS6 ⚠️ flags + shopping-list tighten
**Author: Grok (xAI), driven by Lane Ambrose.**

- Unstable/critical ores (Quantainium, Stileron, …) marked with **⚠️** on mine/refine/craft/work lists
- `!mine` / `!refine` / `!craft` are short shopping lists (no step guidebooks); Dinyx yield ~45% all ores
- Backlog E-RAW / E-SIG / E-STN documented (not implemented)

### Economy: !workorder / !work-items (org shopping list)
**Author: Grok (xAI), driven by Lane Ambrose.**

- `!workorder <item> xN` — resolve sc-craft BOM, scale, save open work order
- `!work-items` — aggregate org material totals (shopping list, not a guidebook)
- `!workorder list|done <id>|clear` — manage board
- SQLite `work_orders` table; public rights (migration v8)

### Economy: shared disk cache + SC Wiki enrichment
**Author: Grok (xAI), driven by Lane Ambrose.**

- Persistent `data/economy-cache/` for UEX, sc-craft, sc-trade, **api.star-citizen.wiki**
- Stale-while-revalidate; auto-refresh on boot + `ECONOMY_CACHE_REFRESH_MS` (default 6h)
- `!econ cache` / `!econ refresh`; `!ask` uses wiki **disk** snippets for grounding
- Docs: [docs/economy.md](./docs/economy.md)

### Economy: sc-trade.tools full trade routes
**Author: Grok (xAI), driven by Lane Ambrose.**

- Optional **SC Trade Tools** client (`bot/src/economy/sc-trade.ts`) — OpenAPI routes,
  buyers, itinerary, circuit; ship/location catalog
- `!trade routes|itinerary|buyers|circuit|ships` (rights public; needs `SC_TRADE_API_TOKEN`)
- Env: `ECONOMY_SCTRADE`, `SC_TRADE_API_TOKEN`, `SCTRADE_*`
- Docs: [docs/economy.md](./docs/economy.md)

### Economy: sc-craft.tools live blueprints
**Author: Grok (xAI), driven by Lane Ambrose.**

- Optional **SC Craft Tools** client (`bot/src/economy/sc-craft.ts`) — public JSON API,
  6h cache, fail-open, attribution (same etiquette as UEX)
- `!craft` tries seed recipes first, then sc-craft name search
- `!econ blueprints <query>` lists / details BOMs
- Env: `ECONOMY_SCCRAFT`, `SCCRAFT_API_BASE`, `SCCRAFT_CACHE_TTL_MS`, `SCCRAFT_TIMEOUT_MS`
- Docs: [docs/economy.md](./docs/economy.md)

### Backlog ship: H6/G3–G4/R5/V2–V3 + audit hardening + recordings
**Author: Grok (xAI), driven by Lane Ambrose.**

- **H6:** `scope` config (channel hint / server label / virtual server id) + Live status
- **G3:** Member read-only `/live` + `GET /api/bot/live` (now-playing, queue, radio hint)
- **G4:** Rights-gated `!mute` / `!kick` (fail-open; music unaffected)
- **R5:** `!ops members` / `!ops fleet` via ScOrgClient (fail-open)
- **V3:** `!radio speak-status` / `announce` spoken radio status
- **V2:** voice-backends STT ladder docs remain source of truth for editions
- **Hardening leftovers:** LLM status admin-only; private-memory audit; ACE loopback publish;
  `trustProxyHops` XFF rate-limit keys; harness intent dry-run + safer tool allowlist
- **Recordings:** opt-in dashboard capture/upload under `data/recordings/` (`/recordings` UI)
- **V4 / brain:** still plan-only (not implemented)

### Security audit + small P0 fixes
**Author: Grok (xAI), driven by Lane Ambrose.**

- **docs/security-audit-2026-07-09.md** — security / bugs / refactors after harness-ops arc
- **Fix:** `scripts/rights-rank-gating.json` includes public `ops` (template drift)
- **Fix:** SC org status URL http(s) only (`normalizeScOrgBaseUrl`)

### Feature roadmap follow-up: H3, V1/H4, G2 depth, R3
**Author: Grok (xAI), driven by Lane Ambrose.**

- **H3:** Memory scopes on Harness (private vs org) + `GET /api/bot/memory/scopes` / `private`
- **V1/H4:** Under-music progressive wake (`voice/under-music.ts`, API, `scripts/voice-under-music-check.sh`)
- **G2 depth:** `ScOrgClient` + Settings URL + [docs/sc-org-status.md](./docs/sc-org-status.md)
- **R3:** Eval loop + `POST /api/bot/rag/eval` + `scripts/rag-eval.mjs`

### Feature roadmap sprint: harness cockpit + org depth
**Author: Grok (xAI), driven by Lane Ambrose.**

- **H1/H2/H5:** Admin **Harness** panel (`/harness`) + `POST /api/bot/harness/ask` —
  structured turns (user, reply, RAG sources with classification, tool records, errors)
- **R4:** `POST /api/bot/org-kg` org fact seed; memory bumper `searchOrg` (MemPalace then SQLite KG; never private `!remember`)
- **R1:** Default radio profiles include **mining** + curated doctrine-aligned topic packs
- **R2:** `GET /api/rag/doctrine/hygiene` classification audit; Library **Hygiene** button
- **G1/G2:** `!ops` org status surface; fail-open external status plugins (`host`, `sc-org`)
- **Brain:** [docs/brain-boundary.md](./docs/brain-boundary.md) OpenAPI-ish `POST /v1/turn` (plan only)
- No Pi deploy this sprint

## 2026-07-08

### Radio: docs scrub, tooltips, presence gate, prewarm, color
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Presence gate fix:** count humans excluding bot/query (`countChannelHumans`);
  refresh presence on each track boundary; log gate / empty-source skips
- **Pre-generate bumpers:** Settings + `!radio prewarm` → TTS cache
- **Music color / quality:** AM/FM/telephone/vinyl/lofi on music decode
- **Dashboard tooltips:** Settings → Radio/DJ + Library Track tags (`title` + hints)
- **docs/radio.md** operator section (every-N, forced vs scheduled, log lines)
 
### Flesh-out: thin-feature audit findings
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Embedded tags:** LocalProvider seeds TagStore from ID3 genre/BPM/key (`source: embedded`)
- **Bulk tags:** `PATCH /api/music/tracks/tags/bulk` + Library bulk genre/mood apply
- **ratingWeight / harmonicSequencing:** real pool ordering (`rating-weight.ts`, `harmonic.ts`) + Settings harmonic toggle
- **Analyzer honesty:** product tool surface is keyfinder only (no fake essentia/bliss)
- **Tidal `/playlist`** on tidal-bridge; **Spotify health** splits librespot audio vs Web API metadata
- **ACE-Step:** non-mock requires `ACE_STEP_WORKER_URL` (no silent stub success)
- Docs: BUILD/ROADMAP/radio phasing honesty; Vue test not marketed as browser E2E;
  `stt-whisper` rknn error points at `stt-rknn`

### Library: LLM genre/mood guess
**Author: Grok (xAI), driven by Lane Ambrose.**

- `POST /api/music/tracks/:id/tags/guess` — title+artist → LLM → genre/subgenre/mood
  (`source: api`; manual edits still win)
- Library Track tags: per-row **Guess** + **Guess missing (LLM)** batch
- Module `bot/src/music/tag-guess.ts` + tests; docs/radio.md §9.5

### NPU STT runtime opts (stt-rknn)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Multi-core init chain (`RKNN_CORE_MASK`, prefer 0_1_2) with logged mask
- Faster log-mel (precomputed window, \|z\|² without abs), reused mel buffers
- Decoder step cap (`RKNN_MAX_DECODE_STEPS`); CPU unit tests for preprocess

### Tooling: Biome lint + format
**Author: Grok (xAI), driven by Lane Ambrose.**

- `@biomejs/biome` in `bot/`; config `bot/biome.json` (bot + web sources)
- Scripts: `npm run lint` / `lint:fix` / `format` / `check`
- Deploy preflight + full `ci-validate` run Biome; VS Code settings + [docs/linting.md](./docs/linting.md)

### Security audit + SSRF hardening
**Author: Grok (xAI), driven by Lane Ambrose.**

- Audit: [docs/security-audit-2026-07-08.md](./docs/security-audit-2026-07-08.md)
- **High:** DNS rebinding defense on stream play + yt-dlp CDN hop + engine final gate
  (`assertPublicPlaybackUrl` / `assertSafePlaybackTarget`)
- **Medium:** extra compose host denylist; CSRF host compare case-insensitive
- Refactor: session cookie parse via shared `extractSessionToken`
- **Bugfix (non-security):** PlayQueue `forwardStack` rewrite on remove/addNext (stale
  index → undefined next in random mode)
- Tests: url-guard, stream, csrf, playback engine SSRF refusal, queue forwardStack

### Meta: Grok listed as a repo contributor
**Author: Grok (xAI), driven by Lane Ambrose.**

- [CONTRIBUTORS.md](./CONTRIBUTORS.md) — humans + AI agents (Grok, Claude, …)
- README credits link; commit trailers `Co-Authored-By: Grok <noreply@x.ai>`
  (same pattern Claude used with `noreply@anthropic.com`)

### Backlog clear — feature-complete BUILD slice
**Author: Grok (xAI), driven by Lane Ambrose.**

- **R-R6:** Icecast tee (`IcecastTee` + `player` `pcm` event → `teeIcecastPcm`), relay-in timer bumpers (`relay.ts`; stop on non-relay / radio off), Settings Icecast toggle
- **Spotify:** `StreamProvider.getPlaylistSongs` via bridge `/playlist`; `services/spotify-bridge` + compose profiles `spotify`/`stream`
- **STT:** `resolveSttModelSelection` large-v3 + RKNN INT8 paths; health exposes model/compute; server compose `STT_MODEL=large-v3` docs
- **ACE-Step:** `docker-compose.ace-step.yml` + `services/ace-step-adapter` mock adapter
- **Vue E2E:** admin login flow (`bot/web/src/e2e/admin-login.e2e.test.ts`)
- **R-live / V-live:** opi5 health + STT base NPU verified; in-repo ops/command substitutes
- `docs/BUILD.md` — no open Queued/Later incomplete rows

### Voice: softer music duck default
**Author: Grok (xAI), driven by Lane Ambrose.**

- Default duck volume **25** (was 2 / near-mute); migrate saved `2` → `25` (runtime + Settings load)
- Settings / docs updated
- `!generate status`; prune skips now-playing track
- Web Library **Generate** button (`POST /api/bot/ace-step/generate`)

### ACE-Step A5–A6 — prune, tags, host docs
**Author: Grok (xAI), driven by Lane Ambrose.**

- Auto-prune oldest gens beyond `aceStepMaxFiles` (default 40); `!generate prune`
- Prompt heuristics for genre/mood/bpm tags
- [docs/ace-step-host.md](./docs/ace-step-host.md) LAN GPU setup

### ACE-Step A4 — radio auto-fill
**Author: Grok (xAI), driven by Lane Ambrose.**

- Dead air / empty profile pool → ACE-Step when `aceStepAutoFill` (fail-open)
- `!radio gen <prompt>` alias; prompt from profile tone/topics/seeds

### ACE-Step A3 — Settings UI
**Author: Grok (xAI), driven by Lane Ambrose.**

- Settings → ACE-Step: enable, URL, timeout, output dir, auto-fill flag
- `GET /api/bot/ace-step/status` health probe; live apply via `updateAceStep`

### ACE-Step A2 — !generate → library → play
**Author: Grok (xAI), driven by Lane Ambrose.**

- `GenerateProvider`: job poll, shared path or audio download, index under `generated/ace-step/`
- `!generate <prompt>` (@dj/admin); 3/hour rate limit; max 1 concurrent
- Config: `aceStepEnabled`, `aceStepUrl`, `aceStepTimeoutMs`, `aceStepOutputDir`

### Next-slice: @dj tags, deploy excludes, ACE-Step A1
**Author: Grok (xAI), driven by Lane Ambrose.**

- PATCH `/api/music/tracks/:id/tags` allows admin **or** `radio.tags` (@dj) web users
- `deploy-to-pi.sh` excludes convert `.venv` / vendor / hf
- ACE-Step HTTP client + config keys (docs/ace-step.md A1)

### Radio / DJ Settings: sources + org memory on air
**Author: Grok (xAI), driven by Lane Ambrose.**

- Bumper source checkboxes + `memoryBroadcastOptIn` in Settings
- Persist via existing radio API validation
- `docs/radio.md` smoke + dashboard notes

### Voice polish (under music)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Settings: duck volume + listen window (seconds); Piper placeholders
- Quiet “duck skipped when idle” logs (debug only)
- `docs/voice.md` under-music tips for base NPU

### Phase 8 roast polish
**Author: Grok (xAI), driven by Lane Ambrose.**

- `!roastin` rejoin after opt-out; capture sanitizes BBCode/URLs
- Settings applies `roastMinScore` live; richer `!roast` status
- `docs/roast.md` operator guide; ROADMAP marked shipped

### Phase 7 polish — memory A1–A5
**Author: Grok (xAI), driven by Lane Ambrose.**

- **A1** `docs/memory.md` operator guide + smoke checklist
- **A2** Voice `remember` / `recall` / `forget` shape rules (real payloads only)
- **A3** Radio org-memory bumper when `memoryBroadcastOptIn` (KG only, never private)
- **A4** Await MemPalace on remember/forget; richer sync status + Settings messages
- **A5** `install.sh --with-memory` → profile `memory` + `MEMPALACE_URL`

### SBC STT default — Whisper base on NPU (RKNN)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Product default for `voice-edge`: `STT_MODEL=base`, `STT_BACKEND=rknn`,
  `STT_DEVICE=npu` (was CPU `small` / optional NPU `tiny`)
- Validated live: base RKNN snappier and cleaner than faster-whisper `small` on CPU
- Export: `MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh` →
  `models/rknn/whisper-base-{encoder,decoder}.rknn`
- Zoo ladder note: tiny / base / medium only (no Rockchip `small`)
- Updated `install.sh`, compose overlays, `.env.example*`, voice docs, RELEASES

### V2 — remove sherpa/Kokoro (Whisper + Piper only)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Deleted compose profile `voice`, services `sherpa-stt` / `kokoro`, volume `kokoro-models`
- Removed `services/sherpa-stt/` tree and install `--with-voice-legacy`
- `voice-smoke.sh` / `ci-validate` / `voice-profile.sh` target dual-track + mock only
- Docs: `docs/voice-backends.md`, `docs/voice.md`, hardening, AGENTS, BUILD V2 **Done**
- Bot HTTP client class names `SherpaSttClient` / `KokoroTtsClient` kept (historical); contract unchanged

### Dual-track STT — RKNN on SBC, whisper.cpp on Server
**Author: Grok (xAI), driven by Lane Ambrose.**

- **SBC:** `services/stt-rknn` — Rockchip NPU RKNN Whisper with
  **faster-whisper CPU fallback** until `.rknn` weights + full mel pipeline land
- **Server:** `services/stt-whisper-cpp` — **whisper.cpp** (`whisper-cli`) with
  optional **Vulkan** build (`WHISPER_VULKAN=1`) for AMD
- Same compose service name `stt-whisper` / bot URL; overlays swap the image
- Docs: `docs/voice-backends.md`, edition env examples, install voice defaults
- **AMD packaging:** `docs/gpu-amd.md`, `docker-compose.server.rocm.yml`,
  `scripts/detect-gpu.sh`, `scripts/check-analyst-vram.sh` (R9700 ~32 GB →
  both-resident-ok), `scripts/download-whisper-ggml.sh`
- Pi smoke: dual-track voice live (CPU tiny fallback), LAN chat → `.89:11434`
  12B, Piper TTS, sherpa/Kokoro stopped
- **RKNN Whisper tiny built** (20s FP export) + zoo mel/decoder path on Pi NPU;
  live ASR smoke: *“Mr. Quilter is the apostle…”* on `test_en.wav`

### Dual editions — SBC + Server product packaging
**Author: Grok (xAI), driven by Lane Ambrose.**

One repo, two releases ([docs/editions.md](./docs/editions.md), [RELEASES.md](./RELEASES.md)):

- **SBC** (`docker-compose.sbc.yml`, `.env.example.sbc`): RK3588 edge — E2B
  fallback + embeddinggemma, Whisper **tiny**, Piper British TTS; chat prefers LAN 12B
- **Server** (`docker-compose.server.yml`, `.env.example.server`): x86 — Gemma 4
  **12B** local, Whisper **small** / **large-v3**, same Piper voice
- `install.sh --edition sbc|server|auto` writes `COMPOSE_FILE` + `COMPOSE_PROFILES`
- `scripts/detect-edition.sh`, `scripts/package-release.sh` → `dist/release/*.tar.gz`
- DESIGN v3, ROADMAP, README, AGENTS, remote-llm, voice-backends rethought for
  dual-host product (NPU = offline opt-in, not day-to-day chat)

### Security audit remediation + Pi perf + STT alias removal
**Author: Grok (xAI), driven by Lane Ambrose.**

Security (F1–F11):
- **F1** yt-dlp: every HTTP input gated (`safeYtDlpMediaUrl` / YouTube host only)
- **F2** web↔TS nickname: exact case-insensitive match only (no substring rank steal)
- **F3/F4** `url-guard`: CGNAT, IPv4-mapped IPv6; `assertPublicPlaybackUrl` DNS check;
  bridge `streamUrl` revalidated
- **F5–F7** cover embed cap 48 KiB; music upload 40 MiB×5; queue-replace needs `clear`
- **F8–F11** generic player 500s; history limit 1–200; CSRF before `/api/session`;
  docs for unused `BOT_SESSION_SECRET`

Pi perf:
- Voice: demote hot-path logs; single-pass PCM peak + Int16Array; prune client maps;
  cache passive KWS rank; cache-first subject; voice `allowedClassifications` parity
- Player: chunk queue (no per-chunk concat); Int16 volume path
- TagStore prepare-once ratings; `play_history(botId)` index

Voice STT:
- **Removed** `VOICE_COMMAND_ALIASES` / `COMMAND_MODE_ALIASES` and wake garble list
  (no English-word → command translation). Shape checks + exact verbs only.

### Voice false-positive hardening (follow-up)
**Author: Grok (xAI), driven by Lane Ambrose.**

Corrected the earlier "0 voice commands executed" audit: Pi logs show
`play Toto Africa` *did* start playback after `974ea1d`. Remaining failures were
**false-positive command extraction** from channel banter and bare `play`.

- **`voiceCommandShapeOk`:** zero-arg commands (`now`, `pause`, …) reject trailing
  free-form junk; `forget` only accepts `all` / a number; `vol` needs digits.
- **`extractPlaybackVerb`:** deep-scan only short utterances (≤5 tokens); long
  speech only accepts leading/`play <title>`.
- **Partial-safe set:** drop `now`/`queue` (common English false-fires).
- **Silence-tail finals:** allow `play <title>` on peak-0 endpoint; still reject
  bare play/search without a title.
- **Tests:** live-log cases in `watchword.test.ts`.

**Open:** re-smoke voice on opi5 after deploy; banter should not trigger `now`/`forget`.

### Session handoff + design-doc sync — `3e352cb`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Design docs:** Synced 9 files to July 2026 shipped state (test counts 797+11,
  radio UI/profiles, voice Opus/duck, Gemma split-brain, deploy scripts, tidal-bridge).
- **Handoff:** `docs/session-handoff-2026-07-08.md` — Angelsfear investigation,
  `974ea1d` voice work, doc audit, 12h Pi performance audit.

### Voice Opus hardening + command/voice logging — `974ea1d`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Invoker logging:** `invokerFields()` in `bot/src/control/router.ts` — text
  command routing logs `invokerName`, `invokerUid`, `invokerClientId` on match,
  resolve, deny, and execute.
- **Voice diagnostics:** per-client `"Voice: first inbound packet from client"`
  log (`bot/src/bot/voice/session.ts`); rate-limited Opus decode failure warnings;
  `decodeFailures` + `multiFrameRecoveries` in voice capture summary.
- **Opus decode:** `bot/src/audio/opus-packet.ts` + `opus-voice.ts` — decode-first
  path with multi-frame fallback; valid tiny silence frames (≤12 bytes) no longer
  skipped as DTX before decode.
- **Tests:** `opus-packet.test.ts`, `opus-voice.test.ts`, router invoker tests.

**Open:** live TS6 voice round-trip smoke on opi5 with the `voice` profile.

## 2026-07-06

### R3 — Pandoc export + workflow docs — `d327f64`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Pandoc export:** `bot/src/docs/export.ts` — markdown → docx/pdf via `pandoc`;
  `GET /api/rag/doctrine/:source/export`, capabilities probe, Library **Export** button.
- **Docker:** `pandoc` added to `bot/Dockerfile` runtime image.
- **Docs:** `docs/r3-workflows.md` (INTSUM/AAR/analyst + export); `docs/rag-ingestion.md`
  export section; DESIGN §R3 status updated.

### Radio dashboard + `!radio pin` — `e02b87f`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **`!radio pin`:** copies the last played bumper into `data/bumpers/` for reuse;
  `radio.pin` rights token; migration v2 (`bot/src/radio/pin.ts`).
- **Dashboard:** Settings **Radio / DJ** panel (toggle, sliders, profile picker, test
  bumper, status); Library **Track tags** + star ratings (`StarRating.vue`).
- **APIs:** `GET /api/bot/radio/status`, `POST /api/bot/radio/test-bumper`,
  `GET /api/music/tracks/:id/tags`; settings payload includes `radio` block.
- **Starter profiles:** `lobby` and `focus` in `defaultRadioConfig()`.
- **Docs:** `docs/intercom.md` (listen-only voice delegate design); `docs/voice.md`
  listen window corrected to 15s; `docs/radio.md` status updated.

**Open:** TS live radio smoke on opi5; OQ3 `library-tag-scan` on full music corpus.

## 2026-06-20

### Security audit + rank gating
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Security (merged `main`):** SSRF guard on music URLs, secret redaction in logs,
  player API hardening, avatar path guard, env fallback hygiene (`bot/src/music/url-guard.ts`,
  `bot/src/data/bot-secrets.ts`, web player routes).
- **Custom rank gating:** `scripts/rights-rank-gating.json` starter template with
  placeholder server-group tiers; doctrine clearance ladder wired through `commandGroups`.
- **TS6 group resolution:** HTTP Query enriches `serverGroups` for rank checks when the
  full client omits them; web volume follows TS rank, not Moneypenny web admin role.
- **`!follow`:** implemented channel move; TS error 770 (already in channel) treated as success.
- **Doctrine upload cap:** 5 MiB → 15 MiB (web upload, editor, TS file-browser drop).
- **Docs:** `docs/rank-gating.md`; scrubbed stale limits and rights examples in README / rag-ingestion.

### R4 — channel moves (continued)
**Author: Grok (xAI), driven by Lane Ambrose.**

- **NL/voice:** `move_client` / `move_all_clients` LLM tools (included when invoker
  has `moveclient` rights); fuzzy chat + voice routing.
- **Mass move:** `!moveall <channel>` stages moves for others in-channel;
  `!moveall confirm` within 30s (max 10 clients).

### R4 — `!moveclient` (admin channel moves)

- `!moveclient <nickname|clid> <channel>` — move another user via TS6 HTTP Query
  (TS3 fallback); nickname prefix resolution, 5 moves/min rate limit.

### R1b async delegate + analyst rights gating
**Author: Grok (xAI), driven by Lane Ambrose.**

- **R1b:** `!analyst` / `delegate_to_agent` ack immediately and post results via
  `postFollowUp` (chat + voice); `formatDelegateFollowUp` in `bot/src/llm/delegate.ts`.
- **Rights:** `analyst`/`agent` removed from default public allow; `@analyst` command
  group granted to admin server-groups by default.

### Gemma 4 migration + R1 analyst delegation — `7f47978`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Remote chat default:** Unsloth Gemma 4 12B QAT (`UD-Q4_K_XL`) replaces Qwen
  as the primary LAN chat model; Gemma 4 preferred across defaults, presets, and
  embeddings (`27512ca`, `63269d6`).
- **Split-brain production:** LAN workstation (12B chat/tools), Pi ollama
  (Gemma E2B fallback + `embeddinggemma`), documented in `docs/remote-llm.md`
  (`f0c89ab`, `3680330`).
- **DESIGN §R1 shipped:** `!analyst` / `!agent` commands, `delegate_to_agent`
  tool, `DelegateClient` → `llmDelegateUrl` (production: Gemma 4 31B Q6 on a
  second LAN host); Settings delegate fields + presets (`138a47f`,
  `7f47978`).
- **Docs:** README commands/features/config, ROADMAP Phase 4 + R1b open items,
  DESIGN §R1 status, `docs/rag-ingestion.md` analyst path, `.env.example` pointer.

**Note:** R1b async delegate shipped in the same release batch (see above).

## 2026-06-19

### Voice STT sidecar, doctrine hardening, CI, and bot refactor — `c4c3850`
**Author: Cursor Composer (AI agent), driven by Lane Ambrose.** Committed under
Lane's identity without a `Co-Authored-By` trailer; recorded here for accurate
attribution.

- **Voice (Phase 2):** `sherpa-onnx` STT sidecar (`services/sherpa-stt`,
  Moonshine-tiny-en) + a dev `stt-mock`; voice probes, a synthetic
  `POST /api/bot/voice/test` (admin-only), a Settings voice panel, and
  `voice-smoke.sh`.
- **Doctrine wiki-as-code hardening:** nested doctrine paths (e.g.
  `intel/intsum.md`) with path-traversal containment in `DoctrineStore.safeName`,
  a recursive watcher, and `doctrine-sync-test.sh`.
- **CI / validation:** `ci-validate.sh`, an improved `phase0-validate.sh`.
- **BotInstance refactor:** split into `playback/commands/control/voice/`
  `knowledge/lifecycle/llm/rights/community` modules under `bot/src/bot/`.
- **Web/admin:** rights JSON editor, stream-bridge + RAG test panels, remote-LLM
  presets; `errorMessage` util; cookie-based session via `withCredentials`.
- Removed dead `ts-protocol/connection.ts` and `web/src/api/http.ts`.

### Follow-up audit + hardening of `c4c3850`
**Author: Claude (Anthropic), via Claude Code** (commit carries `Co-Authored-By`).
Audited the Composer commit (security, correctness, scope), then: STT `/asr`
body-size cap (413 over 25 MiB), `auth.ts` trailing newline, and this CHANGELOG.

## 2026-06-14

**Author: Claude (Anthropic), via Claude Code** (commits carry `Co-Authored-By`).

- **Tidal HiFi bridge** taken live: diagnosed the playback 401 (0.7.x's
  "Android Automotive" OAuth client → subStatus 4005), bumped `python-tidal` to
  0.8.x, fixed the login-link buffering. (`df9cd83`)
- **TeamSpeak file-browser ingestion:** drop `.md` → RAG doctrine, audio → the
  music library, from a `moneypenny-drop` channel; recursion, retry/timeout,
  `!ingeststatus`. (`c83af2d`, `520729f`)
- Regression tests locking in the `.env` inline-comment and `!play` YouTube-
  fallback fixes. (`029dd7b`)

## Earlier

- **Phases 5–8** (vector store, doctrine RAG, long-term memory, the roast),
  on-device LLM serving (Gemma 4 E2B on ollama), and the public GitHub release —
  Claude (Anthropic). A `grok-build-*` line of work was archived (see
  `archive/grok-build-corrupted-*` branches).
- Derived from [ZHANGTIANYAO1/teamspeak-music-bot](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot)
  (MIT).
