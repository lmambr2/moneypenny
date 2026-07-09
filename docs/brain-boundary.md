# Brain service boundary (`POST /v1/turn`)

> Plan-only contract for a future FastAPI “brain” (docs/feature-roadmap.md §5).
> **Not implemented.** The TypeScript bot remains the TeamSpeak + music authority
> and the **executor** of tool proposals. Extract only when pain criteria hit.

**Status:** sketched 2026-07-09 · implement when ≥2 extract criteria true  
**Related:** [feature-roadmap.md](./feature-roadmap.md) §5, [DESIGN.md](../DESIGN.md)

---

## 1. Ownership

| Responsibility | Today | After extract |
|----------------|-------|----------------|
| TS6 events, music/queue/player, radio director | **Bot** | **Bot** (always) |
| Rights / rank gates on live commands | **Bot** | **Bot** |
| Tool *execution* against live queue/player | **Bot** | **Bot** (disposes) |
| Multi-step plan / RAG pack / rewrite orchestration | Bot (`LlmModule`) | **Brain** candidate |
| Voice turn sequencing (STT→intent→TTS) | Bot + sidecars | **Brain** candidate if messy |

**Rule:** brain *proposes* tools; bot *disposes* (executes or refuses). Music
transport never waits on the brain for fail-open paths.

---

## 2. Extract when (two or more)

1. Voice turn pipeline needs retries, barge-in, multi-step tools beyond ControlRouter comfort  
2. RAG eval / re-rank / multi-query becomes a pipeline iterated weekly  
3. Multiple clients (TS + web + future) need the **same** agent loop  

Until then: keep orchestration in-process; thin TS adapters so a brain is a URL swap.

---

## 3. OpenAPI-ish contract

### `POST /v1/turn`

One conversational turn. Idempotent enough for retries with the same `clientTurnId`.

#### Request

```json
{
  "clientTurnId": "uuid-or-dashboard-id",
  "channel": "dashboard" | "teamspeak" | "voice",
  "text": "user utterance or transcript",
  "conversationId": "optional stable thread id",
  "subject": {
    "uid": "optional invoker uid",
    "serverGroups": ["optional", "sg-ids"],
    "allowedClassifications": ["unclassified", "restricted"]
  },
  "mode": "ask" | "intent" | "delegate",
  "options": {
    "includeSources": true,
    "maxTools": 4
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `text` | yes | User text or STT transcript |
| `channel` | yes | For logging / policy only |
| `mode` | no | Default `ask` (no tools). `intent` may return tool proposals |
| `subject.allowedClassifications` | no | Rank gate for RAG; bot may re-check on execute |
| `clientTurnId` | recommended | Dedup / dashboard correlation |

#### Response `200`

```json
{
  "turnId": "brain-side-id",
  "clientTurnId": "echo",
  "replyText": "spoken or chat reply (no tool side-effects applied)",
  "sources": [
    {
      "source": "combat-doctrine.md",
      "text": "optional snippet",
      "classification": "restricted",
      "score": 0.91
    }
  ],
  "toolProposals": [
    {
      "name": "play_music",
      "arguments": { "query": "ambient" },
      "reason": "optional"
    }
  ],
  "error": null
}
```

| Field | Notes |
|-------|-------|
| `replyText` | Always safe to show; may be empty if only tools proposed |
| `sources` | RAG / KG citations; include `classification` when known |
| `toolProposals` | **Not executed.** Bot maps name→command, re-checks rights, executes |
| `error` | Soft failure string; HTTP still 200 when partial answer exists |

#### Errors

| HTTP | When |
|------|------|
| `400` | Missing `text` / invalid body |
| `503` | Brain or upstream LLM unavailable — bot shows fail-open copy |
| `504` | Upstream timeout |

On `503`/`504` the bot must **not** block music; dashboard shows the error on the turn.

---

## 4. Bot adapter sketch (not shipped)

```
dashboard/TS  →  bot.runHarnessTurn / ControlRouter
                      │
                      ├─ today: in-process LlmModule + RetrievalStore
                      └─ future: HTTP POST {brainUrl}/v1/turn
                              ← replyText + sources + toolProposals
                      │
                      └─ bot executes toolProposals via existing CommandExecutor
```

Preferred TS shape: one function `completeTurn(req) → TurnResult` with injectable
transport (`InProcessBrain` | `HttpBrain`). Harness panel already consumes the
in-process result shape (`HarnessTurn`).

---

## 5. Non-goals

- Replacing TeamSpeak client, player, or radio director with Python  
- Cloud-default LLM  
- Brain enforcing rights (bot re-checks every proposal)  
- Streaming SSE (nice-to-have later; not required for extract)

---

## 6. Alignment with harness cockpit

The admin **Harness** panel (`/harness`, `POST /api/bot/harness/ask`) is the
product surface for the same turn record: user, reply, sources (+ classification),
tools (name/args/ok), errors. When a brain is extracted, that API becomes a thin
proxy to `POST /v1/turn` plus local tool disposal.
