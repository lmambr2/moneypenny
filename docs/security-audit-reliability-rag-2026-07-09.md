# Security audit & bug hunt — reliability + RAG/memory/intent (2026-07-09)

**Scope:** Commits **`41ce015`** (S-OC1–3 reliability) and **`03c38fd`** (P1–P5 RAG/memory/intent), plus call-sites required to understand wiring (`manager`, `instance`, `router`, `llm`, `config`, Settings).

**Method:** Diff inventory; static review of reconnect, transport health, barge-in, claim-check, turn-context, playbooks, clarify, config defaults; unit suite evidence (see §6).

**Non-goals:** Whole-repo re-audit (economy/web/ACE); live TS/Pi soak; implementing every remediation (except one High reconnect race fixed in-audit).

**Evidence:** unit run log + static lint/tsc under implementer scratch (session); suites listed in §6.

---

## Executive summary

| | |
|--|--|
| **Critical** | **0** |
| **High** | **1** (fixed this pass: stop vs in-flight reconnect) |
| **Medium** | **4** |
| **Low / Info** | **6** |

**Posture:** Experimental RAG/intent flags default **off**; reconnect/barge-in are on by design. Fail-open music is preserved (claim-check/clarify do not gate the player). Main residual risk is **operator-enabled claim-check** (extra LLM/retrieve, soft timeout) and **quality** issues (injection dedup keys, shared-channel clarify).

**Fixed during audit:**

- **H-REL-1:** `stopBot` during in-flight reconnect could leave the bot online and re-assert `autoStart: true`. Generation tokens + `startBot({ fromReconnect })` + post-connect `autoStart` re-check.

---

## 1. Diff inventory (scope gate)

| Commit | Theme | Primary paths |
|--------|--------|----------------|
| `41ce015` | Reliability | `reconnect-scheduler.ts`, `manager.ts`, `instance.ts`, `event-bindings.ts`, `watchdog.ts`, `voice-transport-health.ts`, `client.sendVoiceData`, `speech-queue.ts`, `voice/session.ts` barge-in, `config.reconnect`, Settings barge-in |
| `03c38fd` | RAG/memory/intent | `turn-context.ts`, `claim-check.ts`, `playbooks.ts`, `clarify.ts`, `router` clarify gate, `llm/index` pack+claim-check, `eval-loop` axes, `config` flags, design docs |

**Out of scope:** economy UI, ACE-Step, full web auth surface (prior audits).

---

## 2. Security findings

### Critical

**None.**

### High

#### H-REL-1 — stopBot vs in-flight reconnect revived bot (fixed)

| | |
|--|--|
| **Severity** | High (availability / operator control) |
| **Location** | `ReconnectScheduler.cancel` + `BotManager.startBot` (pre-fix) |
| **Threat** | Operator stops bot while event reconnect is mid-`startBot`; old path forced `autoStart: true` after connect and left the bot online. |
| **Impact** | Undoes intentional stop; can rejoin TS after admin stop; thrash under flapping + stop. |
| **Remediation** | **Shipped in-audit:** cancel bumps generation (invalidates success/reschedule); reconnect uses `startBot({ fromReconnect: true })` and re-reads `autoStart` before/after connect; regression test `cancel during in-flight reconnect prevents retry-after-fail reschedule`. |

### Medium

#### M-RAG-1 — Claim-check revise prompt injection surface (when enabled)

| | |
|--|--|
| **Severity** | Medium (requires `ragClaimCheck.enabled`) |
| **Location** | `llm/index.ts` claim-check `revise` → `complete()` with draft + retrieved `extra` |
| **Threat** | Retrieved doctrine/memory text or model draft can contain instruction-like content; second LLM pass may amplify prompt injection vs single-shot ask. |
| **Impact** | Misleading answers, tool-adjacent confusion if content is later acted on; not direct RCE. |
| **Remediation** | Keep default off; delimit retrieved text; cap revise length; optional refuse-if-unsupported without revise; never enable on untrusted multi-tenant corpus without review. |

#### M-RAG-2 — Claim-check soft timeout does not cancel background work

