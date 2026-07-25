# Project Moneypenny — Roadmap

Forward-looking plan. Continues the phase taxonomy of [`DESIGN.md`](./DESIGN.md)
§13 (Phases 0–3 = validate → local music → LLM → rights → voice → polish, mostly
shipped). This document covers **Phases 4–8**: org AI (citeable doctrine,
memory, radio polish) on the **dual-edition** product.

> Status note (2026-07): Phases 0–6 + split-brain R1 are live. Product ships as
> **two editions** from one repo — **SBC** (RK3588 edge) and **Server** (x86
> GPU-class). See [docs/editions.md](./docs/editions.md) and [RELEASES.md](./RELEASES.md).
> Voice is **Whisper ladder + Piper** (sherpa/Kokoro legacy only). NPU chat is
> offline opt-in, not the day-to-day path.

## Target architecture

```
  ┌── SBC edition (RK3588) ──┐          ┌── Server edition (x86+GPU) ──┐
  │ bot, rights, music       │  chat    │ ollama Gemma 4 12B (+ 31B)  │
  │ ollama nomic-embed-v2    │ ───────► │ optional heavy STT large-v3 │
  │ turbovec, Whisper base NPU│          └─────────────────────────────┘
  │ piper-tts                │
  │ (opt rkllama offline)    │   OR server all-in-one (Topology B)
  └──────────────────────────┘

  bot ─── llmUrl ─────────── OpenAI /v1 (LAN or local)
      ─── embeddingUrl ───── ollama nomic-embed-text-v2-moe (SBC) / bge-large (Server)
      ─── stt / tts ──────── stt-whisper + piper-tts
      ─── VECTOR_DB_URL ──── turbovec:6333 (Qdrant-shaped REST bridge)

  ControlRouter ─ deterministic │ !ask / fuzzy → LLM tools
  HTTP ──────── Express plugins · OpenAPI /api/docs · POST /v1/turn
  TS6 ───────── @moneypenny/ts6-client (workspace package)
  Retrieval ─── TurboVec + rank-gated doctrine (Phase 5–6)
  Memory ────── MemPalace + per-user facts (Phase 7)
```

Two retrieval stores, deliberately separate and complementary:
- **Doc-RAG** = authoritative documents, chunked + retrieved **with citations**,
  with upload/version/delete and rights-gating. Source of truth.
- **MemPalace** = living per-user/conversational memory + a temporal knowledge
  graph (facts with validity windows: roster, roles, op history over time).

## Already in place (these phases build on, not replace)
- **Dual editions** — `install.sh --edition sbc|server`, compose overlays,
  package-release tarballs ([RELEASES.md](./RELEASES.md)).
- **OpenAI-compatible `llmUrl`** (DESIGN §9) — split-brain + analyst delegate.
- **Whisper + Piper voice** — [docs/voice-backends.md](./docs/voice-backends.md).
- **Web upload pipeline** + doctrine git / file-drop / TS drop channel.
- **SQLite** (`bot/src/data/`) — community/roast, sessions, config.
- **System-prompt + temperature controls** — persona + specialist agents.

---

## Phase 4 — Scalable / remote LLM + dual editions
> **Status (2026-07): SPLIT-BRAIN + R1 DELEGATION + EDITIONS SHIPPED.** Chat/tool-calling
> points at LAN or local 12B (`llmUrl`); embeddings stay on-device
> (`embeddingUrl=http://ollama:11434`). **SBC** and **Server** editions package
> the two host roles ([docs/editions.md](./docs/editions.md)). Production:
> Gemma 4 12B QAT on server, E2B fallback + **nomic-embed-text-v2-moe** on SBC;
> analyst Gemma 4 31B on the same or second host. **DESIGN §R1:** `!analyst` /
> `delegate_to_agent` (`bot/src/llm/delegate.ts`); warmup in `bot/src/llm/warmup.ts`.
> Vectors: **TurboVec** (`services/turbovec-bridge`). See [docs/rag-embeddings.md](./docs/rag-embeddings.md).

### R1b — async analyst jobs (shipped 2026-06-20)

`!analyst` / `delegate_to_agent` ack immediately (`Analyst on it…`) and post the
full result via `postFollowUp` when the delegate model finishes (`bot/src/control/router.ts`).
Voice uses the same pattern (spoken ack, text follow-up). Analyst commands are
rank-gated (`@analyst` group — admins by default).

