# Rust rewrite (WIP)

Replace the **Node bot process** (`bot/src/index.ts`) with a Cargo workspace at
`crates/`. Vue, Whisper, Piper, Ollama/rkllama, TurboVec, MemPalace, ACE-Step,
Spotify/Tidal bridges, `install.sh`, and compose overlays **stay**.

Source of truth for this branch: `lmambr2/moneypenny` @ `ec464a2` (DESIGN v3,
AGENTS.md seams, 1227 backend tests).

**Branch status (2026-09):** Phases **0–8 live** on `feat/rust-bot-rewrite`.
Node remains production (`BOT_RUNTIME=node`) until Phase 9 cutover.

## Why

Worth it: Opus 20 ms clock without GC pauses, SQLite on the RK3588 hot path,
one static binary in the bot image, drop `better-sqlite3` native compile.

Not worth it: Vue SPA, Whisper/Piper/Ollama, TurboVec/MemPalace, rank-gating
*logic* (already clean TS — port, don't redesign), installer/compose.

Product rule still holds: **never put the model (or a rewrite) between a user and skip.**

## Strategy: strangler

Node stays production until the Rust binary can speak the same `/api/*` +
`POST /v1/turn` + WebSocket events, use the same `moneypenny.db` + `config.json`,
honor `COMMAND_MANIFEST`, and pass the same rights checks (chat, voice, web).

Compose overlay: `docker-compose.rust.yml`. Dual-run shares volumes. Only one
process binds `:3000`. Cut over one host. Delete Node last.

```
BOT_RUNTIME=node|rust
Node :3000 (production)
Rust :3001 (this overlay) until flip
```

## Crate map

| Crate | Owns | Status |
|-------|------|--------|
| `moneypenny` | bin: boot, watchdog, SIGINT/SIGTERM, TS chat loop | **live** |
| `mp-config` | `.env` + `config.json` defaults | **live** (load-only; no `config.json` write) |
| `mp-db` | rusqlite, identical `CREATE TABLE IF NOT EXISTS` | **live** |
| `mp-audio` | audio-native minus napi (`NativeOpus`, `pcmRms`, `isSpeechFrame`) | **live** (libopus) |
| `mp-ts` | TS3/TS6 façade | **live** (`tsclient-rs` + reconnect driver; HTTP Query groups) |
| `mp-http` | axum: same cookies, OpenAPI catalog, Vue SPA, `/api/*` | **live** (session + Vue parity + player/music + `POST /v1/turn`) |
| `mp-rights` | RightsEngine | **live** (PUBLIC/ADMIN + rank JSON) |
| `mp-control` | parse + executeDeterministic + LLM `tool-map` + dispose | **live** (`!play`/`!skip`/`!queue` + brain dispose after rights) |
| `mp-music` | Local / YouTube / Stream | **live** LocalProvider + ffmpeg→Opus 20 ms; YouTube via yt-dlp (CDN at play time); direct HTTP streams (SSRF-guarded) |
| `mp-brain` | `/v1/turn` transport | **live** in-process OpenAI-compat or `BRAIN_URL` HTTP; dispose after rights |
| `mp-rag` | embeddings + TurboVec + doctrine | **live** HTTP embeddings or hash-dev; TurboVec or in-memory; `!remember` SQLite |
| `mp-voice` | VAD → STT HTTP → TTS HTTP | **live** energy VAD + HTTP STT/TTS + watchword; Whisper out of process |
| `mp-radio` | director / bumpers | **live** local seed + every-N bumpers; TTS bumpers need Piper |
| `mp-economy` | mine/craft/trade/UEX | **live** seed catalog + work orders; sc-craft/UEX/sc-trade HTTP later |
| `mp-mcp` | MCP tools | **live** Bearer REST `/mcp/tools` + `/mcp/tools/call`; confirm-for-high-impact |

Day-1 traits (locked so crates cannot invent competing shapes):

```rust
trait MusicProvider { async fn resolve(&self, input: &str) -> Result<Track>; }
trait Brain { async fn turn(&self, req: TurnRequest) -> Result<TurnResponse>; }
trait TsSession {
    async fn send_text(&self, target: Target, body: &str) -> Result<()>;
    fn subscribe(&self) -> broadcast::Receiver<TsEvent>;
    async fn send_opus(&self, pkt: OpusPacket) -> Result<()>;
}
trait ToolExecutor { async fn dispose(&self, proposal: ToolProposal, subject: Subject) -> DisposeResult; }
```

## TS protocol — go / no-go (the rewrite killer)

`@moneypenny/ts6-client` wraps `@honeybbq/teamspeak-client@0.2.3` plus TS6 HTTP
Query, file-list, move resolver, presence, voice-transport health. There is no
official TS6 SDK.

| Option | What | Verdict |
|--------|------|---------|
| **A. tsclient-rs** | Native Rust, claims TS3/5/6, tokio, Opus send | **Keep.** Spiked 2026-09-06 on local TS6 6.0.0-beta12. Gates 1–5 passed; reconnect scheduler ported. |
| **B. Node sidecar** | Keep honeybbq; Rust talks Unix socket | Fallback only if inbound `voiceData` fails on a populated channel. |
| **C. Reimplement TS6** | Months, undocumented | Do not start. |
| **D. tsclientlib / tsproto** | TS3 only | Insufficient. |

Live command:

```bash
# needs a TS6 (LAN or `docker run … teamspeak6-server:6.0.0-beta12`)
set -a && source .env && set +a   # TS6_HOST, TS6_API_KEY, …
cargo run -p mp-ts --example join --features tsclient-rs
```

**Spike results (local TS6 6.0.0-beta12, 2026-09-06, babbypc):**

| Gate | Result |
|------|--------|
| 1. Connect, nick, channel | **Pass.** `client_id=1`. `channel_id()` reported 0 (tsclient-rs gap — HTTP Query `cid=1`). |
| 2. textMessage in/out | **Pass.** Channel send echoed back as recv (self-echo; still proves the path). |
| 3. 10s Opus music | **Pass.** 500 × 20 ms frames (`CODEC_OPUS_MUSIC=5`, silence encodes to 3-byte DTX). |
| 4. inbound `voiceData` | **Pass (retest).** 750 frames from `grafcv` (clid=3, `CODEC_OPUS_VOICE=4`). Last packet decoded to 1920 bytes PCM (20 ms mono 48 kHz). |
| 5. HTTP Query + groups | **Pass.** `GET /1/clientlist?-groups` 200, nickname visible, `client_servergroups` present. |
| 6. Reconnect after restart | **Scheduler ported** (backoff + cancel generation). Live restart still operator-tested. |

Org `TS6_HOST=192.168.1.69` was **ARP-dead** from this host; `ts.beardforce.com:9987` UDP timed out. Do not treat those as a protocol fail.

**Known gaps (not blockers):** `Client::channel_id()` is 0 after join — enrich from HTTP Query. Self-echo of our own chat is filtered in the bot loop. Filter self-echo on `voiceData` (clid == self) when Phase 6 wires inbound voice.

HTTP Query (`:10080` + `TS6_API_KEY`) is `reqwest` and is **not** blocked on UDP.

## Invariants (encode as tests)

1. LLM proposes; executor disposes. Tools re-enter the gated deterministic path.
2. Never put the model between a user and skip. Transport is fail-open.
3. Default-deny RightsEngine: UID / server-group / channel-group, deny wins,
   scope voice|chat|both, `superAdminUids` bypass. Web uses the same gate.
   Nickname match for web↔TS is **exact**.
4. Local-first. Same `.env`, `llmUrl` ≠ `embeddingUrl` (split-brain).
5. Wire contracts: sqlite schema, OpenAPI paths, cookie `moneypenny_session`
   (httpOnly, SameSite=Lax, Secure when HTTPS), command names, rank JSON.
6. One binary, cargo features `sbc` / `server` / `npu` (rkllama URL only),
   arm64 + x86_64.

`executeTools: false` never mutates the queue.

## How to run

```bash
# from repo root
cd crates
cargo test --workspace
cargo test -p mp-audio
cargo run -p moneypenny            # binds 127.0.0.1:3000 by default
cargo run -p mp-ts --example join  # mock spike

# existing Node DB, read-only check
cargo run -p moneypenny -- --data-dir ../bot/data --check-schema
```

Useful env (native debug):

```bash
BIND_ADDRESS=0.0.0.0
MONEYPENNY_WEB_DIST=/path/to/bot/web/dist
MUSIC_DIR=/path/to/music
TS6_HOST=127.0.0.1 TS6_PORT=9987 TS6_NICK=Moneypenny
# optional LLM (OpenAI-compat). Empty / llmEnabled=false → POST /v1/turn is 409 LLM_DISABLED
# LLM_ENABLED=1 LLM_URL=http://127.0.0.1:11434 LLM_MODEL=qwen2.5:7b-instruct-q4_K_M
# BRAIN_URL=http://brain:8090   # remote POST {url}/v1/turn instead of in-process
# optional voice (Whisper/Piper stay out of process)
# VOICE_ENABLED=1 STT_URL=http://127.0.0.1:9000 TTS_URL=http://127.0.0.1:8880
# RADIO_ENABLED=1   # or Settings → Radio; seeds local library
# ROAST_ENABLED=1   # or Settings → Roast
# MCP_ENABLED=1 MCP_TOKEN=secret   # Bearer REST at /mcp/tools
```

Needs: `rustc` 1.85+, `pkg-config`, `libopus` (for `mp-audio` default feature).
RMS/VAD tests compile without libopus via `--no-default-features -p mp-audio`.

Node is unchanged: `cd bot && npm run build:native` still builds the N-API addon.

## Dual-run / schema

Canonical SQL: `crates/mp-db/src/schema.sql` (every Node `CREATE TABLE IF NOT EXISTS`).
One migrator owns DDL. Prefer **Rust-read / Node-write** until flip. Both
runtimes running `CREATE IF NOT EXISTS` is OK; **do not both ALTER**.

Golden OpenAPI operations: `crates/mp-http/fixtures/openapi-operations.json` (147 ops).
Frozen command names: `crates/mp-control/fixtures/command-manifest-names.json` (67).

## Docker

```bash
docker compose -f docker-compose.yml -f docker-compose.rust.yml --profile rust up --build
```

Rust publishes `127.0.0.1:3001:3000`. Node `:3000` stays. Same volumes
(`/app/data`, `MUSIC_DIR`), uid 1000, `cap_drop: ALL`, read-only rootfs.

## Phases

These numbers are **the rewrite sequence**, not DESIGN.md product phases
(product Phase 4 is remote/split-brain LLM, already shipped on Node).

| Phase | Exit | Status |
|-------|------|--------|
| **0 spike** | `cargo test --workspace`; health; schema; audio lift; TS mock | **done** |
| **1 skeleton** | create admin in existing Vue UI against Rust | **done** |
| **2 music bot** | `!play` `!skip` `!queue` rank-gated, no LLM | **done** |
| **3 HTTP parity** | every Vue page, no console 404s, live-status WS | **done** |
| **4 brain** | `POST /v1/turn`, dispose after rights | **done** |
| **5 RAG/memory** | TurboVec + doctrine + `!remember` | **done** |
| **6 voice** | inbound Opus → STT sidecar → Piper. Whisper out of process | **done** |
| **7 radio** | `docs/radio.md` | **done** (this branch) |
| **8 community** | roast, economy, MCP, moves | **done** (this branch) |
| **9 cutover** | `BOT_RUNTIME=rust` default; keep `moneypenny-node` one release | — |

Kill criteria for the *spike* (gates 3+4 fail **and** sidecar Option B rejected)
did **not** fire. Option A (`tsclient-rs`) is the live path.

## What is mock vs live (Phase 8)

| Surface | Live | Mock / stub |
|---------|------|-------------|
| Opus encode/decode + RMS VAD | live (libopus) | — |
| SQLite schema + users/sessions | live | — |
| `GET /api/health`, `/api/healthz` | live | `llm.route` stays `none` until a completion is tracked |
| Session setup/login/cookie/CSRF | live | audit log insert skipped |
| Vue `bot/web/dist` static | live if dist present | — |
| OpenAPI JSON | frozen catalog | `/api/docs` HTML is a snapshot index |
| Vue pages (Home/Search/Library/History/Live/Settings/Economy/…) | **live** session + `/api/bot` + local music/player + seed economy | harness/recordings/ACE-Step still empty or 503 |
| `/ws` live-status | **live** `init` + `stateChange` | — |
| TeamSpeak UDP / Query | **live** when `TS6_HOST` is set (`tsclient-rs` LiveSession + reconnect) | mock / HTTP-only if `TS6_HOST` empty |
| `!play` `!skip` `!queue` + web play | **live** local library, rank-gated; YouTube via yt-dlp; direct HTTP streams | Spotify/Tidal bridges, yt-library save |
| `POST /v1/turn` | **live** admin cookie; in-process LLM or `BRAIN_URL`; `executeTools` disposes after rights + harness policy | dashboard `/harness` ask still stub |
| `!ask` / `!remember` / `!recall` / `!forget` / `!reindex` | **live** chat path; SQLite memory; doctrine reindex | MemPalace / org KG still out |
| Doctrine `/api/rag/doctrine*` + `/api/rag/query` | **live** list/create/get/put/delete/reindex/query | multipart upload + pandoc export + reformat still stub |
| Settings `llmEnabled` / `llmUrl` / `llmModel` / `ragEnabled` / `memoryEnabled` / `voice` | **live** in-memory on runtimes | not persisted to `config.json` (dual-run: Node still owns writes) |
| Inbound voice | **live** Opus decode + energy VAD + HTTP STT + watchword + same executor as chat (`Scope::Voice`); Piper wav airs on the shared player (park/restore); `GET /api/bot/voice/status`; `POST /api/bot/voice/test` | Silero VAD, under-music-check, KWS |
| Radio | **live** director (disabled = `play_next`); local seed; `!radio` on/off/status/ops; every-N bumpers; Piper bumpers play via the same player; `GET /api/bot/radio/status`; `POST /api/bot/radio/test-bumper` | ACE-Step, Icecast, YouTube/stream seed, doctrine/memory LLM bumpers, prerecorded pool, analyzer |
| Moves | **live** `!move` / `!moveclient` / `!moveall` (30s confirm, max 10) / `!follow` via TS6 HTTP Query | no auto-follow |
| Roast | **live** channel capture + `!roast` / `!roastout` / `!roastin`; LLM grade fail-open; Settings toggle | no voice-transcript capture; auto-reel needs LLM + min present |
| Economy | **live** seed ores/methods/mine/refine + SQLite work orders; Vue `/api/economy/*` | sc-craft / sc-trade / UEX HTTP still 503; no scrapers |
| MCP | **live** Bearer `GET /mcp/tools` + `POST /mcp/tools/call`; `NEEDS_CONFIRMATION` on ban/stop/clear/mod | not the Node SDK streamable-HTTP transport; ACE-Step `generate_music` unavailable |

## Brain code map (Phase 4)

Contract: [brain-boundary.md](./brain-boundary.md). Brain *proposes*; bot *disposes*.

| Path | Role |
|------|------|
| `crates/mp-brain/` | `TurnRequest`/`TurnResponse`, `InProcessBrain`, `HttpBrain`, `complete_turn` (soft-fail) |
| `crates/mp-control/src/tool_map.rs` | `play_music` / `skip` / … → `ParsedCommand` |
| `crates/mp-control/src/dispose.rs` | harness policy → tool-map → rights → `CommandExecutor` |
| `crates/mp-http/src/brain.rs` | `POST /v1/turn` (admin cookie, CSRF) |

```
dashboard  →  POST /v1/turn
                 │
                 ├─ BRAIN_URL empty: InProcessBrain (OpenAI-compat LlmModule)
                 └─ BRAIN_URL set:   HttpBrain → remote /v1/turn
                 │
                 └─ executeTools:true → BrainDisposer → CommandExecutor (rights)
```

## Voice code map (Phase 6)

| Path | Role |
|------|------|
| `crates/mp-voice/` | energy `SilenceSegmenter`, watchword, `HttpSttClient` (`POST /asr`), `HttpTtsClient` (Piper `/v1/audio/speech`), `VoiceRuntime` |
| `crates/mp-http/src/voice_api.rs` | `GET /api/bot/voice/status`, `POST /api/bot/voice/test` |
| `crates/moneypenny/src/bot.rs` | inbound `VoiceData` → decode → VAD → STT → same `dispatch_command` as chat (`Scope::Voice`); Piper airs via `ChannelSpeech` |
| `crates/mp-music/src/speech.rs` | Park current song, play TTS wav on the shared player, restore on TrackEnd. Pause/stop hold the queue. Skip does not wait. |

Whisper stays a sidecar. Self-echo (`clid == self`) and music codec `5` are dropped.

## Community code map (Phase 8)

| Path | Role |
|------|------|
| `crates/moneypenny/src/moves.rs` | `!move` / `!moveclient` / `!moveall` / `!follow` over TS6 HTTP Query |
| `crates/mp-http/src/roast.rs` | Channel capture, LLM grade (fail-open), `!roast` reel — **not** on skip |
| `crates/mp-economy/` | Seed ores/methods + mine/refine + work-order parse |
| `crates/mp-http/src/economy_api.rs` | Vue `/api/economy/*` |
| `crates/mp-mcp/` | Bearer token, `HIGH_IMPACT` + `NEEDS_CONFIRMATION` |
| `crates/mp-http/src/mcp_api.rs` | `GET /mcp/tools`, `POST /mcp/tools/call` (outside CSRF) |

Do not rewrite Vue, sidecars, or add features Node does not have.
Refuse Leptos, in-process Whisper, rewriting Piper.
