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

### S-OC1 — Speech barge-in queue — **shipped** (soft v1)

| | |
|--|--|
| **Their idea** | Serial TTS `PlaybackQueue` + `interrupt()` when inbound voice arrives |
| **Us now** | `SpeechQueue` + `ttsPlaybackActive`; speech peak → interrupt TTS only; music continues under duck/savedMusic rules |
| **Homes** | `voice/speech-queue.ts`, `VoiceSession.createOutput`, Settings `ttsBargeIn` |

### S-OC3 — Event-driven reconnect + backoff — **shipped**

| | |
|--|--|
| **Their idea** | On disconnect / connect fail: exp backoff `2s → 60s` inside the client manager |
| **Us now** | `ReconnectScheduler` + remote `disconnected` on autoStart bots; intentional stop skips; watchdog skips `isReconnecting` |
| **Homes** | `bot/src/bot/reconnect-scheduler.ts`, `manager.ts`, `watchdog.ts`, `config.reconnect` |

### S-OC2 — Transport self-heal (narrow) — **shipped**

| | |
|--|--|
| **Their idea** | N voice errors in a window → full client restart |
| **Us now** | `VoiceTransportHealth` on `sendVoice` throw (5/30s) → `voiceTransportUnhealthy` → same event reconnect as S-OC3 |
| **Narrow hard** | Decode/DTX not counted — only send failures |
| **Homes** | `ts-protocol/voice-transport-health.ts`, `client.sendVoiceData`, `manager` listener |

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
