# Rust rewrite (WIP)

Replace the **Node bot process** (`bot/src/index.ts`) with a Cargo workspace at
`crates/`. Vue, Whisper, Piper, Ollama/rkllama, TurboVec, MemPalace, ACE-Step,
Spotify/Tidal bridges, `install.sh`, and compose overlays **stay**.

Source of truth for this branch: `lmambr2/moneypenny` @ `ec464a2` (DESIGN v3,
AGENTS.md seams, 1227 backend tests).

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

| Crate | Owns | Phase 0/1 status |
|-------|------|------------------|
| `moneypenny` | bin: boot, watchdog, SIGINT/SIGTERM | **live** |
| `mp-config` | `.env` + `config.json` defaults | **live** (load-only, no save) |
| `mp-db` | rusqlite, identical `CREATE TABLE IF NOT EXISTS` | **live** |
| `mp-audio` | audio-native minus napi (`NativeOpus`, `pcmRms`, `isSpeechFrame`) | **live** (libopus) |
| `mp-ts` | TS3/TS6 façade | **mock**; `examples/join.rs` |
| `mp-http` | axum: health, session, CSRF, SPA, OpenAPI snapshot | **live** (session + health) |
| `mp-rights` | RightsEngine | stub |
| `mp-control` | parse + executeDeterministic | stub + frozen command names |
| `mp-music` | Local / YouTube / Stream | stub + `MusicProvider` trait |
| `mp-brain` | `/v1/turn` | stub + JSON types |
| `mp-rag` | embeddings + TurboVec | stub |
| `mp-voice` | VAD → STT HTTP → TTS HTTP | stub |
| `mp-radio` | director / bumpers | stub |
| `mp-economy` | mine/craft/trade/UEX | stub |
| `mp-mcp` | MCP tools | stub |

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
| **A. tsclient-rs** | Native Rust, claims TS3/5/6, tokio, Opus send | Spike first. Not linked in Phase 0. |
| **B. Node sidecar** | Keep honeybbq; Rust talks Unix socket | Fallback if A fails TS6 voice. Do not stall. |
| **C. Reimplement TS6** | Months, undocumented | Do not start. |
| **D. tsclientlib / tsproto** | TS3 only | Insufficient. |

**Phase 0 decision:** Option A is **not proven**. `mp-ts` is a **mock**.
`cargo run -p mp-ts --example join` documents the live checklist. If `TS6_HOST`
is set, the example exits 2 until a live client is wired.

Gate (must pass on a live TS6 6.0 beta **and** a TS3 server):

1. Connect, set nickname, join a channel
2. Receive `textMessage` / poke → reply
3. Play 10s of Opus music (`CODEC_OPUS_MUSIC`)
4. Capture inbound `voiceData` PCM
5. `clientMove` via HTTP Query + enrich `serverGroups` (rank gating dies without this)
6. Survive a server restart (reconnect scheduler)

If 3 or 4 fail on TS6 with tsclient-rs, take Option B and keep rewriting the rest.

Also port: Ed25519 identity, self-echo poison, command-echo filters, error 770 =
already in channel.

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

| Phase | Exit |
|-------|------|
| **0 spike** (this branch) | `cargo test --workspace`; health; schema; audio lift; TS mock |
| **1 skeleton** | create admin in existing Vue UI against Rust |
| **2 music bot** | `!play` `!skip` `!queue` rank-gated, no LLM |
| **3 HTTP parity** | every Vue page, no console 404s, live-status WS |
| **4 brain** | `POST /v1/turn`, dispose after rights |
| **5 RAG/memory** | TurboVec + doctrine + `!remember` |
| **6 voice** | inbound Opus → STT sidecar → Piper. Whisper out of process |
| **7 radio** | `docs/radio.md` |
| **8 community** | roast, economy, MCP, moves |
| **9 cutover** | `BOT_RUNTIME=rust` default; keep `moneypenny-node` one release |

Kill criteria: spike 1+2 (TS connect + Opus in a real channel) fail **and**
sidecar Option B is rejected. Stop. Do not rewrite the rest.

## What is mock vs live (this commit)

| Surface | Live | Mock / stub |
|---------|------|-------------|
| Opus encode/decode + RMS VAD | live (libopus) | — |
| SQLite schema + users/sessions | live | — |
| `GET /api/health`, `/api/healthz` | live | llm.route=`none` |
| Session setup/login/cookie/CSRF | live | audit log insert skipped |
| Vue `bot/web/dist` static | live if dist present | — |
| OpenAPI JSON | frozen catalog | most paths 404 |
| TeamSpeak UDP / Query | — | `MockSession` |
| Player, rights, LLM, radio, RAG, voice | — | compiling stubs |

Do not rewrite Vue, sidecars, or add features Node does not have.
Refuse Leptos, in-process Whisper, rewriting Piper.
