# Moneypenny — Agent Steering

This file guides AI coding assistants working in this repo. Follow it unless the user overrides it for a specific task.

**Default branch:** `dev` (push here; keep `main` aligned when releasing).

**Language policy:** English-only source (`bot/src`, `bot/web/src`). No Chinese platforms, APIs, or user-facing strings. Runtime data (song titles, etc.) may be any language.

---

## 0. System map — what this actually is

This is **not** “a frontend and a backend.” It is a **multi-part system** with explicit owners. Fix bugs at the **owner** layer, not in a shim one level down.

### A. Bot process (single Node.js app — `bot/`)

One long-lived process. Entry: `bot/src/index.ts`. Owns TeamSpeak connectivity, music playback, AI, and the HTTP API.

| Subsystem | Path | Owns |
|-----------|------|------|
| **TS6 client** | `bot/src/ts-protocol/` | Dual-protocol connection, chat in/out, voice PCM in, file transfer, channel queries |
| **Bot runtime** | `bot/src/bot/` | `BotManager` / `BotInstance`: connect/disconnect, command execution, playback engine, voice session, idle poller, phase-0 auto-play |
| **Control router** | `bot/src/control/` | Deterministic-first dispatch; `!ask` / fuzzy intent → LLM tools; voice routing; handler registration |
| **Music providers** | `bot/src/music/` | `LocalProvider`, `YouTubeProvider`, `StreamProvider` — search, resolve, URLs, path guards |
| **Audio stack** | `bot/src/audio/` | Queue, player, Opus encode/decode for TS voice out |
| **LLM client** | `bot/src/llm/` | OpenAI-compatible HTTP client, tool schema, conversation history |
| **RAG** | `bot/src/rag/` | Chunking, embeddings HTTP client, Qdrant client, `RetrievalStore` |
| **Rights** | `bot/src/rights/` | Declarative rank gating (chat + voice scopes) |
| **Voice pipeline** | `bot/src/voice/` | VAD, STT/TTS **HTTP clients**, `VoicePipeline` — not the sidecar processes |
| **Web API** | `bot/src/web/` | Express app, session auth, CSRF, rate limits, REST + WebSocket — **all HTTP input validation lives here or in called modules** |
| **Data** | `bot/src/data/` | SQLite (`better-sqlite3`), `config.json`, doctrine registry, users/sessions, avatars |
| **Ingest** | `bot/src/ingest/` | TeamSpeak `moneypenny-drop` channel file polling |
| **Doctrine sync** | `bot/src/rag/doctrine-ingest.ts` | Shared ingest/reindex/watch path for web upload, `!reindex`, git mirror, file-drop |

### B. Web UI (Vue 3 SPA — `bot/web/`)

Presentation only. Built to `bot/web/dist/`, served by the bot’s Express static middleware.

- **Owns:** layout, forms, client-side state (`stores/`), calling `/api/*`
- **Does not own:** business rules, auth enforcement, playback, RAG, or TS protocol (server enforces all of that)

### C. Docker sidecars (separate containers — `docker-compose.yml`, `services/`)

Optional profiles. The bot reaches them via URLs in config/env — **not** in-process.

| Service | Profile | Contract |
|---------|---------|----------|
| `bot` | `core` | The Node app (A + B built-in) |
| `ollama` / `rkllama` | `ollama` / `npu` | OpenAI-compatible `/v1` LLM |
| `sherpa-stt`, `kokoro` | `voice` | STT/TTS HTTP sidecars (`docs/voice.md`) |
| `stt-mock` | `voice-dev` | CI-only STT stub |
| `qdrant` | `rag` | Vector DB |
| `tidal-bridge` | `stream` | Tidal stream resolve |
| `teamspeak` | `server` | Optional TS6 server |

### D. Repo orchestration (repo root — not runtime)

| Path | Owns |
|------|------|
| `install.sh`, `docker-compose*.yml` | Deploy topology |
| `scripts/` | Phase 0, voice smoke, doctrine sync, CI validate |
| `host-setup/` | NPU driver prep (Orange Pi) |
| `docs/`, `DESIGN.md`, `ROADMAP.md` | Operator + architecture reference |

### E. Mutable state (`bot/data/` volume)

`config.json`, `moneypenny.db`, `doctrine/`, logs, avatars. Writable by uid 1000 in Docker.

