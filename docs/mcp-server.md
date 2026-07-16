# Moneypenny MCP Server — Design

> Expose Moneypenny as an **MCP server** so [Grok Build](https://grok.x.ai) (and
> any other MCP client) can drive the station without replacing the bot runtime.
> The TypeScript bot remains the TeamSpeak + music + rights **authority**.
> Grok Build is an optional **agent harness** that calls structured tools.

**Status:** Phase 1 **implemented** (2026-07-15) — `bot/src/mcp/`, env `MCP_*`,
example Grok config `.grok/config.toml.example`  
**Related:** [brain-boundary.md](./brain-boundary.md), [feature-roadmap.md](./feature-roadmap.md),
[DESIGN.md](../DESIGN.md) §MCP (endgame), [remote-llm.md](./remote-llm.md),
`bot/src/bot/commands.ts` (`COMMAND_MANIFEST`), `bot/src/web/api/{player,bot,rag}.ts`

---

## 1. Goals

1. **Grok Build manipulates Moneypenny** via MCP tools that map 1:1 to station
   capabilities (`!play`, `!ask`, ban, queue, doctrine, radio, …).
2. **Zero rewrite of the spine** — TS bot, ControlRouter, PlaybackEngine,
   TurboVec RAG, radio director, rights stay where they are.
3. **One execution path** — MCP tools dispose through the same handlers as
   dashboard `/api/player/*` and chat `!` commands (no second queue).
4. **Local-model friendly** — Grok Build can use LAN/Ollama/rkllama models while
   tools still hit the always-on bot.
5. **Safe by default** — auth, rights re-check, rate limits, audit log; no shell
   escape hatch; no raw TurboVec / DB access.

## 2. Non-goals

| Non-goal | Why |
|----------|-----|
| Replace bot with Grok Build | Bot owns TS6, Opus, queue, radio fail-open |
| Simulate typing `!play …` in TS chat | Fragile; tools use structured args |
| Full command-string parity day one | Ship phased tool sets |
| Extract Python “brain” (`POST /v1/turn`) | MCP is a *client*; brain extract stays deferred ([brain-boundary](./brain-boundary.md)) |
| Distributed multi-tenant SaaS MCP | Single-operator / org LAN product |
| Let Grok bypass rank gates | Bot re-checks every mutation |

---

## 3. Architecture

### 3.1 System diagram

