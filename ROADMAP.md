# Project Moneypenny — Roadmap

Forward-looking plan. Continues the phase taxonomy of [`DESIGN.md`](./DESIGN.md)
§13 (Phases 0–3 = validate → local music → LLM → rights → voice → polish, mostly
shipped). This document covers **Phases 4–8**: turning Moneypenny from a music +
`!ask` bot into the org's AI — music, a citeable knowledge base (doctrine /
INTSUMs), and durable memory of people and events — runnable on either the local
RK3588 NPU or a bigger remote/GPU model.

> Status note (2026-06): Phases 0–2 are live on the Orange Pi 5 Max. The NPU LLM
> path (Qwen3-4B-Instruct-2507, W8A8, rkllama native backend) is deployed and
> serving tool-calls. Web upload + system-prompt/temperature controls landed.

## Target architecture

```
                 ┌──────────────── LLM endpoints (OpenAI /v1) ────────────────┐
                 │  local: rkllama (RK3588 NPU, Qwen3, cheap/offline)         │
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
| NotPunchnox/rkllama | Qwen3-4B `.rkllm` | **NPU** | 4.87 | ✅ |
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
**Goal:** durable per-user/conversational memory + a temporal knowledge graph
(who held what role when, fleet comps, op history) — institutional memory.
**Work:** run MemPalace as a sidecar (Python/MCP + embedding model); bot
read/writes over HTTP/MCP; optional specialist personas (intel / logistics) with
separate diaries.
**Caveats:** MemPalace is young (shipped 2026-04, viral, contested benchmark
claims) — pilot it, don't bet the architecture on its headline numbers. It is
*memory*, not a document library; it sits next to Phase 6, not over it.
**Accept:** the bot recalls per-user facts across sessions; the KG answers a
"who was X as of <date>" temporal query.

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