**Goal (met):** run big models on Server edition; keep the bot arch-agnostic via
OpenAI `/v1`. NPU remains SBC offline opt-in only.
**Accept:** changing `llmUrl` routes `!ask`/intent to a remote big model with
tool-calling intact; both editions installable from one tree.

### On-device LLM serving — decisions & benchmarks (2026-06-12)

Benchmarked three serving paths on the Orange Pi 5 Max (16 GB) with the real
`play_music` tool schema. **Decode throughput converged regardless of accelerator:**

| Serving path | Model | HW | tok/s | Tool-calls |
|---|---|---|---|---|
| ollama (OpenAI `/v1`) | Gemma 4 **E4B** QAT GGUF | CPU/Mali | 4.97 | ✅ |
| NotPunchnox/rkllama | 4B-class `.rkllm` | **NPU** | 4.87 | ✅ |
| ollama (OpenAI `/v1`) | Gemma 4 **E2B** QAT GGUF (UD-Q4_K_XL) | CPU/Mali | **9.95** | ✅ |

**Key finding: the NPU gives ~no decode speedup over CPU for a 4B here.** RK3588
LLM *decode* is **memory-bandwidth-bound**, not compute-bound — even Rockchip's own
optimized NPU runtime (native RKLLM) lands at the same ~4.9 tok/s as ollama on
CPU. The only lever that actually moves decode is **model size**: dropping 4B→2B
(Gemma E4B→E2B) ~doubles it to ~10 tok/s with tool-calling intact.

**Current production choice:**
- **Server edition / LAN chat:** Gemma 4 **12B** QAT on ollama.
- **SBC on-device fallback:** Gemma 4 **E2B** QAT on ollama (~10 tok/s).
- **SBC NPU:** rkllama + operator `.rkllm` only when offline opt-in (`--llm npu`).
- Day-to-day chat is **not** NPU-bound; NPU is used for **Whisper base** STT (RKNN).

**NotPunchnox/rkllama** (`ghcr.io/notpunchnox/rkllama:main`) is validated as a
drop-in maintained replacement for `server.py`: OpenAI `/v1`, model management,
loaded our existing `.rkllm` with no re-conversion, tool-calls work. Adopt it if/
when we want to consolidate the NPU path — but it buys no speed over ollama-CPU.

**Deferred — GGUF-on-NPU via the `invisiofficial/rk-llama.cpp` fork** (llama.cpp
with RKNPU2 as a GGML backend; enabled in NotPunchnox via `--llamacpp <bin>`).
This is the *only* way to run a Gemma GGUF on the NPU, but it's parked, not
dropped, for three reasons: (1) a from-source C++/cmake build against the RKNPU
SDK on ARM — high cost, toolchain-fragile; (2) Gemma **4** is days old, so the
fork's llama.cpp snapshot may not have the arch yet (Gemma 3 is safe, 4 is a
gamble); (3) per the bench above it can't help **decode** (bandwidth-bound) and a
community NPU-offload backend is more likely to fall back to CPU than to beat
native RKLLM. **Where it *would* pay off later:** prompt **prefill** is
compute-bound (unlike decode), so once Phase 6 doc-RAG is stuffing long
doctrine/INTSUM context into the prompt, NPU offload of prefill could matter even
though it does nothing for short music-intent/chat. Revisit then.

## Phase 5 — Vector store + embeddings (the shared foundation)
**Goal:** stand up a vector DB sidecar (**TurboVec** bridge; historically Qdrant-shaped REST) + an embedding model
(small local, or hosted on the big box). Shared substrate for Phases 6 and 7.
**Accept:** ingest text → embed → store → a semantic query returns the relevant
chunks; runs as a compose service alongside the bot.

## Phase 6 — Document RAG (doctrine / INTSUMs / org docs)
> **Status (dev): IMPLEMENTED.** `.md` doctrine (frontmatter →
> `classification`/`tags`) embedded into TurboVec; `!ask` answers are grounded +
> carry a `📎 Sources:` citation footer; retrieval is **rank-gated** (classified
> chunks filtered by the invoker's `doctrine:<level>` rights — see
> **[docs/rank-gating.md](docs/rank-gating.md)**); `!reindex` command
> + a Doctrine admin section in the Library UI. **All four ingestion paths now
> ship:** web-upload, the canonical **git wiki-as-code** post-receive flow
> (`scripts/setup-doctrine-repo.sh`, nested paths + recursive watcher), manual
> file drop, and the **TeamSpeak `moneypenny-drop` file browser** (`.md` → RAG,
> audio → music library; `!ingeststatus`). Full guide: **[docs/rag-ingestion.md](docs/rag-ingestion.md)**.

