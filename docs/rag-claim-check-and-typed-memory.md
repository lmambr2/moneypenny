# Design: five RAG / memory / intent upgrades (from 2026 research scan)

> **Plan only — not implemented.** Five shippable ideas from recent agent-memory,
> self-correcting RAG, and edge-agent research (2026 X + arXiv), mapped onto
> Moneypenny’s spine. Implement only when quality or ops pain is real.
>
> **Status:** foundations **implemented** 2026-07-09 (flags default **off** except P2 budgets/dedup always on for ask history) · expand when pain  

> **Related:** [memory.md](./memory.md) · [feature-roadmap.md](./feature-roadmap.md) R3/H2 ·
> [brain-boundary.md](./brain-boundary.md) · [voice.md](./voice.md) · [DESIGN.md](../DESIGN.md)

## 0. Why this exists

We already have hybrid memory (Qdrant doctrine, org KG, conversation history, harness
turns) and deterministic-first routing. Research that fits **us** (not agentic RL
theater):

| # | Idea | Research anchor | Pain it targets |
|---|------|-----------------|-----------------|
| **P1** | Claim-check RAG | CheckRLM-style mid-chain claim verify + localized re-retrieve ([2607.02262](https://arxiv.org/abs/2607.02262)) | Unsupported facts in `!ask` / harness |
| **P2** | Typed memory budgets + injection dedup | Agent-native memory taxonomy ([2606.24775](https://arxiv.org/abs/2606.24775)); AgenticSTS / MemGPT-style context assembly | Context bloat, re-pasting the same notes |
| **P3** | Procedural playbooks | DuoMem *idea* — short high-quality procedures for small models ([2606.29961](https://arxiv.org/abs/2606.29961)); no LoRA required for v1 | Pi/small model flaky tool use |
| **P4** | Clarify-once | DiscoBench — when search/agents should ask ([HF daily / arXiv trend](https://arxiv.org/abs/2607.02255) family) | Wrong tool / wrong search under ambiguity |
| **P5** | Memory eval axes (R3) | Same taxonomy paper: measure modules, not only end-to-end F1 | Blind RAG/memory changes |

**Non-goals:** agentic RL training, multi-agent LatentMAS, OpenClaw host, one true
“memory product,” blocking music/TTS on LLM failure, LoRA distillation pipelines.

**Surfaces in scope:** harness ask, `!ask` / fuzzy intent Q&A, doctrine-backed packs.  
**Out of scope for these five:** radio fail-open play path, deterministic `!play` /
skip / vol, alone-stop, pure transport.

**Shared rules (all five):**

1. **Bot disposes** tools and rights; no trust of model-only “I remembered / I’m sure.”  
2. **Fail-open** — timeout or error → best previous result; never stall the player.  
3. **Flags default off** until acceptance + optional R3 metrics are green.  
4. **Same subject clearance** for any extra retrieve or memory read as the original turn.

---

## Priority map

| Pri | ID | Effort | Depends on | Product surface |
|-----|-----|--------|------------|-----------------|
| 1 | **P1** Claim-check | S–M | Existing retrieve + harness | Harness, `!ask` |
| 2 | **P2** Typed budgets + dedup | S | Harness / LLM history pack | All LLM turns |
| 3 | **P3** Playbooks | M | P2 budgets (playbook type) | Small-model intent / ask |
| 4 | **P4** Clarify-once | S | Intent confidence or score gap | Voice + text fuzzy path |
| 5 | **P5** Memory eval axes | S | R3 eval-loop | CI / admin eval API |

Suggested build order if scheduled: **P2 → P5 (metrics skeleton) → P1 → P4 → P3**.

---

## P1 — Claim-check RAG

### Problem today

```
retrieve(chunks) → pack context → LLM draft → return text + sources
```

Hallucinations slip through when retrieval is near-miss, multi-hop stitching fails, or
the model invents numbers/groups not in the pack. Harness shows sources (H2) but does
not **verify** the draft against them.

### Target pipeline (fail-open)

```
  user question
       │
       ▼
  retrieve₁  →  draft  →  extract claims  →  score vs sources
       │                         │
       │                    missing/weak?
       │                         │
       │                         ▼
       │                   retrieve₂ (per claim, capped)
       │                         │
       │                         ▼
       │                   optional revise
       │                         │
       └─────────────────────────┴──► answer + merged sources + flags
                    on any failure ──► best draft so far
```

### Module sketch

| Piece | Owner | Notes |
|-------|--------|------|
| `extractClaims(draft) → string[]` | LLM or heuristic | Atomic facts; cap N (e.g. 5) |
| `scoreSupport(claim, sources)` | Overlap / embed first | `supported \| weak \| missing` |
| `retrieveForClaim(claim, subject)` | Existing retrieval store | Same classification floor |
| `revise(draft, newChunks)` | LLM | One pass; fail → keep draft₁ |
| Turn flags | Harness | `claimCheck: { ran, fixedClaims, unsupported[], timedOut }` |

### Config (suggested)

```json
{
  "rag": {
    "claimCheck": {
      "enabled": false,
      "maxClaims": 5,
      "maxExtraRetrieves": 3,
      "revise": true,
      "timeoutMs": 4000,
      "surfaces": ["harness", "ask"]
    }
  }
}
```

### Rights / fail-open

- Extra retrieval uses the **same** subject clearance as the original turn.  
- Soft deadline; on timeout return draft₁ + `timedOut`.  
- Skip for short voice **acks** (`Paused.`, `Skipped.`) — only full Q&A answers.  
- No write tools in this path.

### Acceptance

1. Fixture: wrong dock/name in draft → re-retrieve + revise fixes or marks unsupported.  
2. RAG offline: no throw; `ran === false` or timed out.  
3. Harness shows sources from retrieve₁ and retrieve₂ when fixed.  
4. P5 metrics: unsupported claim rate, fix rate (optional).

### Homes

| Area | Role |
|------|------|
| `bot/src/rag/claim-check.ts` (new) | Pure pipeline |
| `bot/src/harness/run-turn.ts` | Post-answer pass |
| `bot/src/llm/` ask | Shared helper |
| Settings / config | Flag |
| `bot/src/rag/eval-loop.ts` | Metrics (P5) |

---

## P2 — Typed memory budgets + injection dedup

### Problem today

Context assembly is implicit: history + ad-hoc RAG + system prompt.

- Append-all history dilutes attention.  
- Same doctrine/org note re-injected every turn.  
- No explicit budgets per **type**.

### Types and budgets

| Type | Source today | Default budget | Write path |
|------|--------------|----------------|------------|
| `working` | Last user/assistant turns | ~6 turns or 1–2k tok | automatic |
| `doctrine` | Qdrant | existing pack caps | ingest / reindex |
| `org_kg` | MemPalace / SQLite | ~4 hits | `!kg` / org-kg API |
| `user_private` | memory scopes | small; never radio | memory tools + scopes |
| `last_tools` | tool name/result summary | ~3 | harness / router |
| `playbook` | P3 store | ~2 (when P3 on) | P3 capture |
| `injection_log` | session meta | n/a | harness |

**Rule:** prompt = sum of typed slices with hard caps; drop lowest-priority overflow.

### Do not re-inject the same note

```ts
// conceptual
type InjectionLog = Set<string>; // "doctrine:chunk-id", "org:entity-key", …

function selectWithDedup(
  candidates: { id: string; type: MemoryType; text: string; score: number }[],
  log: InjectionLog,
  budget: number,
): { selected: typeof candidates; log: InjectionLog }
```

- Prefer new high-score items over re-sending the same id.  
- Clear type-specific or full log on explicit “look that up again” / strong topic shift.

### Harness hooks (write path)

| Event | Capture | Recall |
|-------|---------|--------|
| Tool success (org) | Rights → org_kg if allowed | Typed retrieve next ask |
| Tool success (ops) | P3 playbook row | P3 retrieve |
| Long history | Summarize working once | Inject summary once |
| Turn end | Record injected ids | Skip those ids next turn |

**Never:** model-only “I’ll remember this” without a tool + rights.

### Config (suggested)

```json
{
  "memory": {
    "budgets": {
      "workingTurns": 6,
      "doctrineChunks": 6,
      "orgKgHits": 4,
      "playbooks": 2,
      "lastTools": 3
    },
    "dedupeInjections": true
  }
}
```

### Acceptance

1. Second identical harness ask does not double the same doctrine chunk (log proves skip).  
2. Over-budget history truncates without crash.  
3. Private memory never in radio/public packs (existing isolation + tests).  
4. P5: injection dedup rate metric.

### Homes

| Area | Role |
|------|------|
| `bot/src/llm/` history | Working-window caps |
| `bot/src/harness/run-turn.ts` | Injection log + pack assembly |
| Shared `assembleTurnContext()` | One helper for harness + ask |
| Tests | Dedup + budget units |

---

## P3 — Procedural playbook store

### Problem today

Small models (Pi / NPU) often know *what* the user said but not *how we do it here*
(tool order, duck then pause, rank gate before mute). DuoMem shows edge models jump
when given **teacher procedural memories** — we take the **retrieval** half only, not
distillation training.

### Target

```
  successful harness / router tool trajectory
           │
           ▼
  playbook row (hints + tools + outcome)   ← capture, rights-safe
           │
           ▼
  at ask/intent: embed/hint match top-k
           │
           ▼
  prepend “how we do this” into typed budget (P2 type playbook)
```

### Schema (sketch)

```json
{
  "id": "pb-radio-duck-pause",
  "triggerHints": ["pause music", "voice under music", "moneypenny pause"],
  "steps": ["duck music", "route voice command", "short TTS ack"],
  "tools": ["playback.pause"],
  "outcome": "ok",
  "classification": "unclassified",
  "createdAt": 0
}
```

### Capture rules

- Only **successful** tool dispositions (ok, not denied/failed).  
- Strip secrets (tokens, passwords, private memory text).  
- Cap store size (e.g. last N or LRU); admin can disable capture.  
- Never capture pure transport spam every skip unless deduped by template.

### Retrieve rules

- Top-k by hint/embedding similarity to user text / intent.  
- Subject clearance: playbooks are **ops-unclassified** only unless tagged higher.  
- Respect P2 budget `playbooks: 2`.  
- Off by default (`playbooksEnabled: false`).

### Config (suggested)

```json
{
  "memory": {
    "playbooksEnabled": false,
    "playbookCapture": false,
    "playbookMaxStore": 200,
    "budgets": { "playbooks": 2 }
  }
}
```

### Acceptance

1. After a successful “pause under voice” pattern is captured, a similar phrasing retrieves that playbook into the pack.  
2. Failed/denied tools never become playbooks.  
3. Secrets never appear in stored steps.  
4. With flag off, zero capture and zero retrieve.

### Homes

| Area | Role |
|------|------|
| `bot/src/memory/playbooks.ts` (new) | Store + retrieve |
| Harness / router after tool ok | Capture hook |
| `assembleTurnContext` | Budgeted inject |
| SQLite or JSON under `bot/data/` | Persistence |

### Explicit non-goal

Train LoRA / DuoMem dual-space distillation. If playbooks help, stop there.

---

## P4 — Clarify-once (ambiguous intent / search)

### Problem today

Fuzzy intent and open `!ask` sometimes pick a tool or retrieval query when the utterance
is under-specified (“fleet”, “status”, “that track”, multi-intent mush). DiscoBench-class
work asks: **when should the agent ask a clarifying question instead of acting?**

Wrong action under voice is costly (music skip, mute, wrong play).

### Target policy

```
  transcript / text
       │
       ▼
  confidence / score gap / multi-intent detect
       │
       ├─ high confidence ──► existing route (tools / ask)
       │
       └─ low / ambiguous ──► ONE clarifying question
                              (text and/or short TTS)
                              then wait for reply (armed window on voice)
                              ──► route with filled slots
```

### Triggers (examples — tune empirically)

| Signal | Example |
|--------|---------|
| Top-2 intent scores within ε | `play` vs `queue` both high |
| Retrieval score flat / empty | Doctrine ask with no chunk above threshold |
| Missing required slot | `!ops` style without subcommand; “play” with no query |
| Conflicting entities | Two ships/members equally matched |

### Non-triggers (do not clarify)

- Deterministic commands with full parse (`!skip`, `!vol 40`).  
- Watchword-only arm (already a listen window).  
- Second clarification in the same turn chain (**clarify-once** hard limit).  
- After user already answered the clarifier (route; don’t loop).

### Delivery

| Surface | Behavior |
|---------|----------|
| Text / harness | Short question reply; no tools yet |
| Voice | Short TTS; keep duck/arm window; do not claim play-in-flight |
| Radio program | N/A — never pause music solely to clarify Q&A |

### Config (suggested)

```json
{
  "intent": {
    "clarifyOnce": {
      "enabled": false,
      "minScoreGap": 0.08,
      "surfaces": ["voice", "chat", "harness"],
      "maxClarifyPerTurn": 1
    }
  }
}
```

### Acceptance

1. Ambiguous “status” with two tools → one clarifier, zero tools until answer.  
2. Clear `!skip` → no clarifier.  
3. After one clarify + user answer → tool runs; no second clarify.  
4. Fail-open: if clarifier TTS fails, fall back to text or best-effort route with log.

### Homes

| Area | Role |
|------|------|
| `bot/src/control/router.ts` | Ambiguity gate before execute |
| Voice pipeline | Arm window after clarifier |
| Harness | Same gate for intent mode |
| Tests | Ambiguous vs clear fixtures |

---

## P5 — Memory / RAG eval axes (R3 extension)

### Problem today

R3 eval-loop and hygiene endpoints catch empty rewrites and corpus health, but agent-memory
research shows **end-to-end F1 alone** hides which module failed: storage, extraction,
retrieval/routing, or maintenance.

### Axes to measure

| Axis | Question | How (sketch) |
|------|----------|--------------|
| **Retrieval precision** | Did top-k include the gold chunk? | Fixed Q/A + labeled sources |
| **Unsupported claims** | Did draft invent facts? | P1 claim extract vs sources |
| **Claim fix rate** | Did retrieve₂ help? | P1 before/after |
| **Update correctness** | After doctrine change, is old answer gone? | Reindex then re-ask fixture |
| **Stale injection** | Do we re-serve retracted content? | Delete/replace chunk fixture |
| **Injection dedup** | Are we wasting budget? | P2 log rate |
| **Latency p95** | Claim-check / clarify cost | Harness dry-run timings |
| **Playbook hit usefulness** | Did playbook change tool success? | Optional A/B later |

### Surfaces

| Surface | Notes |
|---------|--------|
| `eval-loop.ts` / `POST /api/bot/rag/eval` | Optional suites; skip if RAG off |
| CI | Lightweight fixtures only; no live Qdrant required for unit stubs |
| Admin | Hygiene page can show last eval summary (optional) |

### Config (suggested)

```json
{
  "rag": {
    "eval": {
      "claimCheckSuite": false,
      "memoryAxesSuite": false
    }
  }
}
```

### Acceptance

1. Documented metrics in eval output JSON when suite enabled.  
2. CI remains green with RAG off (suites no-op or stub).  
3. At least one fixture each for retrieval miss, unsupported claim, and update-after-reindex (when suite on).  
4. No production path depends on eval passing mid-request.

### Homes

| Area | Role |
|------|------|
| `bot/src/rag/eval-loop.ts` | New metric collectors |
| `scripts/rag-eval.mjs` | CLI flags for suites |
| Docs | This file + R3 notes in roadmap |

---

## Shared config sketch (all flags)

```json
{
  "rag": {
    "claimCheck": { "enabled": false, "maxClaims": 5, "maxExtraRetrieves": 3, "revise": true, "timeoutMs": 4000, "surfaces": ["harness", "ask"] },
    "eval": { "claimCheckSuite": false, "memoryAxesSuite": false }
  },
  "memory": {
    "budgets": {
      "workingTurns": 6,
      "doctrineChunks": 6,
      "orgKgHits": 4,
      "playbooks": 2,
      "lastTools": 3
    },
    "dedupeInjections": true,
    "playbooksEnabled": false,
    "playbookCapture": false,
    "playbookMaxStore": 200
  },
  "intent": {
    "clarifyOnce": {
      "enabled": false,
      "minScoreGap": 0.08,
      "surfaces": ["voice", "chat", "harness"],
      "maxClarifyPerTurn": 1
    }
  }
}
```

---

## Implementation order (if scheduled)

1. **P2** — budgets + injection log (no extra LLM).  
2. **P5** — metric hooks/stubs so later P1/P4 can report.  
3. **P1** — claim-check (flag off).  
4. **P4** — clarify-once (flag off).  
5. **P3** — playbook capture/retrieve (flag off).  
6. Wire shared helpers into chat `!ask` once harness is proven.

Still in-process; brain extract only if RAG/memory orchestration becomes weekly thrash
([brain-boundary.md](./brain-boundary.md) criterion #2).

---

## Explicit non-implementations

| Idea | Why not |
|------|---------|
| DuoMem LoRA / dual-space distillation | Ops cost; P3 retrieval is enough |
| Global “agent memory product” | Taxonomy: hybrid modules win |
| Claim-check on every voice ack | Latency; Q&A only |
| Multi-agent claim jurors | One check pass |
| Infinite clarify loops | **Clarify-once** hard cap |
| Agentic RL post-training | Out of product scope |
| Claim-check or clarify on music transport | Fail-open station |

---

## Decision log

| Date | Decision |
|------|----------|
| 2026-07-09 | Capture P1–P2 as design from X/arXiv memory+RAG scan |
| 2026-07-09 | Expand to **all five**: P1 claim-check, P2 typed budgets, P3 playbooks, P4 clarify-once, P5 memory eval axes |
| 2026-07-09 | All flags default **off**; music fail-open unchanged; implement only on real pain |
|
