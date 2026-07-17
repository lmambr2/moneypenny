# Brain service boundary (`POST /v1/turn`)

> Contract for conversational turns: brain *proposes*, bot *disposes*.
> Phase D ships the TS adapter + in-process/HTTP transport. External FastAPI
> brains remain optional.

**Status:** implemented 2026-07-16 (Phase D) — in-process default; `BRAIN_URL` optional  
**Related:** [feature-roadmap.md](./feature-roadmap.md) §5, [DESIGN.md](../DESIGN.md),
[http-openapi.md](./http-openapi.md)

---

## 1. Ownership

| Responsibility | Owner |
|----------------|-------|
| TS6 events, music/queue/player, radio director | **Bot** (always) |
| Rights / rank gates on live commands | **Bot** |
| Tool *execution* against live queue/player | **Bot** (disposes) |
| RAG pack + LLM ask / intent proposals | **Brain** transport (in-process or remote) |

**Rule:** brain *proposes* tools; bot *disposes* (executes or refuses). Music
transport never waits on the brain for fail-open paths (`!skip` / player).

---

## 2. Code map

| Path | Role |
|------|------|
| `bot/src/brain/` | Types, `completeTurn`, `InProcessBrain`, `HttpBrain`, `disposeToolProposals` |
| `bot/src/harness/run-turn.ts` | Dashboard harness: brain → dispose → `HarnessTurn` |
| `POST /v1/turn` | Admin session API (`http/plugins/brain-turn.ts`) |
| `BRAIN_URL` | Env — empty = in-process; else `POST {BRAIN_URL}/v1/turn` |

```
dashboard/TS  →  bot.runHarnessTurn / POST /v1/turn
                      │
                      ├─ BRAIN_URL empty: InProcessBrain (LlmModule + RAG)
                      └─ BRAIN_URL set:   HttpBrain → remote /v1/turn
                      │
                      └─ bot disposeToolProposals → CommandExecutor (rights)
```

---

## 3. Contract

### `POST /v1/turn` (on bot — admin cookie)

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
  },
  "executeTools": false,
  "dryRun": false
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `text` | yes | User text or STT transcript |
| `channel` | no | Default `dashboard` |
| `mode` | no | Default `ask`. `intent` may return tool proposals |
| `executeTools` | no | If true, bot disposes proposals (harness-like) |
| `dryRun` | no | With executeTools — policy dry-run only |

#### Response `200`

```json
{
  "turnId": "brain-side-id",
  "clientTurnId": "echo",
  "replyText": "spoken or chat reply (no tool side-effects by default)",
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
| `sources` | RAG / KG citations |
| `toolProposals` | **Not executed** unless `executeTools: true` |
| `error` | Soft failure string; partial answers may still include reply |

#### Errors

| HTTP | When |
|------|------|
| `400` | Missing `text` |
| `401`/`403` | Not admin session |
| `409` | No bot / LLM disabled |
| `503` | Hard failure path (logged) |

Harness / soft transport failures return `error` on the turn body without
killing music.

---

## 4. Remote brain

```bash
# .env
BRAIN_URL=http://brain:8090
```

Remote must implement the same JSON request/response. Bot still disposes tools
when the client asks (harness always disposes; `/v1/turn` only if `executeTools`).

---

## 5. Non-goals

- Replacing TeamSpeak client, player, or radio director with Python  
- Cloud-default LLM  
- Brain enforcing rights (bot re-checks every proposal)  
- Streaming SSE (nice-to-have later)  
- Nest / LangGraph inside the station process  

---

## 6. Harness cockpit

Admin **Harness** (`/harness`, `POST /api/bot/harness/ask`) uses the same
`completeTurn` + dispose path. Sources, tools, errors remain the dashboard shape
(`HarnessTurn`).
