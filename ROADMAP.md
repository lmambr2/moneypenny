# Project Moneypenny — Roadmap

Forward-looking plan. Continues the phase taxonomy of [`DESIGN.md`](./DESIGN.md)
§13 (Phases 0–3 = validate → local music → LLM → rights → voice → polish, mostly
shipped). This document covers **Phases 4–8**: turning Moneypenny from a music +
`!ask` bot into the org's AI — music, a citeable knowledge base (doctrine /
INTSUMs), and durable memory of people and events — runnable on either the local
RK3588 NPU or a bigger remote/GPU model.

> Status note (2026-06): Phases 0–2 are live on the Orange Pi 5 Max. The NPU LLM
> path (operator `.rkllm` via `models/npu-llm/`, rkllama native backend) is deployed and
> serving tool-calls. Web upload + system-prompt/temperature controls landed.

## Target architecture

```
                 ┌──────────────── LLM endpoints (OpenAI /v1) ────────────────┐
                 │  local: rkllama (RK3588 NPU, operator .rkllm, offline)   │
   bot ───llmUrl─┤  remote: vLLM/ollama/TGI on x86+GPU (big model, heavy RAG) │
    │            └────────────────────────────────────────────────────────────┘
    │
    ├─ ControlRouter ─ deterministic commands │ !ask / fuzzy intent → LLM
    │
    ├─ Retrieval (Phase 6) ── Vector DB + embeddings (Phase 5)
    │      ▲ ingest (post-receive / webhook, diff→embed)
    │      └─ wiki-as-code git repo: doctrine, INTSUMs, org docs
    │           (on-device private git default; citeable-by-commit, rights-gated)
    │
    └─ Memory (Phase 7) ── MemPalace: per-user recall + temporal knowledge graph
```

Two retrieval stores, deliberately separate and complementary:
- **Doc-RAG** = authoritative documents, chunked + retrieved **with citations**,
  with upload/version/delete and rights-gating. Source of truth.
- **MemPalace** = living per-user/conversational memory + a temporal knowledge
  graph (facts with validity windows: roster, roles, op history over time).

## Already in place (these phases build on, not replace)
- **OpenAI-compatible `llmUrl`** (DESIGN §9) — pointing at a bigger remote model
  is a config change, not code. The NPU stays as the local/fallback path.
- **Web upload pipeline** (`/api/bot/upload` → `LocalProvider.uploadSong`,
  isolated `uploads/` dir) — the ingestion seam doc-RAG extends to documents.
- **SQLite** (`bot/src/data/`) — enough to ship the community/roast MVP without
  any new infra.
- **System-prompt + temperature controls** — per-persona prompting for the
  specialist agents below.

---

## Phase 4 — Scalable / remote LLM
> **Status (2026-06): SPLIT-BRAIN + R1 DELEGATION SHIPPED.** Chat/tool-calling can
> point at a LAN workstation (`llmUrl`) while embeddings stay on the Pi
> (`embeddingUrl=http://ollama:11434`). See `docs/remote-llm.md`. Production on
> operator Pi: `hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL` on
> LAN workstation @ 192.168.x.x (vs ~11 tok/s on-device Gemma E2B); analyst delegate
> `hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL` on the same or a second LAN host.
> **DESIGN §R1:** `!analyst` / `!agent` + `delegate_to_agent` tool (`bot/src/llm/delegate.ts`).
> Startup model pre-warm in `bot/src/llm/warmup.ts`.

### R1b — async analyst jobs (shipped 2026-06-20)

`!analyst` / `delegate_to_agent` ack immediately (`Analyst on it…`) and post the
full result via `postFollowUp` when the delegate model finishes (`bot/src/control/router.ts`).
Voice uses the same pattern (spoken ack, text follow-up). Analyst commands are
rank-gated (`@analyst` group — admins by default).

**Goal:** select between the local NPU model and a bigger model on another host
(or migrate the whole compose stack to a bigger server). The bot is
arch-agnostic; swap the `rkllama` service for a GPU LLM service and keep the rest.
**Why now:** serious RAG over doctrine/INTSUMs needs more than a 4B — the remote
big model is what makes Phases 6–7 actually good.
**Work:** document + script the remote-endpoint config (`llmUrl`); optional
"local vs remote" selection; migration notes (x86+GPU running vLLM/ollama).
**Open question:** is the bigger server **x86 + GPU** or another SBC? (Decides the
serving stack: vLLM/TGI vs ollama.)
**Accept:** changing `llmUrl` routes `!ask`/intent to a remote big model with
tool-calling intact; migration path documented and tried once.

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

**Current production choice:** **Gemma 4 E2B QAT GGUF on ollama** (`llmUrl=
http://ollama:11434`, `llmModel=hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL`).
ollama *is* a maintained OpenAI-compatible GGUF gateway, so this needs no custom
code; Gemma 4 has native function-calling, so it drives music intent + grades the
roast. The hand-rolled `services/rkllama/server.py` stays as the NPU/Qwen fallback.

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
**Goal:** stand up a vector DB sidecar (ChromaDB or Qdrant) + an embedding model
(small local, or hosted on the big box). Shared substrate for Phases 6 and 7.
**Accept:** ingest text → embed → store → a semantic query returns the relevant
chunks; runs as a compose service alongside the bot.

## Phase 6 — Document RAG (doctrine / INTSUMs / org docs)
> **Status (dev): IMPLEMENTED.** `.md` doctrine (frontmatter →
> `classification`/`tags`) embedded into Qdrant; `!ask` answers are grounded +
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
> **Status (dev): SHIPPED (2026-06).** Per-user: `!remember` / `!recall` in SQLite
> + optional MemPalace semantic recall. Institutional: temporal **knowledge graph**
> via `!kg` / `!diary` (SQLite + MemPalace `org_kg` / diary rooms), injected into
> `!ask` when `kgEnabled` is on. Analysts record; `!kg who <name> [asof:date]`
> answers temporal roster/role queries.

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
**Goal:** the fun first consumer of the above. Capture each user's lines (keyed by
TS uid), LLM-grade them for cringe/embarrassment (0–10 + one-line reason), and
auto-compile a "greatest hits" reel when **3+ members** are present.
**Work:** MVP on **SQLite** (independent of Phases 5–7, can ship anytime);
async/batched grading on the NPU (its ~4.5 tok/s can't grade inline); trigger with
a cooldown so it's a treat, not spam; **opt-out + purge** command; text first,
voice later (needs the unvalidated STT sidecars, DESIGN §10). Later enriched by
MemPalace recall (Phase 7).
**Accept:** 3+ present → a compilation posts (with cooldown); opt-out removes a
user's lines and stops capture.

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

**Status:** phases R-R1 – R-R5 are **mechanism-complete and tested** on `dev`;
dashboard surfaces shipped (`e02b87f`): Settings **Radio / DJ** panel, Library
**Track tags** editor + star ratings, `!radio pin`. Starter profiles `lobby` and
`focus` ship in `defaultRadioConfig()`. Everything remains **off by default**
(`radio.enabled=false`). **Remaining:** live TS smoke on opi5 (bumper test,
`!radio ops`), re-run OQ3 when a full org library is mounted, and optional
R-R6 (Icecast tee, relay-in, Spotify/Tidal playlist expansion).
