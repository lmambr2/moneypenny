# Intercom — listen-only voice delegate (design v1)

> Feature design doc. Continues `DESIGN.md` §10 (voice loop) and `docs/voice.md`.
> Style mirrors [`docs/radio.md`](./radio.md) and [`docs/rank-gating.md`](./rank-gating.md).

**Status:** design only — not implemented.
**Gating:** off by default; requires explicit pairing with a primary DJ bot.

---

## 1. Summary

Add an optional second TeamSpeak bot identity, **Intercom**, whose only job is
**inbound voice capture** (Opus decode → sherpa KWS/STT → `ControlRouter`). It does
not play music, does not run the radio director, and does not own the queue.
Recognized commands are **delegated** to the primary **Moneypenny** bot instance,
which executes playback, radio, and TTS replies.

The goal is to **decouple voice listening from music playback** so the DJ bot never
entangles duck state, `savedMusic`, or bumper speech with STT capture — and so
operators can optionally park Intercom in a **quiet command channel** where music
bleed cannot confuse wake-word detection.

Design rule (inherited): **one command router, one rights model.** Intercom is a
transport front-end, not a second brain. All rank gating and command execution still
flow through the same `ControlRouter` + primary `BotInstance`.

---

## 2. Problem statement

Voice commands today run inside the same `BotInstance` that plays music and radio
bumpers (`bot/src/bot/voice/session.ts`). The bot already filters its **own**
outbound audio from STT:

- Music and TTS replies use **codec 5** (Opus music) — dropped before STT.
- The bot's own **client id** on codec 4 — dropped as self-echo.

Remaining confusion sources are **not** fixed by codec filtering:

| Source | Same-channel Intercom | Command-channel Intercom |
|--------|----------------------|--------------------------|
| Music/TTS bleeding into a user's mic (speakers → mic) | No help | **Helps** |
| STT mishears ("money penny", "any pause") | No help | Partial (quieter room) |
| Duck / `savedMusic` entanglement during playback | **Helps** (DJ bot has no voice session) | **Helps** |
| Moneypenny TTS heard as another client's voice | Rare today; Intercom can ignore DJ client id | Same |
| Busy channel cross-talk | No help | Helps if users use command channel |

**Conclusion:** Intercom is worth building when the org wants **role separation**
(DJ vs listener) and/or a **dedicated command channel**. It is **not** a silver
bullet for acoustic bleed while everyone stays in the music channel with open mics.

---

## 3. Goals / Non-Goals

### Goals
- Second TS bot slot (`Intercom`) with voice enabled, playback disabled.
- Route parsed voice commands to a configured **primary bot** (`voiceDelegateTo`).
- Preserve rank gating: subject resolved from Intercom's view of the speaker
  (client id, uid, server groups).
- Share the existing `sherpa-stt` sidecar (one STT service, multiple TS sessions).
- Optional: Intercom posts TTS replies **through the primary bot** so spoken acks
  come from the DJ identity users expect.
- Filter inbound audio from the primary bot's client id on Intercom (ignore DJ
  TTS if it ever uses codec 4).

### Non-Goals
- Replacing ducking on a single-bot setup (volume duck remains the right fix there).
- Full acoustic echo cancellation (AEC) — out of scope.
- A second copy of the music stack, queue, or radio director on Intercom.
- Whisper / push-to-talk (could be a lighter follow-up on one bot).
- Separate LLM or rights engine per bot.

---

## 4. Architecture

```
  TeamSpeak channel(s)
        │
        ├─▶ Intercom bot (listen-only)
        │      Opus codec 4 in → VoiceSession (no AudioPlayer playback)
        │      KWS / STT → ControlRouter.routeVoice
        │      delegate execution ───────────────┐
        │                                         │
        └─▶ Moneypenny bot (primary / DJ) ◀────────┘
               AudioPlayer, queue, radio, TTS out (codec 5)
               executes pause / play / skip / !radio …
```

### Deployment patterns

**A — Same channel (minimal ops)**

- Both bots join the music channel.
- Intercom ignores Moneypenny's `clientId` on inbound voice.
- Moneypenny disables its own `VoiceSession` (`voice.listenerMode: "none"` or
  `voice.enabled` false on primary).
- Benefit: no channel switching for users. Limited benefit for mic bleed.

**B — Command channel (recommended for reliability)**

- Moneypenny in **Lobby** (music).
- Intercom in **Command** (quiet).
- Users switch channel (or stay in Command) to issue voice orders.
- Benefit: largest reduction in wake-word false triggers.

**C — Hybrid**

- Intercom in Command; `!follow` on primary still moves the DJ bot to operators.
- Document that voice commands require the Command channel.