```
┌──────────────────────────────────────────────────────────────┐
│  Operator laptop / workstation                               │
│  ┌────────────────────┐    optional local models             │
│  │  Grok Build TUI    │──── Ollama / vLLM / OpenAI-compat ──►│
│  │  skills + agent    │                                      │
│  └─────────┬──────────┘                                      │
│            │ MCP streamable HTTP (or SSE)                    │
│            │ Authorization: Bearer <token>                   │
└────────────┼─────────────────────────────────────────────────┘
             │  LAN / Tailscale / SSH tunnel
             ▼
┌──────────────────────────────────────────────────────────────┐
│  OPi5 / bot host  (docker compose)                           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  bot (Express + ControlRouter)                         │  │
│  │                                                        │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │  │
│  │  │ MCP mount   │  │ REST /api/*  │  │ TS chat !cmd  │  │  │
│  │  │ /mcp        │  │ (Vue dash)   │  │               │  │  │
│  │  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │  │
│  │         │                │                  │          │  │
│  │         └────────────────┼──────────────────┘          │  │
│  │                          ▼                             │  │
│  │              McpToolDispatcher / runRoutedCommand      │  │
│  │                          │                             │  │
│  │         ┌────────────────┼────────────────┐            │  │
│  │         ▼                ▼                ▼            │  │
│  │   PlaybackEngine   Knowledge/RAG     Rights + Audit    │  │
│  │   Radio · Memory   TurboVec bridge   canRun / subject  │  │
│  └────────────────────────────────────────────────────────┘  │
│         │ sidecars: ollama · turbovec · mempalace · piper …  │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Ownership (locked)

| Responsibility | Owner |
|----------------|--------|
| TS6, audio, queue, radio, fail-open music | **Bot always** |
| Rights / classification gates on execute | **Bot always** |
| Tool *execution* | **Bot always** |
| Multi-step agent planning, skills, session memory | **Grok Build** (client) |
| Embeddings + vector ANN | Bot → ollama + **TurboVec** |
| Chat for `!ask` / harness | Bot’s configured LLM (local or LAN) — *independent* of Grok’s model |

Grok’s model and the bot’s `!ask` model are **orthogonal**. Grok can be local
12B while `rag_ask` still uses the bot’s `llmUrl`. Or Grok can call `rag_ask` and
never use the bot LLM for free-form chat.

### 3.3 Relation to brain-boundary

| Doc | Role |
|-----|------|
| This MCP design | **Inbound**: external agents *call into* the bot |
| [brain-boundary](./brain-boundary.md) | **Outbound**: bot *calls* a future brain for turn orchestration |

They compose later:

```
Grok ──MCP──► bot ──optional──► brain ──toolProposals──► bot executes
```

MCP does **not** require a brain extract. Shipping MCP *satisfies* one
brain-boundary extract criterion (“multiple clients need the same agent loop”)
without forcing the extract — Grok *is* the agent loop; the bot stays executor.

### 3.4 Relation to DESIGN.md endgame MCP

DESIGN.md sketches the bot as an **MCP client** (HA, media servers, scripts).
This design is the **complement**: bot as **MCP server**. Same protocol, opposite
direction. Do not conflate:

| Direction | Product |
|-----------|---------|
| Bot → external MCP servers | Home Assistant, scripts allowlist |
| External clients → bot MCP | Grok Build, Claude Code, custom agents |

---

## 4. Placement: in-process MCP mount (recommended)

### 4.1 Decision

**Implement MCP inside the bot process** (Express route or dedicated small
handler on the same port / sidecar path), **not** a separate Python bridge that
re-implements domain logic.

| Option | Pros | Cons |
|--------|------|------|
| **A. In-process `/mcp` on bot** | Shared BotInstance, rights, audit; one deploy | Couples protocol to Node |
| B. Sidecar `services/mcp-bridge` → HTTP REST | Language freedom | Double hop; drift; more ops |
| C. stdio-only adapter on laptop wrapping REST | Easy local Grok | No remote; still need stable REST |

**Choose A.** Sidecar only if the MCP SDK forces a painful Node dependency; even
then the sidecar must only translate protocol → existing `/api/*` or internal
dispatcher, never re-own queue state.

### 4.2 Transport

| Transport | Use |
|-----------|-----|
| **Streamable HTTP** (preferred) | Grok Build `url = "http://host:3000/mcp"` (or dedicated port) |
| SSE | Fallback if streamable HTTP quirks |
| stdio | Optional thin `mcp-stdio-proxy` for air-gapped laptop→SSH; not primary |

Grok Build config (operator):

```toml
# ~/.grok/config.toml  or  moneypenny/.grok/config.toml (project scope)

[mcp_servers.moneypenny]
url = "http://opi5.local:3000/mcp"
headers = { Authorization = "Bearer ${MONEYPENNY_MCP_TOKEN}" }
enabled = true
tool_timeout_sec = 120

# Optional: local-only coding model (independent of bot !ask)
[model.local-lan]
model = "gemma4:12b"
base_url = "http://gpu-box:11434/v1"
api_backend = "chat_completions"
name = "LAN Gemma"

[models]
default = "local-lan"   # or keep grok-build for stronger tool use
```

Bind MCP to **localhost / docker network + Tailscale**, not public internet.
If exposed, require TLS termination (Caddy/nginx) + token rotation.

### 4.3 Port / path

| Env | Default | Notes |
|-----|---------|--------|
| `MCP_ENABLED` | `false` | Opt-in |
| `MCP_PATH` | `/mcp` | Mounted on existing web server |
| `MCP_TOKEN` | (required when enabled) | Bearer; from secrets / `.env` |
| `MCP_BOT_ID` | first bot | Multi-bot: tools accept optional `bot_id` |

Dashboard stays on `:3000`. Same process, same auth stack extended (see §5).

---

## 5. Auth, subject, rights

### 5.1 Authentication (who may call MCP)

1. **Service token** (Phase 1): `Authorization: Bearer <MCP_TOKEN>`
   - Single high-privilege operator token (maps to synthetic admin subject)
   - Logged as invoker `mcp:service` or configurable `MCP_INVOKER_UID`
2. **Dashboard session bridge** (Phase 2 optional): same cookie/session as Vue
   admin — useful for browser-hosted agents, not primary for Grok Build
3. **Per-operator tokens** (Phase 3): tokens bound to rights profiles
   (`mcp.dj`, `mcp.readonly`, `mcp.admin`)

### 5.2 Authorization (what each call may do)

Every mutating tool goes through the **same rights path** as web:

- Today: `bot.canWebUserRunCommand(user, commandName)` / `ctx.canRun(token)`
- MCP subject construction:

```ts
type McpSubject = {
  kind: "mcp";
  tokenId: string;          // which bearer
  invokerUid: string;       // synthetic or mapped TS uid
  invokerName: string;      // "grok-build" | operator name
  // Effective rights: either full admin (service token) or token profile
  rightsProfile: "readonly" | "dj" | "admin";
};
```

| Profile | Can run (examples) |
|---------|-------------------|
| `readonly` | `now_playing`, `queue_list`, `rag_search`, `status_*` |
| `dj` | + play/add/skip/pause/ban/volume, `rag_ask` |
| `admin` | + stop/clear/reindex/settings/radio.power/moderation |

**Never** trust Grok-supplied “I am admin” flags. Client may *request* a dry-run;
server decides.

### 5.3 Classification (RAG)

`rag_ask` / `rag_search` accept optional `allowedClassifications`. For service
token default:

- **admin profile:** all classifications the bot is configured to serve  
- **dj / readonly:** `unclassified` only unless token is bound to TS groups that
  unlock `doctrine:*` rights (Phase 3)

Re-check on every query inside RetrievalStore (existing path).

### 5.4 Audit

Write audit rows for every MCP tool call:

```
actor=mcp:<tokenId>  action=mcp.<tool>  detail={ args summary, botId, ok, ms }
```

Reuse `createAuditRouter` / existing audit store. Redact long text bodies
(keep hash + length for `rag_ask` questions).

### 5.5 Rate limits

Reuse player rate limit class (token bucket). Stricter defaults for MCP than UI:

| Class | Capacity | Refill |
|-------|----------|--------|
| Read tools | 120 / burst | 20/s |
| Music mutate | 30 | 5/s |
| RAG / LLM tools | 10 | 1/s |
| Admin / reindex | 5 | 0.2/s |

---

## 6. Tool design principles

1. **Structured tools, not chat strings** — `music_play({ query, platform? })`
   not `run_command({ text: "!play foo" })`.
2. **Stable names** — `snake_case`, versioned only on break (`music_play` forever).
3. **Idempotency where free** — `client_request_id` optional on mutations; store
   short TTL dedupe for skip/play storms from agent loops.
4. **Dry-run** — `dry_run: true` returns what would happen without side effects
   (reuse harness `dryRun` where applicable).
5. **Errors as data** — tool result JSON always includes `ok`, `code`, `message`;
   HTTP MCP layer still 200 for application errors so the model can recover.
6. **No generic shell** — never `exec`, `eval`, or raw SQL.
7. **Manifest alignment** — every music/admin tool maps to a `COMMAND_MANIFEST`
   name or an existing `/api/*` route. Adding a TS command should offer a
   checklist item “MCP tool?” not a separate invent-the-API path.

### 6.1 Anti-pattern: `run_command`

A single `run_command({ raw: "!play …" })` tool is **explicitly rejected** as the
primary API (allowed only as a **debug-only**, admin-gated escape hatch behind
`MCP_ALLOW_RAW_COMMAND=1`). Reasons:

- Rights map to command *names*; free-form strings invite injection  
- Agents overuse it and skip structured schemas  
- Harder to document / test / rate-limit per capability  

---

## 7. Tool catalog

Grok namespaced tools appear as `moneypenny__<tool>`.

### 7.1 Phase 1 — Station core (ship first)

Read + safe music + grounded ask. Enough for “Grok as second cockpit.”

| Tool | Maps to | Rights | Input (summary) | Output (summary) |
|------|---------|--------|-----------------|------------------|
| `status_health` | `GET /api/health` + bot connected | any | — | `{ ok, tsConnected, version }` |
| `status_now_playing` | queue current + `!now` | any | `bot_id?` | track metadata, elapsed, source |
| `status_queue` | `GET …/queue` | any | `bot_id?`, `limit?` | ordered queue items |
| `status_radio` | `GET /api/bot/radio/status` | any | — | director on/off, mode |
| `status_rag` | `GET /api/bot/rag/status` | any | — | turbovec health, collection |
| `music_play` | `POST /api/player/:id/play` | `play` | `query`, `platform?` (`local`\|`youtube`\|`stream`) | message + started |
| `music_add` | `POST …/add` | `add` | same | message |
| `music_play_next` | `!playnext` path | `playnext` | `query`, `platform?` | message |
| `music_skip` | `!next` / `!skip` | `skip`/`next` | — | message |
| `music_pause` / `music_resume` | pause/resume | same | — | message |
| `music_ban` | `!ban` | `ban` | `query?` (empty = current) | message |
| `music_unban` | `!unban` | `unban` | `query` | message |
| `rag_ask` | harness ask mode=`ask` | admin/dj | `question`, `include_sources?` | `{ reply, sources[] }` |
| `rag_search` | `POST /api/rag/query` or bot rag query | admin/dj | `q`, `top_k?`, `allowed_classifications?` | chunks only (no LLM) |

### 7.2 Phase 2 — Operator parity

| Tool | Maps to | Rights |
|------|---------|--------|
| `music_stop` / `music_clear` | stop/clear | admin |
| `music_volume` | `!vol` | `vol` |
| `music_mode` | seq/loop/random/rloop | `mode` |
| `music_history` | history API | any / dj |
| `music_play_song` / `music_add_song` | library id paths | dj |
| `radio_set` | radio on/off / subcommands | `radio` / `radio.power` |
| `memory_remember` / `memory_recall` / `memory_forget` | special handlers | subject-scoped |
| `kg_query` / `diary_query` | `!kg` / `!diary` | tokens |
| `doctrine_list` | `GET /api/rag/doctrine` | admin |
| `doctrine_reindex` | `!reindex` / rag reindex | `reindex` |
| `doctrine_ingest_status` | `!ingeststatus` | admin |
| `harness_turn` | `POST /api/bot/harness/ask` | admin | `question`, `mode` ask\|intent, `dry_run?`, `allow_dangerous?` |
| `harness_turns` | list ring buffer | admin |
| `ops_status` | ops brief | ops |

`harness_turn` with `mode=intent` is how Grok can **delegate fuzzy music NL to
the bot’s own tool loop** instead of re-implementing intent. Prefer:

- **Structured music** when Grok already knows the song → `music_play`
- **harness_turn intent** when the user said “something chill for hangar” and
  you want *bot* LLM tools (local) rather than Grok guessing query strings

Avoid **double agent loops** (Grok tools + bot intent both firing tools). Client
skill policy: pick one level.

### 7.3 Phase 3 — Economy, moderation, generate

| Tool | Notes |
|------|--------|
| `econ_*` | Wrap economy commands; read-heavy first |
| `workorder_*` | clear-all stays admin-only |
| `mod_mute` / `mod_kick` | high risk; default **off** unless `MCP_ENABLE_MODERATION=1` |
| `generate_music` | ACE-Step; expensive; dj+ |
| `settings_get` / limited `settings_patch` | never expose secrets in get |

### 7.4 Explicitly out of MCP (forever or long-term)

- Raw vector upsert/delete against TurboVec  
- Arbitrary file write outside doctrine upload API  
- TS protocol primitives (move all clients as bulk without rights)  
- Session login / user password management (use dashboard)  
- `trigger_script` / shell (DESIGN endgame: separate allowlisted MCP client direction)

---

## 8. Internal dispatcher

### 8.1 Target module layout

```
bot/src/mcp/
  server.ts          # protocol wire-up (SDK), auth middleware
  auth.ts            # bearer → McpSubject
  dispatcher.ts      # tool name → handler
  tools/
    status.ts
    music.ts
    rag.ts
    harness.ts
    doctrine.ts
    …
  types.ts
  mcp.test.ts
```

### 8.2 Disposal path (critical)

Prefer calling the **same functions the web API uses**, not re-parsing chat for
everything:

```
MCP tool
  → assertSubject(tool.requiredRight)
  → Music tools: build ParsedCommand OR call PlaybackEngine / runRoutedCommand
       (player.ts already: parseCommand + runRoutedCommand + canWebUserRunCommand)
  → RAG: retrieval.query / bot.runHarnessTurn
  → audit.log
  → return ToolResult JSON
```

Ideal refactor (small, optional Phase 1 prep): extract from `player.ts`:

```ts
// bot/src/control/web-dispatch.ts (name flexible)
export async function dispatchParsedCommand(
  bot: BotInstance,
  subject: WebOrMcpSubject,
  cmd: ParsedCommand,
): Promise<{ ok: boolean; message: string; code?: string }>
```

MCP and Express both call this. **Do not** leave MCP as the only caller of a
forked code path.

### 8.3 Multi-bot

Tools accept optional `bot_id`. Default: `MCP_BOT_ID` or `botManager.getAllBots()[0]`.
Error `NO_BOT` / `BOT_NOT_FOUND` with stable codes.

---

## 9. Tool schemas (Phase 1 sketches)

### `music_play`

```json
{
  "name": "music_play",
  "description": "Play a track or URL on the TeamSpeak music bot (local library first, then YouTube/stream per platform).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query or URL (YouTube, Tidal, Spotify, Bandcamp, …)" },
      "platform": { "type": "string", "enum": ["local", "youtube", "stream"], "description": "Force provider; omit for default resolve order" },
      "bot_id": { "type": "string" },
      "dry_run": { "type": "boolean" },
      "client_request_id": { "type": "string" }
    },
    "required": ["query"]
  }
}
```

### `rag_ask`

```json
{
  "name": "rag_ask",
  "description": "Ask a question grounded in org doctrine (RAG). Returns answer text and source citations. Does not control music.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "question": { "type": "string" },
      "include_sources": { "type": "boolean", "default": true },
      "allowed_classifications": {
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["question"]
  }
}
```

### Standard result envelope

```json
{
  "ok": true,
  "code": "OK",
  "message": "human-readable summary (also what TS users would see)",
  "data": { },
  "meta": {
    "bot_id": "…",
    "duration_ms": 42,
    "request_id": "…"
  }
}
```

Failure:

```json
{
  "ok": false,
  "code": "PERMISSION_DENIED" | "VALIDATION_ERROR" | "NO_BOT" | "AUDIO_REQUIRED" | "RAG_ERROR" | "LLM_DISABLED" | "RATE_LIMITED" | "INTERNAL",
  "message": "…",
  "data": null
}
```

---

## 10. Grok Build integration playbook

### 10.1 Operator setup

1. Enable MCP on bot: `MCP_ENABLED=1`, set `MCP_TOKEN`, restart bot.  
2. Ensure LAN reachability (Tailscale IP recommended).  
3. `grok mcp add --transport http moneypenny http://opi5:3000/mcp --header "Authorization: Bearer …"`  
   or project `.grok/config.toml`.  
4. `grok mcp doctor moneypenny`  
5. In TUI: `/mcps` → confirm tools listed.  
6. Smoke: ask Grok “what’s playing on Moneypenny?” → should call `status_now_playing`.

### 10.2 Skills (optional, Phase 2)

Repo skill `~/.grok/skills/moneypenny/SKILL.md` or project skill:

```markdown
# Moneypenny station control
When the user asks about music, doctrine, or the TS bot:
1. Prefer moneypenny__status_* before mutating.
2. Use moneypenny__music_play for explicit song/URL requests.
3. Use moneypenny__rag_ask for org/doctrine questions (not general web search).
4. Never invent ban/unban without user confirmation.
5. Do not call music_stop/clear unless user clearly asks.
```

### 10.3 Local-model-only mode

| Concern | Approach |
|---------|----------|
| Grok agent model | Custom `[model.*]` → LAN OpenAI-compatible endpoint |
| Tool calling quality | Prefer models with reliable tool/JSON use; fall back to cloud Grok for hard multi-step |
| Bot `!ask` / embeddings | Unchanged (Pi embeddinggemma + TurboVec + configured chat LLM) |
| Offline | MCP + local model + bot on LAN works without xAI if custom model is default |

**Honest limit:** small local models are worse at long multi-tool plans. Phase 1
tools are simple enough that structured “play X / ask Y” works; complex org ops
may need a stronger model or `harness_turn` intent.

### 10.4 What we do **not** do

- Run Grok Build **as a docker service replacing** the bot  
- Pipe all TS chat through Grok by default (possible later as optional gateway;
  huge product/rights change — out of scope)  
- Store operator secrets in committed `.grok/config.toml` (use `${ENV}`)

---

## 11. Security model

| Threat | Mitigation |
|--------|------------|
| Token leak → full station control | Short-lived tokens (Phase 3); Tailscale ACL; audit; rotate |
| Prompt injection via doctrine → Grok calls ban | Confirm high-impact tools in skill; optional `MCP_REQUIRE_CONFIRM` list (ban/stop/clear/kick) returning `needs_confirmation` |
| SSRF via play URL | Existing provider allowlists / bridges |
| RAG classified leak | Classification filters + rights profile |
| DoS agent loops | Rate limits + idempotency keys |
| Confused deputy (Grok as user A acting as admin) | Subject fixed to token profile; no client-supplied admin override |
| Public bind | Default `127.0.0.1` or docker LAN; document exposure risk |

High-impact tools default policy:

| Tool | Default |
|------|---------|
| `music_ban`, `music_stop`, `music_clear` | allowed for `dj`/`admin` token; skill says confirm |
| `mod_kick`, `mod_mute` | **disabled** until flag |
| `doctrine_reindex` | admin only |
| raw command escape | off |

---

## 12. Observability

- Structured log line per tool: `component=mcp tool=… ok=… ms=… subject=…`  
- Metrics (optional later): counters by tool/code  
- `status_health` includes `mcp: { enabled, toolCount }` for doctor  
- Harness turns remain separate; MCP calls that invoke `harness_turn` appear in
  both audit and harness ring buffer

---

## 13. Testing strategy

| Layer | What |
|-------|------|
| Unit | auth token → profile; schema validation; envelope codes |
| Dispatcher | mock BotInstance; each Phase 1 tool happy path + PERMISSION_DENIED |
| Integration | supertest against `/mcp` with token (if HTTP JSON-RPC style) or SDK test harness |
| Contract | golden list: every Phase 1 tool name ↔ COMMAND_MANIFEST or documented API |
| Manual | Grok Build doctor + 5 smokes on Pi |

Regression lock: player API tests stay green; MCP tests must not require live TS
(mock audio guard).

---

## 14. Implementation plan (PR-sized)

### PR1 — Foundation (no Grok required)

1. `MCP_ENABLED` + bearer auth middleware  
2. Package MCP SDK (evaluate `@modelcontextprotocol/sdk` Node)  
3. Mount `/mcp` (or dual path) behind flag  
4. Tools: `status_health`, `status_now_playing`, `status_queue`  
5. Audit + rate limit stubs  
6. Unit tests  

**Accept:** `curl`/SDK list tools + now_playing against running bot with token.

### PR2 — Music mutate

1. Extract shared `dispatchParsedCommand` if needed  
2. Tools: play, add, skip, pause, resume, ban, unban  
3. Rights via subject profile  
4. Integration tests with mock playback  

**Accept:** MCP play resolves same path as dashboard play.

### PR3 — RAG + harness

1. `rag_search`, `rag_ask`, `status_rag`  
2. Optional `harness_turn`  
3. Classification policy for service token  

**Accept:** doctrine question returns sources; music fail-open if LLM down.

### PR4 — Grok packaging

1. Example `.grok/config.toml.example` in repo  
2. Skill markdown  
3. `docs/mcp-server.md` ops section + `RELEASES.md` smoke  
4. Pi deploy notes (Tailscale, token in `.env`)  

### PR5 — Phase 2 tools

Radio, doctrine reindex, memory, volume/mode, history — as demand dictates.

### Effort ballpark

| Milestone | Calendar (solo, part-time) |
|-----------|----------------------------|
| PR1 | 1–2 days |
| PR2 | 2–3 days |
| PR3 | 1–2 days |
| PR4 | 0.5–1 day |
| PR5 | 3–5 days |

---

## 15. Config reference

```bash
# .env / compose
MCP_ENABLED=1
MCP_TOKEN=                          # required if enabled; long random
MCP_PATH=/mcp
MCP_BOT_ID=                         # optional
MCP_DEFAULT_PROFILE=admin           # readonly | dj | admin for service token
MCP_ALLOW_RAW_COMMAND=0
MCP_ENABLE_MODERATION=0
MCP_INVOKER_NAME=grok-build
MCP_INVOKER_UID=mcp:service
```

Compose: no new service if in-process. If later sidecar:

```yaml
# not default
mcp-bridge:
  profiles: ["mcp"]
  …
```

---

## 16. Migration / rollout

1. Deploy PR1–3 behind `MCP_ENABLED=0` on Pi.  
2. Enable on LAN only; set token; verify doctor.  
3. Point Grok Build (laptop) at Tailscale URL.  
4. Keep Vue dashboard and `!` commands unchanged forever.  
5. No TurboVec/Qdrant migration interaction — RAG tools use existing store.

---

## 17. Open questions (resolve during PR1)

| # | Question | Default if undecided |
|---|----------|----------------------|
| Q1 | MCP SDK in-process vs thin sidecar? | **In-process** |
| Q2 | Same port as dashboard vs `:3100`? | **Same port**, path `/mcp` |
| Q3 | Service token = full admin always? | **Yes** for Phase 1; profiles in Phase 3 |
| Q4 | Should `rag_ask` use bot LLM or return chunks only? | Both tools: `rag_search` chunks, `rag_ask` full answer |
| Q5 | Confirm step for ban/stop in protocol? | Skill-level confirm first; protocol `needs_confirmation` if abused |
| Q6 | Multi-bot UX in tools? | Optional `bot_id`; default first bot |

---

## 18. Success criteria

**Phase 1 done when:**

1. Grok Build lists `moneypenny__*` tools over LAN with token.  
2. “What’s playing?” → correct now-playing payload.  
3. “Play \<song\>” → same behavior as dashboard Play.  
4. “What does doctrine say about X?” → cited `rag_ask` answer.  
5. Invalid token → no tools / 401.  
6. Music continues if Grok or LLM is down (fail-open unchanged).  

**North star:** Grok Build is the preferred **operator harness** for local
models + multi-step ops; Moneypenny remains the **station runtime**. Commands
are not rewritten into Grok — they are **projected** as MCP tools over the
existing architecture.

---

## 19. Appendix — Command → tool map (Phase 1–2)

| COMMAND_MANIFEST | MCP tool(s) | Phase |
|------------------|-------------|-------|
| play | `music_play` | 1 |
| add | `music_add` | 1 |
| playnext, pn | `music_play_next` | 1 |
| skip, next | `music_skip` | 1 |
| prev | `music_prev` | 2 |
| pause, resume | `music_pause`, `music_resume` | 1 |
| stop, clear | `music_stop`, `music_clear` | 2 |
| vol | `music_volume` | 2 |
| ban, unban | `music_ban`, `music_unban` | 1 |
| now, queue, list | `status_now_playing`, `status_queue` | 1 |
| mode | `music_mode` | 2 |
| radio | `status_radio`, `radio_set` | 1/2 |
| ask | `rag_ask` / `harness_turn` | 1/2 |
| analyst, agent | `harness_turn` mode or future `rag_delegate` | 2+ |
| remember, recall, forget | `memory_*` | 2 |
| reindex, ingeststatus | `doctrine_*` | 2 |
| generate | `generate_music` | 3 |
| mute, kick | `mod_*` | 3 (flagged) |
| mine…trade, workorder | `econ_*` | 3 |

---

## 20. Appendix — Decision record

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Product direction | MCP server on bot | Reuse spine; Grok as client |
| vs rewrite commands into Grok | Rejected | Dual orchestration, rights hell |
| vs brain extract first | MCP first | Cheaper multi-client story |
| Protocol surface | Structured tools | Safer than raw `!` strings |
| Vectors | TurboVec (existing) | Unrelated to MCP; stay behind RAG tools |
| Default MCP profile | admin service token | Solo operator; tighten later |
