# Moneypenny — Feature roadmap (harness vs station)

> Living product plan after the 2026-07 radio/TTS/doctrine arc. Complements
> [`ROADMAP.md`](../ROADMAP.md) (phases 0–9 status) and [`DESIGN.md`](../DESIGN.md).
> This doc answers: **what to build next**, **what not to rewrite**, and how to
> grow from “DJ + ops assistant for friends” toward a full **local AI harness**
> with TeamSpeak attached — without throwing away the stack that already ships.

**Status:** decisions locked 2026-07-09 · target: `dev` / `master`  
**Spine decision:** keep **TypeScript bot + Python/native sidecars**. No full
language rewrite. No framework swap for its own sake.

### Operator decisions (2026-07-09)

| # | Topic | Decision |
|---|--------|----------|
| 1 | Product identity | **B — Harness first** (AI cockpit / tools priority) |
| 2 | Station completeness | **Not a gate** — Station stays in progress; polish from **user feedback** in parallel |
| 3 | Org memory bumper | **Invest now** — seed/use MemPalace org KG so memory bumpers can fire |
| 4 | Star Citizen / org hooks | **Want them** — tools/plugins (fail-open), not a second core |
| 5 | Dashboard UI | **Keep Vue**; polish in place (lessons transfer if we rebuild later) |
| 6 | Python “brain” service | **Plan the boundary now**; implement only when pain criteria hit |

---

## 1. Product identity

| Shape | Who it’s for | Success looks like |
|-------|----------------|--------------------|
| **A — Station** | Org VOIP / Star Citizen friends; music + briefings | Radio on, bumpers right, library/tags, doctrine tips, low ops burden |
| **B — Harness** | Same people + power users; AI-first ops | Chat/voice tools, cited RAG, shared memory, dashboard as cockpit |

**Locked default: B (Harness first).** Station (A) remains a first-class mode
and keeps shipping via feedback; it does **not** block harness work. Features
stay opt-in at runtime where that already matches product safety (radio/voice
off-by-default, etc.).

---

## 2. Architecture: what we have (and why it’s already hybrid)

```
┌──────────────── TS/Node bot (spine) ─────────────────┐
│  TS6 client · music/queue/player · radio director    │
│  ControlRouter · rights · Settings/Library API · Vue │
└─────────────┬───────────────┬───────────────┬────────┘
              │               │               │
     ┌────────▼──────┐ ┌──────▼──────┐ ┌──────▼──────────┐
     │ stt-whisper   │ │ piper-tts   │ │ ollama / rkllama│
     │ (Python/NPU)  │ │ (Python)    │ │ chat + embed    │
     └───────────────┘ └─────────────┘ └──────┬──────────┘
                                              │
                                     ┌────────▼────────┐
                                     │ Qdrant (RAG)    │
                                     │ MemPalace (KG)  │
                                     └─────────────────┘
```

| Layer | Language / service | Keep / move? |
|-------|-------------------|--------------|
| TS6, music, radio, rights, web | **TypeScript** | **Keep** — spine |
| STT / TTS / bridges / ACE adapter | **Python sidecars** | **Keep** — already extracted |
| Chat + embeddings | **Ollama / OpenAI `/v1`** | **Keep** — not in-process TS ML |
| Vectors | **Qdrant** | **Keep** |
| Agent orchestration | Thin TS tool loop today | **Extract only if pain** → FastAPI “brain” |

**Non-goals (explicit):**

- Full **Python** rewrite of the bot  
- **Rust** rewrite (no AI ecosystem win for this product)  
- **Vue → Svelte/Next** migration until the dashboard is rebuilt for product
  reasons (months of polish, little user value on the current Settings/Library)  
- Cloud LLM dependency as default  

---

## 3. Near-term principles

1. **Ship features on the spine** — radio, voice, RAG, memory polish first.  
2. **Fail-open** — music and transport never blocked by LLM/RAG/TTS (radio
   already follows this; keep it).  
3. **Config over code** — profiles, station ID, timezones, topics, sources
   (Settings) before new subsystems.  
4. **Observe then extract** — log skip reasons; only split a Python “brain”
   service when orchestration latency or complexity hurts operators.  
5. **Game hooks as tools** — Star Citizen / org APIs are plugins, not a second
   core.

---

## 4. Feature tracks

### Track S — Station polish (default product)

| ID | Feature | Why | Accept |
|----|---------|-----|--------|
| **S1** | Radio operator confidence | Operators trust bumpers | Doctrine/memory succeed or log clear skips; station ID package + timezones stable; cooldown/presence documented in UI |
| **S2** | Doctrine topics that match corpus | RAG tips on air | Profile topics curated per ops context; `!radio bumper <topic>` reliable; prewarm **+ doctrine** |
| **S3** | Library / tags quality | Selection beats seed chaos | Tag bulk + guess used; seeds stay local-only / duration-filtered; optional playlistRefs preferred |
| **S4** | Presence + cooldown UX | Fewer “why no bumper?” | Status shows humans, cooldown, next bumper; Settings tooltips match runtime |
| **S5** | TTS quality bar | British, consistent | Piper medium default; cache clear after voice change; no stale prerecorded jingles overriding TTS |

**Already largely shipped (2026-07):** diversity cycle, profiles editor, seeds
fix, station ID liners, multi-zone time checks, cori-medium, doctrine LLM
empty-content salvage, presence gate, AM color, prewarm.

**Remaining Station gaps:** live under-music smoke checklist; Spotify audio
path; ACE-Step non-mock worker; doctrine prewarm UX more obvious.

---

### Track H — Harness enhancement (AI cockpit)

