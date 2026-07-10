# Steal notes — HoneyBBQ openclaw-teamspeak

> **Source:** [HoneyBBQ/openclaw-teamspeak](https://github.com/HoneyBBQ/openclaw-teamspeak)  
> **Stance:** Patterns only — not a dep, not an OpenClaw host.  
> **Filter:** Keep only gaps that would **actually improve** us. If we already match or beat their architecture, the option is **dumped**.

OpenClaw’s plugin is “TS as an LLM chat surface.” We are a DJ/org bot on the same
`@honeybbq/teamspeak-client`. Most of their voice/agent glue is either irrelevant
or weaker than what we already ship.

**Related:** [feature-roadmap.md](./feature-roadmap.md) · [voice.md](./voice.md) · [brain-boundary.md](./brain-boundary.md)

---

## Keep (3)

### S-OC1 — Speech barge-in queue

| | |
|--|--|
| **Their idea** | Serial TTS `PlaybackQueue` + `interrupt()` when inbound voice arrives |
| **Us today** | Duck / `savedMusic` so the bot can speak **over music**; TTS uses `AudioPlayer` with **no** abort when a member starts talking |
| **Why keep** | Real UX gap: cannot cancel **bot speech** mid-utterance |
| **Constraint** | Speech lane only — never default barge-in on program music (codec 5 radio) |
| **Homes** | New speech-queue helper; `VoiceSession` / `VoiceOutput` (+ optional radio speech); Settings `voice.ttsBargeIn` |
| **Accept** | User talks during a voice ack → ack stops; music continues or stays under existing duck rules; radio bumper can opt out of barge-in |

### S-OC3 — Event-driven reconnect + backoff

| | |
|--|--|
| **Their idea** | On disconnect / connect fail: exp backoff `2s → 60s` inside the client manager |
| **Us today** | `TS3Client` emits `disconnected` only; **Watchdog** polls ~30s with **60s** per-bot cooldown (`bot/src/watchdog.ts`) |
| **Why keep** | Worse MTTR: we can sit offline until the next poll + cooldown |
| **Homes** | Single-flight reconnect with backoff on `BotInstance` / client path; watchdog remains a safety net (skip or soft-pedal while reconnect already in flight) |
| **Accept** | Unexpected drop recovers in seconds on first try, backs off on flap; watchdog still catches stuck cases |

### S-OC2 — Transport self-heal (narrow)

| | |
|--|--|
| **Their idea** | N voice errors in a window → full client restart |
| **Us today** | Decode-failure **counters for logs** only (`VoiceSession`) — no recovery action |
| **Why keep** | Rare “connected but voice path wedged” on Pi |
| **Narrow hard** | **Do not** reconnect on ordinary Opus decode fails, DTX, or one bad speaker (thrashing would make us worse). Count only **transport/session** failures: `sendVoice` throws, library voice pipeline errors, or total decode collapse across many speakers |
| **Homes** | Threshold + single-flight near client / `bot.reconnect()`, not in the STT packet hot path |
| **Accept** | Synthetic transport error storm → one reconnect; single bad packet → no reconnect |

---

## Dump (already better or already covered)

| Was | Why dump |
|-----|----------|
| **S-OC4** identity file | **Done:** SQLite `BotManager.persistBotIdentity` — same UID / server groups across restarts |
| **S-OC5** speaker TTL + `getClientInfo` | **Done better:** `clientInfoCache` + idle poller + `resolveSubject` (rights must not trust stale clid→groups) |
| **S-OC6** global STT serial queue | **Done better:** per-clid `streamChains`, turn gen, play-in-flight, passive KWS cap — global single queue hurts multi-speaker |
| **S-OC7** `replyMode` text/voice/both | Cosmetic; short voice acks vs long text already via `shouldSpeakVoiceReply` |
| **S-OC8** Opus `VoiceBuffer` + Ogg file STT | **Done better:** stream PCM STT + under-music gates + `SilenceSegmenter`; batch Ogg is a Pi downgrade |
| **S-OC9** dm/group/mention policy schema | Rank-gating + watchword is stronger; no Settings pain driving a schema rewrite |
| **Poke → synthetic DM** | **Done:** `PokeHandler` + `conversationId: poke:<uid>` |
| **OpenClaw host / envelopes / session store** | Our harness + `conversationId` surfaces + rights re-check + brain-boundary already own this; dual-host would fight the spine |
| **Pure-JS Opus music path** | Radio needs PCM bus + native encode (filters, duck, Icecast) |

---

## Implementation order (if ever scheduled)

1. **S-OC3** — reliability, small surface  
2. **S-OC2** — narrow transport self-heal  
3. **S-OC1** — speech barge-in (careful radio tests)

Not scheduled by default. Do **not** install OpenClaw or dual-bot.

---

## Decision log

| Date | Decision |
|------|----------|
| 2026-07-09 | Evaluated openclaw-teamspeak: patterns only |
| 2026-07-09 | Expanded map written, then **pruned**: keep S-OC1 / S-OC2 (narrow) / S-OC3 only; dump identity, speaker cache, global STT queue, VoiceBuffer, replyMode, trigger schema, harness host, pure-JS Opus |
|