---

## 5. Config shape (proposed)

Global `config.json` gains optional pairing:

```json
{
  "voice": {
    "enabled": true,
    "role": "delegate",
    "delegateToBotId": "<primary-uuid>",
    "ignoreClientIds": ["<primary-ts-client-id>"]
  }
}
```

Per `BotInstance` (SQLite `bot_instances`):

| Field | Primary (Moneypenny) | Intercom |
|-------|---------------------|----------|
| `voice.enabled` | `false` when paired | `true` |
| `voice.role` | `"primary"` (default) | `"delegate"` |
| `voice.delegateToBotId` | — | primary id |
| Playback / radio | on | off (enforced) |

Dashboard: Settings → Voice shows **role** and **paired bot** when multiple
instances exist.

---

## 6. Command delegation

When Intercom's `VoicePipeline` produces an actionable command:

1. Build `RouterContext` on Intercom (speaker subject from Intercom's client list).
2. Call `ControlRouter.routeVoice` on Intercom (rank check against speaker).
3. On `execute`, instead of local `BotInstance` handlers for playback/radio:
   - Resolve `delegateToBotId` → primary `BotInstance`.
   - Invoke `primary.executeRoutedCommand(decision, context)` (new internal API).
4. Playback replies (pause ack, etc.):
   - **Text:** post in channel via Intercom (or primary — TBD).
   - **Voice:** primary speaks via `VoiceSession.createOutput().speak()` (codec 5).

Commands that are **local to the listener** (e.g. `!follow` moving Intercom) stay
on Intercom. Commands that **mutate playback** always hit primary.

### Failure modes

| Failure | Behavior |
|---------|----------|
| Primary offline | Intercom replies "DJ bot offline"; no playback side effects. |
| STT down | Same degradation as today; Intercom logs + optional chat notice. |
| Delegate bot misconfigured | Intercom voice disabled at boot; admin warning in dashboard. |
| Both bots in same channel, primary voice still on | Dashboard warning: duplicate listeners. |

---

## 7. Codebase touch points

Already exists:

- `BotManager` — multiple `BotInstance`s, per-bot connect/disconnect.
- `VoiceSession` — full listen path; needs `role: delegate` short-circuit on playback.
- `ControlRouter` — single router per instance; delegation is an executor shim.

New / changed:

| Area | Work |
|------|------|
| `bot/src/bot/voice/delegate.ts` | Cross-instance command forwarder |
| `bot/src/bot/instance.ts` | `executeRoutedCommand` callable from manager |
| `bot/src/bot/manager.ts` | Registry `getPrimaryFor(delegateId)` |
| `bot/src/data/config.ts` | `voice.role`, `delegateToBotId` |
| `bot/src/web/api/bot.ts` | Stop assuming `getAllBots()[0]` for voice test |
| `bot/web/Settings.vue` | Pairing UI, role selector |
| `docs/voice.md` | Link here; fix 8s → 15s listen window note |

**Rough effort:** 1–2 weeks for v1 (delegate path, pairing config, dashboard, tests).
Ops: second TS query slot + identity file + channel placement doc.

---

## 8. Alternatives (cheaper first)

1. **Command channel, one bot** — move yourself to a quiet channel for voice; zero code.
2. **Custom watchword** — reduces lyric collisions.
3. **Push-to-talk keybind** — open armed window only while key held (~3–5 days).
4. **Ignore primary client id** — one-line guard if voice stays on primary.

Try (1)–(3) before committing to a permanent second bot.

---

## 9. Open questions

1. **TTS identity:** should spoken replies always come from Moneypenny even when
   Intercom heard the command?
2. **Chat replies:** Intercom nickname vs Moneypenny in channel text?
3. **Auto-follow:** should Intercom `!follow` track operators separately from DJ?
4. **TS license:** confirm org server allows two automated clients.
5. **Pi CPU:** two Opus decoders + one sherpa — acceptable on RK3588? (Likely yes.)

---

## 10. Acceptance criteria (v1)

- [ ] Two bot instances in dashboard; Intercom marked listen-only.
- [ ] Primary has voice off; Intercom has voice on.
- [ ] "Moneypenny, pause" in Command channel pauses music in Lobby.
- [ ] Rank gating identical to single-bot voice (deny still denies).
- [ ] Primary offline → graceful error, no crash.
- [ ] Unit tests for delegate routing; no regression in single-bot mode.

---

## 11. References

`DESIGN.md` §10 · `docs/voice.md` · `bot/src/bot/voice/session.ts` ·
`bot/src/bot/manager.ts` · `bot/src/control/router.ts` · `AGENTS.md` (voice duck notes).