| | |
|--|--|
| **Severity** | Medium (DoS / resource) when enabled |
| **Location** | `rag/claim-check.ts` `Promise.race` timeout |
| **Threat** | On timeout, ask returns original draft but `work()` may continue retrieve₂ + revise LLM. |
| **Impact** | Extra load on Ollama/Qdrant under load or slow models; not a music block (fail-open). |
| **Remediation** | AbortSignal through retrieve/revise; or drop revise on timeout path; rate-limit claim-check per conversation. **Note:** timer clear added; full cancel still residual. |

#### M-REL-2 — Transport self-heal can reconnect on pathological send storms

| | |
|--|--|
| **Severity** | Medium (self-DoS) |
| **Location** | `VoiceTransportHealth` 5 errors / 30s → reconnect |
| **Threat** | Broken but “throwing” sendVoice under load triggers reconnect loops (backoff limits thrash). |
| **Impact** | Brief music/voice outages while reconnecting. |
| **Mitigation present** | Latch until healthy streak; exp backoff; autoStart-only. |
| **Remediation** | Metric + alert; optional raise threshold via config; ensure sendVoice doesn’t throw on every frame for benign cases. |

#### M-CFG-1 — Nested config shallow-merge loses sibling defaults

| | |
|--|--|
| **Severity** | Medium (ops footgun) |
| **Location** | `loadConfig`: `{ ...defaults, ...partial }` |
| **Threat** | Partial `reconnect: { eventDriven: false }` drops `baseMs`/`maxMs` defaults (undefined → code fallbacks OK for reconnect; worse for deeper nests). |
| **Impact** | Unexpected flag combinations if Settings saves sparse objects. |
| **Remediation** | Deep-merge known nested keys (`reconnect`, `memoryContext`, `ragClaimCheck`, `voice`, `radio`). |

### Low

#### L-REL-1 — Barge-in stops player without emitting trackEnd

| | |
|--|--|
| **Severity** | Low (functional) |
| **Location** | `VoiceSession.createOutput` abort → `player.stop()` |
| **Impact** | `savedMusic` restore depends on `handleTrackEnd` path; if stop doesn’t emit `trackEnd`, music restore may delay until next event. Soft barge-in design accepts stop + separate restore via speech queue resolve. |
| **Remediation** | On barge-in abort, explicitly call the same restore helper as trackEnd when `savedMusic` set. |

#### L-RAG-3 — Injection dedup keys are `source:index`, not content-stable

| | |
|--|--|
| **Severity** | Low (quality) |
| **Location** | `llm/index.ts` doctrine id `` `${source}:${i}` `` |
| **Impact** | Follow-up asks may skip still-needed chunks (same source rank) or re-inject wrong slices after re-rank. |
| **Remediation** | Id by content hash / chunk id from Qdrant payload. |

#### L-RAG-4 — Unbounded `injectionLogs` Map growth

| | |
|--|--|
| **Severity** | Low (memory) |
| **Location** | `LlmModule.injectionLogs` |
| **Impact** | Many conversationIds over long uptime retain Sets forever. |
| **Remediation** | LRU / TTL per conversation; clear on `resetConversation`. |

#### L-PB-1 — Playbook `stripSecrets` is keyword-only

| | |
|--|--|
| **Severity** | Low (when capture is wired) |
| **Location** | `memory/playbooks.ts` `SECRETISH` |
| **Impact** | Tool args like bare secrets without keywords could be stored; currently **no production capture hook** ships (store only). |
| **Remediation** | Do not capture tool arguments; only tool names; path under `data/` not world-writable. |

#### L-CL-1 — Clarify-once pending is per conversationId, not per user

| | |
|--|--|
| **Severity** | Low (channel UX) |
| **Location** | `ControlRouter.clarifyPending` |
| **Impact** | Shared `channel` conversation: one clarify unlocks the next tool batch for anyone. |
| **Remediation** | Key by `conversationId + invokerUid`. |

### Info