| ID | Feature | Why | Accept |
|----|---------|-----|--------|
| **H1** | Chat-first dashboard panel | See the harness | Stream of turns: user, tools, sources, errors (admin) |
| **H2** | Cited answers in UI | Trust RAG | `!ask` / dashboard query shows sources + classification |
| **H3** | Memory scopes | Multi-user org | Clear UI for per-user vs org KG; never mix private into broadcast |
| **H4** | Voice-first progressive enhancement | Hands-free ops | Wake → command → spoken ack reliable under music; text fallback always works |
| **H5** | Tool transparency | Debug agentic loop | Log/tool panel: which tools fired, args, success/fail |
| **H6** | Multi-channel / multi-server (later) | Scale beyond one channel | Config for channel scope; no single global queue assumption |

**Depends on:** Station S1–S2 stable so radio doesn’t regress while harness UI grows.

---

### Track R — RAG & MemPalace depth

| ID | Feature | Why | Accept |
|----|---------|-----|--------|
| **R1** | Topic packs | Doctrine bumpers hit | Starter topic lists per profile (lobby/combat/mining) matching real files |
| **R2** | Ingest hygiene | Better retrieval | Reindex status, classification audit, expired chunk hygiene |
| **R3** | Eval loop (light) | Catch empty rewrites | Scripted queries: expected non-empty doctrine/memory; CI optional |
| **R4** | Org KG fill | Memory bumper useful | Path to seed org facts; `memory` bumper logs hits not only skips |
| **R5** | Game-state hooks (optional) | SC org awareness | Tools that pull org roster/status into RAG or tools — **plugin**, not core rewrite |

**Doctrine/memory split (keep deliberate):**

- **Doc-RAG** = citable source of truth (doctrine bumpers, `!ask`)  
- **MemPalace** = living facts / temporal KG (org memory bumper, personal recall)  

Never broadcast private `!remember` rooms (already load-bearing).

---

### Track V — Voice

| ID | Feature | Why | Accept |
|----|---------|-----|--------|
| **V1** | Reliability under music | Real channels | Duck/wake/command under DJ load documented + smoke script |
| **V2** | STT ladder docs ops | SBC vs server | One-page “which model on which box” stays accurate |
| **V3** | Spoken radio/status | Voice ops | Optional spoken radio status / “next bumper in N” |
| **V4** | Orchestration extract (maybe) | If TS turn code chokes | FastAPI voice-turn service; bot stays transport |

---

### Track G — Growth / Star Citizen org (optional)

Only after Station is boringly solid:

| ID | Feature | Notes |
|----|---------|--------|
| **G1** | Org command surface | `!ops`, status briefs via tools |
| **G2** | SC API / external status tools | Fail-open; cached; never blocks music |
| **G3** | Shared dashboard for non-admins | Read-only now-playing, next bumper, simple queue |
| **G4** | Audio / abuse moderation hooks | Rate limits, mute integration — rights-first |

---

## 5. When to extract a Python “brain” service

Do **not** extract by default. Extract when **two or more** are true:

- Voice turn pipeline needs retries, barge-in, multi-step tools beyond ControlRouter comfort  
- RAG eval / re-rank / multi-query becomes a pipeline you iterate weekly  
- Multiple clients (TS + web + future) need the **same** agent loop  

**Shape if extracted:**

```
TS bot (TS6 + music + rights) ──HTTP──► brain (FastAPI): plan → tools → answer
web dashboard ─────────────────────────► brain (same)
brain ──► ollama / qdrant / mempalace / stt / tts (unchanged)
```

**Still not a full rewrite** — the bot remains the TeamSpeak and music authority.

---

## 6. Suggested sequencing (next ~quarter)

```
Now ──► S1–S5 (finish Station trust)
     ──► R1–R2 (topics + ingest hygiene)
     ──► H1–H2 (thin harness UI: turns + sources)
     ──► V1 (voice under music smoke)
     ──► R4 (org KG useful for memory bumper)
     ──► H4–H5 / G* as product identity firmens
```

**Parallel ok:** docs, ACE-Step worker, Icecast ops — don’t block S1–S2.

---

## 7. Success metrics (lightweight)

| Metric | Station | Harness |
|--------|---------|---------|
| Forced doctrine bumper success rate | >90% when RAG has hits | same |
| Silent skip without log line | 0 for doctrine/memory | same |
| Time-to-first-useful-answer (`!ask`) | <15s warm LAN 12B | same + sources shown in UI |
| Operator “why did it do that?” | status + logs | dashboard turn trace |
| Rewrite of bot language | not started | not started |

---

## 8. Decision log

| Date | Decision |
|------|----------|
| 2026-07 | TS spine + sidecars affirmed; no Python/Rust full rewrite |
| 2026-07 | Vue retained for near-term dashboard work |
| 2026-07 | Radio/doctrine/TTS arc on `dev`/`master` (profiles, seeds, station ID, timezones, cori-medium, Gemma reasoning salvage) |
| 2026-07 | Feature roadmap: Station default, Harness progressive; extract brain only on pain |

---

## 9. Related docs

| Doc | Role |
|-----|------|
| [ROADMAP.md](../ROADMAP.md) | Phase history 0–9 |
| [DESIGN.md](../DESIGN.md) | Architecture principles |
| [docs/radio.md](./radio.md) | Radio / bumpers / profiles |
| [docs/voice.md](./voice.md) · [voice-backends.md](./voice-backends.md) | Voice loop |
| [docs/memory.md](./memory.md) | Memory / MemPalace |
| [docs/rank-gating.md](./rank-gating.md) | Rights |
| [docs/editions.md](./editions.md) | SBC vs Server |
| [docs/BUILD.md](./BUILD.md) | Near-term build queue |

---

*Ship the station. Grow the harness. Don’t rewrite the spine.*