### Topological seams (where clean cuts go)

- **Provider boundary:** `music/provider.ts` — platforms are `local | youtube | stream` only
- **Router boundary:** `control/router.ts` — all commands and LLM tools exit through here
- **HTTP boundary:** `web/api/*` + middleware — every external input enters here
- **RAG ingest boundary:** `rag/doctrine-ingest.ts` — one path for all doctrine sources
- **Sidecar boundary:** HTTP env URLs — bot never embeds STT/LLM/Qdrant logic in-process

---

## 1. No test-passing architecture

- **Only clean cuts** along the seams above.
- **Deleting the old structure is part of the same task** as creating the new one. Do not leave parallel code paths, feature flags for the old world, or “temporary” adapters that exist only to green tests.
- Forbidden patterns: wrapper that delegates to old + new; `if (legacy)` branches; duplicate handlers; stub modules that fake success without owning the real behavior.

---

## 2. Work may cascade

If the task ends with **red tests**, pull in **directly affected** code up the ownership tree until **all tests are green**. Do not stop at a partial fix that leaves the suite broken or the seam dishonest.

Cascade order (example): failing API test → fix route validation → fix bot method → fix provider → fix router → add/adjust tests at each layer touched.

---

## 3. Fix at the highest responsible owner

- Start **local** to the symptom (the failing test, file, or function).
- If the root cause is not there, **move up one ownership level** until you find the module that should enforce the invariant.
- **Do not** patch callers to compensate for a broken owner. **Do not** add middleware-level workarounds for provider bugs.

Examples:
- Bad playback URL → fix `music/*` provider, not `web/api/player.ts` string hacks
- Rights bypass → fix `rights/` + `control/router.ts`, not a one-off check in a handler
- Invalid doctrine path → fix `data/doctrine.ts` `safeName`, not the ingest caller

---

## 4. Known bad patterns (append when discovered)

When you hit a failure mode — especially one an LLM “fixed” wrong — add a **one-line entry** here so future sessions avoid it.

<!-- Format: `- [YYYY-MM-DD] <pattern> → <correct owner/fix>` -->

- [2026-06-20] Listing a channel's files via full-client `ftgetfilelist` + `execCommandWithResponse` silently returns empty — `@honeybbq/teamspeak-client` surfaces only 8 notification types and `notifychannelfilelist` isn't one. → On **TS6 6.0.0-beta11** WebQuery also returns `5120 out-of-scope` for `ftgetfilelist` (no file-transfer scope exists). **Co-located deploy:** bind-mount the TS `files/` tree (`TS6_FILES_DIR`, `ingest/file-drop-disk.ts`) and scan `virtualserver_<sid>/channel_<cid>/` on disk. **Remote / protocol-correct:** patch `@honeybbq/teamspeak-client` to surface `notifychannelfilelist` (see `docs/honeybbq-ts6-file-list-patch-plan.md`). Tests mocking `listChannelFiles` hid both boundaries.
- [2026-06-20] Web Player API calling `bot.executeCommand()` bypasses `ControlRouter` rank gating that TS chat and voice use. → Route HTTP commands through `BotInstance.executeRoutedCommand()` + `ControlRouter.executeParsedCommand()`; direct song/queue endpoints call `canWebUserRunCommand()`.
- [2026-06-20] `\uXXXX` CJK in source passes `no-non-english.test.ts` but renders Chinese at runtime (e.g. profile away/now-playing). → English literals in `bot/profile.ts`; guard must decode escapes before matching.
- [2026-06-20] `web/api/music.ts` `getProvider()` ignored `stream` — `platform=stream` silently hit YouTube. → Pass `streamProvider` into `createMusicRouter` and route all three platforms at the HTTP boundary.
- [2026-06-20] `.env` `MUSIC_DIR=./music` passed into the bot container resolves to `/app/music` on the read-only rootfs — file-drop audio + web uploads fail with `ENOENT mkdir '/app/music'`. → `docker-compose.yml` pins container `MUSIC_DIR=/music`; host bind uses `MUSIC_HOST_DIR` or `.env` `MUSIC_DIR` for the volume source only.
- [2026-06-20] Voice commands ("moneypenny pause/resume") fail **only while music is playing** — NOT STT/KWS/CPU/acoustic-echo. Was **`captureDuck` hard-pause** entangling pause/resume/`savedMusic`; fixed with **volume duck** (`AudioPlayer.duckVolume` / `restoreDuckVolume`, `duckMusicVolume` in voice config). Still gate STT until `DUCK_SETTLE_MS` + `clearCommandBuffer`; keep `voiceReplyClearsSavedMusic()` for TTS handoff (resume/skip yes, pause/stop no). Do not revert to `player.pause()` on wake.
- [2026-06-20] TS6 rank gating sees empty `serverGroups` on full-client `clientlist` → everyone denied admin/`!follow`/`!vol`. → Enrich via HTTP Query (`clientlist?-groups`, `clientinfo` by `invokerClid`); see `docs/rank-gating.md`.
- [2026-06-20] `!follow` returns "Failed to move" when bot is already in the invoker's channel — TS `clientMove` error 770. → Skip move when `channelID` matches; treat 770 as success (`joinChannelById`).
- [2026-06-20] Pi `git fetch origin dev` updates `FETCH_HEAD` but leaves `origin/dev` stale → `git reset --hard origin/dev` deploys old code. → `git fetch origin dev:refs/remotes/origin/dev` before reset.