**Goal:** an org knowledge base the bot can answer from, with citations.

**Canonical ingestion source: wiki-as-code (a git repo of Markdown).** Git is the
right substrate for authoritative docs — every change is a reviewed commit with
author/date, which gives provenance, the temporal dimension for free (cite "as of
commit X / date Y" — feeds the Phase 7 knowledge graph), and cheap incremental
re-embedding (only `git diff`'d files change). The web upload (`/api/bot/upload`)
stays as the secondary/ad-hoc path.

**Two ingestion topologies:**
1. **On-device private git (recommended default).** A bare repo (or self-hosted
   Gitea/Forgejo) on the device; members push over SSH/LAN/VPN. A server-side
   **`post-receive` hook** fires the ingestion on every push — the local
   equivalent of a webhook, instant, **zero inbound network exposure**. OPSEC
   win for INTSUMs: sensitive intel never leaves your hardware; works offline.
   Gitea/Forgejo adds web editing + PR review + access control, still 100% local.
   Mitigate the single-point-of-failure with a mirror (`git push --mirror` to a
   second box or a *private* GitHub as encrypted offsite backup).
2. **Remote private GitHub → webhook → ingest.** Good if the org already lives on
   GitHub. Bot clones via a read-only deploy key/PAT (stored as a secret).

**Ingestion pipeline:** `post-receive`/webhook → `git diff` changed files → chunk
by heading → embed deltas → upsert into the vector DB (Phase 5) with **stable
chunk IDs** (`path#section`) so edits replace cleanly and deletes/renames purge
stale vectors. Markdown **frontmatter** (`classification:`, `tags:`, `valid_until:`)
becomes vector-DB metadata for scoped retrieval and gating.

**Retrieval:** top-k chunks injected into `!ask`/intent; answers carry **citations**
back to the source (repo path + commit permalink). **Rights-gated** — INTSUMs may
be sensitive, so retrieval honors the rank model (DESIGN §8) and frontmatter
classification.

**Accept:** push a doctrine edit to the wiki repo → it's ingested automatically
(post-receive) → `!ask` about it returns a grounded answer citing the file +
commit; an unauthorized member is denied the gated/classified corpus.

## Phase 7 — Long-term memory (MemPalace)
> **Status (dev): SHIPPED (2026-06); polished 2026-07 (A1–A5).** Per-user:
> `!remember` / `!recall` in SQLite + optional MemPalace semantic recall.
> Institutional: temporal **knowledge graph** via `!kg` / `!diary` (SQLite +
> MemPalace `org_kg` / diary rooms), injected into `!ask` when `kgEnabled` is on.
> Analysts record; `!kg who <name> [asof:date]` answers temporal roster/role
> queries. Install: `--with-memory`. Ops: [docs/memory.md](./docs/memory.md).
> Radio org bumper: `memoryBroadcastOptIn` + source `memory` (never private facts).

**Goal:** durable per-user/conversational memory + a temporal knowledge graph
(who held what role when, fleet comps, op history) — institutional memory.
**Work:** MemPalace sidecar (`docker compose --profile memory`); bot sync over
HTTP (`/v1/kg/*` on the bridge). Specialist diaries: `!diary intel|logistics`.
**Caveats:** MemPalace is young — pilot it, don't bet the architecture on headline
benchmarks. It is *memory*, not a document library; it sits next to Phase 6.
**Accept:** per-user facts across sessions; KG answers "who was X as of <date>".

## Post-core — R4 client moves (shipped 2026-06-20)

`!moveclient` — admin command to relocate another TS user to a named channel. TS6
uses HTTP Query `clientmove`; TS3 uses the full-client `clientMove` API. Rate-limited
to 5 moves per minute. Voice-compatible via deterministic routing (say `moveclient …`).

## Phase 8 — Community layer (the roast)
> **Status: SHIPPED.** Ops: [docs/roast.md](./docs/roast.md).

**Goal (met):** capture chat by TS uid → LLM cringe-grade (0–10 + reason) →
auto reel when **≥N present** + cooldown; `!roast` / `!roastout` / `!roastin`.
SQLite only. Voice zero-arg for the three commands. Capture strips BBCode/URLs.

---

## Dependencies / sequencing
- Phase 8 (roast MVP) is **independent** — SQLite only; can land first as a quick win.
- Phase 6 and 7 both depend on Phase 5 (vector DB + embeddings).
- Phase 4 (remote big LLM) makes 6 and 7 meaningfully better and is a near-free
  config flip — worth doing alongside Phase 5.

---

## Adjacent feature — YouTube → permanent local library (auto-save)

**Goal:** when a YouTube URL is played in the channel, **stream it immediately**
*and* download/convert it to a properly-tagged **MP3** that becomes a first-class,
permanent track in the local library (searchable, with title/artist + embedded
cover art) — so the org slowly builds its own owned music collection from what
people actually play. Not an evictable cache: saved for good.

**Dedup by canonical YouTube video ID** (the 11-char id, extracted from any URL
form — `watch?v=`, `youtu.be/`, `/embed`, `/shorts`). The same video never
re-downloads regardless of which URL variant is pasted; a DB table maps
`video_id → saved path`. (Content-hash dedup across *different* sources is a
possible later layer; video-id is the reliable primary key, not file MD5 — two
downloads of one video can differ byte-for-byte.)

**Flow:** `!play <yt url>` → resolve video id → if already saved, play the local
MP3 instantly (no network/yt-dlp); else stream now (instant start) **and**
fire-and-forget a background `yt-dlp -x --audio-format mp3 --embed-metadata
--embed-thumbnail` into `MUSIC_DIR/youtube/`, then re-index via LocalProvider so
it's searchable by title. An in-flight lock prevents double-downloads.

**Scope:** opt-in (`youtubeSaveEnabled`, off by default — downloading is against
YouTube ToS, the usual self-hosted private-server call). Reuses the existing
yt-dlp + ffmpeg + LocalProvider indexing (tags/cover already parsed). yt-dlp
flakes on some videos (age/region) → fall back to streaming, don't save those.
**Independent of Phases 4–8; can ship anytime.**

**Accept:** play a YouTube URL → it streams + a tagged MP3 appears in the library;
replay the same (or a different URL form of the same video) → served from the
saved local file, no re-download.

---

## Feature roadmap (Harness first, Station continuous)

Product-facing tracks after the 2026-07 radio/TTS/doctrine arc. **Decisions
locked 2026-07-09:** harness-first (B), Station polish from user feedback (not
a gate), org memory + SC/org tools in scope now, Vue polish (no framework swap),
Python “brain” **planned** only until pain criteria hit. TS spine + sidecars stay.

→ **[docs/feature-roadmap.md](./docs/feature-roadmap.md)**

## Build list (near-term)

See **[docs/BUILD.md](./docs/BUILD.md)** for the living queue. Highlights:

| ID | Item | Doc |
|----|------|-----|
| **P0** | **Poke as command channel** (TS poke → router) | BUILD.md |
| **A\*** | **ACE-Step** optional music generation for DJ / `!generate` | [docs/ace-step.md](./docs/ace-step.md) |
| V1–V2 | Server Vulkan STT smoke; removed sherpa/Kokoro (V2) | voice-backends.md |

## Phase 9 — Radio mode / autonomous DJ (backend shipped 2026-07)

Full design + phasing in **[docs/radio.md](./docs/radio.md)**. Moneypenny runs
the channel like a station: every *N* tracks (or on dead air) she inserts a
short **bumper** — a prerecorded jingle, a canned station ID / time check, or a
doctrine note retrieved at the **classification floor of everyone present**,
rewritten by the LLM (`tool_choice:"none"`, word-capped) and spoken via TTS.
`!radio ops <profile>` retunes music selection *and* bumper topics in one
switch. Built as a thin program director over the existing single-stream
player — the model is never between a user and the music; every failure falls
open to `playNext()`.

**Status:** phases R-R1 – R-R6 are **mechanism-complete and tested** on `dev`
(Icecast tee, relay-in, Spotify/Tidal `/playlist` bridges, embedded tag seed,
bulk tags, rating-weight draw, harmonic sequencing, music color overlay,
bumper prewarm, presence-gate fix for scheduled bumpers). **2026-07 polish:**
alone-stop (honeybbq membership), user `!add` ahead of radio fill, seed pool
**~33% local / ~66% YouTube** (configurable), bumper meta-instruction filter,
TTS barge-in + reconnect/transport self-heal. Dashboard: Settings **Radio / DJ**
(seed sources, external %, harmonic/color/prewarm), Library track tags + bulk +
LLM guess. Everything remains **off by default** (`radio.enabled=false`).
**Optional remaining:** full live TS under-music smoke on opi5; Spotify audio
needs operator librespot; ACE-Step non-mock needs a GPU worker URL.