| ID | Note |
|----|------|
| I-1 | Experimental flags default **off** (`ragClaimCheck`, `intentClarifyOnce`, playbooks). |
| I-2 | Self-echo filtered before barge-in (`clientId === bot`). |
| I-3 | Music path fail-open: claim-check/clarify never call `player` / director. |
| I-4 | Playbook inject/capture not fully wired into tool success path — reduced attack surface. |
| I-5 | Reconnect only for `autoStart` bots; intentional `disconnect()` sets `localDisconnect`. |

---

## 3. Functional findings (bugs)

| ID | Sev | Issue | Status |
|----|-----|--------|--------|
| H-REL-1 | High | stopBot mid-reconnect revived bot / autoStart | **Fixed** |
| F-REL-1 | Med | After barge-in `stop()`, music restore may not run if no trackEnd | Open (L-REL-1) |
| F-REL-2 | Low | `isSpeaking` false after interrupt clears abort before job finally (brief race) | Acceptable |
| F-RAG-1 | Low | Dedup can starve follow-up context | Open (L-RAG-3) |
| F-CL-1 | Low | Shared-channel clarify once | Open (L-CL-1) |
| F-CC-1 | Med | Timeout race leaves background work | Open (M-RAG-2) |

**Intentional vs remote disconnect:** Covered by `localDisconnect` + `consumeLocalDisconnect`; remote path via `bindTsEvents` does not set local flag. **OK.**

**Watchdog coordination:** Skips when `isReconnecting()`. **OK.**

**sendVoice latch:** Single fire until healthy streak / clearRecoveryLatch on connect. **OK.**

**Speech-queue abort vs trackEnd:** Abort stops player; job resolves; sequential TTS OK. Music restore residual L-REL-1.

**History budget:** `capWorkingTurns` keeps last N×2 messages. **OK.**

**Clarify single-shot:** Pending set then cleared on proceed; no infinite loop. **OK** (with L-CL-1 nuance).

---

## 4. Config defaults checklist

| Flag | Default | Assessment |
|------|---------|------------|
| `reconnect.eventDriven` | true | OK for product |
| `voice.ttsBargeIn` | true | OK; Settings toggle |
| `memoryContext.dedupeInjections` | true | OK |
| `ragClaimCheck.enabled` | false | OK |
| `intentClarifyOnce` | false | OK |
| playbooksEnabled / capture | false | OK |

---

## 5. Recommended fix order

1. ~~**H-REL-1** stop vs reconnect~~ **Done**  
2. **M-RAG-2** AbortSignal for claim-check when enabling in prod  
3. **L-REL-1** Explicit music restore on barge-in  
4. **L-RAG-3** Stable chunk ids for dedup  
5. **M-CFG-1** Deep-merge nested config  
6. **L-CL-1** Per-user clarify pending  

---

## 6. Test evidence

**Command (related suites):**

```text
npx vitest run \
  src/bot/reconnect-scheduler.test.ts \
  src/ts-protocol/voice-transport-health.test.ts \
  src/voice/speech-queue.test.ts \
  src/memory/turn-context.test.ts \
  src/memory/playbooks.test.ts \
  src/rag/claim-check.test.ts \
  src/control/clarify.test.ts \
  src/watchdog.test.ts \
  src/llm/index.test.ts \
  src/control/router.test.ts \
  src/rag/eval-loop.test.ts
```

**Result:** **11** files, **99** tests passed (includes new cancel-in-flight reconnect case).

**Static:** `tsc --noEmit` clean; `npm run lint` clean (Biome).

**Captured logs:** implementer scratch `audit-unit-tests.log`, `audit-static.log` (goal session).

---

## 7. Residual risks / not proven live

| Gap | Why |
|-----|-----|
| Live TS disconnect soak | No real server flap in this audit |
| Live barge-in under music | Unit only; needs channel smoke |
| Adversarial claim-check revise | No hostile corpus LLM run |
| Playbook capture in production | Store unit-tested; capture hook not fully product-wired |
| Reconnect + stopBot concurrent on Pi | Logic + unit; not chaos-tested on hardware |

---

## 8. Decision log

| Date | Decision |
|------|----------|
| 2026-07-09 | Audit reliability + RAG/memory commits; fix H-REL-1 only in-pass |
| 2026-07-09 | Experimental features remain default-off; document Medium risks for claim-check enablement |
|