---

## Before completing any task

Run these checks **yourself** (do not tell the user to run them):

1. **Secrets** — scan the diff and touched files for hardcoded API keys, passwords, tokens, private keys
2. **Injection** — SQL (parameterized queries only in `data/`), shell (no unsanitized `exec`/`spawn` with user input), path traversal (`LocalProvider` / `DoctrineStore` prefix guards)
3. **Input validation** — every new/changed HTTP body, query param, and upload validated at the API layer; TS chat commands parsed via `bot/commands` + router
4. **Typecheck** — `cd bot && npx tsc --noEmit`
5. **Tests** — `cd bot && npm run test:all` (backend + web unit tests)
6. **Web build** (if `bot/web/` changed) — `cd bot/web && npm run build`

Task is **not done** until these pass (or you explicitly report a blocked external dependency).

---

## Security audit prompts (use proactively on risky changes)

When touching auth, uploads, file paths, SQL, exec, or external HTTP:

- *"Write 20 unit tests designed to break this function"*
- *"Find every security vulnerability in this file. Think like a pentester."*
- *"Generate 50 edge cases: null, empty strings, negative numbers, unicode, arrays with 100k items"*
- *"Audit this entire codebase for leaked secrets"* (scope: repo or changed paths)

---

## Test commands

```bash
cd bot && npx tsc --noEmit && npm run test:all
cd bot/web && npm run build
./scripts/ci-validate.sh              # doctrine + voice mock + phase0 preflight
./scripts/phase0-validate.sh --check-only
```

---

## Project conventions

- **Music platforms:** `local`, `youtube`, `stream` only — no CN providers
- **LLM/RAG/voice/roast:** gated in `config.json`; hot-reload via Settings API where implemented
- **RAG substrate** (Qdrant, embedding URL): may require bot restart + `--profile rag`
- **Commits:** complete sentences; focused diffs; every changed line traces to the request
- **Docs:** do not add markdown files the user did not ask for; update existing docs when behavior changes

---

## Behavioral guidelines

*Bias toward caution over speed. Use judgment on trivial tasks.*

### Think before coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — do not pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what is confusing. Ask.

### Simplicity first

- Minimum code that solves the problem. Nothing speculative.
- No features, abstractions, or configurability beyond what was asked.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

### Surgical changes

- Do not “improve” adjacent code, comments, or formatting.
- Do not refactor unrelated broken code unless asked.
- Match existing style.
- Remove orphans **your** changes created; mention pre-existing dead code, do not delete it unless asked.
- Every changed line should trace to the user’s request.

### Goal-driven execution

- Transform tasks into verifiable goals with explicit checks.
- Multi-step work: brief plan with `step → verify:` per step.
- Prefer: reproduce with test → fix → green suite.

**Working if:** smaller diffs, fewer rewrites, questions before mistakes not after.

---

## Phase priority (hardware-gated)

1. Phase 0 — TS6 connect + playback (`scripts/phase0-validate.sh`)
2. Voice smoke — sidecars + Settings synthetic test (`docs/voice.md`)
3. RAG on hardware — `--profile rag`, doctrine ingest (`docs/rag-ingestion.md`)

Do not treat scaffolds as validated until operator confirms on real hardware.