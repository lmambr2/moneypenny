# Voice Loop — Phase 2

**Goal (DESIGN §10):** Inbound TeamSpeak audio → STT → the same control router as chat → optional TTS reply.

## Sidecars

| Service | Profile | URL (Docker) | Purpose |
|---------|---------|--------------|---------|
| `sherpa-stt` | `voice` | `http://sherpa-stt:9000` | Moonshine v2 base-en + Silero VAD streaming (CPU) |
| `kokoro` | `voice` | `http://kokoro:8880` | TTS (`ghcr.io/remsky/kokoro-fastapi-cpu`) |
| `stt-mock` | `voice-dev` | `http://stt-mock:9000` (host `:9001`) | Fixed transcript for CI |

```bash
# Production voice stack
docker compose --profile voice up -d

# Fast CI / dev mock (no model download)
docker compose --profile voice-dev up -d
```

## Smoke tests

```bash
./scripts/voice-smoke.sh --up          # sherpa-stt + kokoro
./scripts/voice-smoke.sh --up-mock --no-tts   # CI-fast STT only
./scripts/ci-validate.sh --voice-only  # non-interactive
```

`sherpa-stt` bakes the Moonshine model into the image (~first start may take up to 90s to load).

## Enable in Settings

1. Settings → AI & Permissions → **Voice loop** → enable.
2. STT URL: `http://sherpa-stt:9000` (or `http://stt-mock:9000` with `voice-dev`).
3. TTS URL: `http://kokoro:8880`
4. **Watchword** defaults to `moneypenny` — say **“Moneypenny, pause”** (not bare `pause`).
5. **Check** + synthetic **Test** (e.g. transcript `Moneypenny pause`).

## HTTP contract

Both `sherpa-stt` and `stt-mock` implement `bot/src/voice/stt.ts`:

- `GET /health` → `{ "ok": true, "streaming": true }`
- `POST /asr` — batch offline decode (smoke tests)
- `POST /asr/stream` — streaming chunks; headers `X-Client-Id`, `X-Sample-Rate`, `X-Channels` → `{ "partial", "final", "speaking" }`
- `DELETE /asr/stream` — reset per-speaker session (`X-Client-Id`)

The bot feeds 100 ms PCM chunks while you talk. Sherpa runs **simulated streaming** (Silero VAD + periodic Moonshine v2 decode), not the HuggingFace `moonshine-streaming-tiny` Transformers checkpoint — same idea, ONNX path tuned for the Pi.

`sherpa-stt` resamples/downmixes (e.g. 48 kHz stereo from the bot) to 16 kHz mono internally.

## API (admin)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/bot/voice/status` | Sidecar probes + pipeline active flag |
| `POST /api/bot/voice/test` | `{ "transcript": "Moneypenny pause", "speak": false }` |

## Watchword

Voice commands require the configured **watchword** (default `moneypenny`) before the command:

- “**Moneypenny**, pause” — watchword + command in one breath
- “**Moneypenny**” … then “pause” within 8 seconds — two-step wake (music stays paused while listening)
- “Hey **Moneypenny**, play jazz”

STT mishearings like “money penny” / “money petty” are accepted. Toggle **Require watchword** off in Settings to restore always-on listening (not recommended in busy channels).

Music ducks briefly **only while STT runs** on the watchword (not on the first syllable). After a watchword-only utterance, playback **stays paused** for up to 8 seconds so a short follow-up like “pause” is not drowned out by the bot’s own music. Music resumes when the window expires, after a non-pause command, or after you say pause/stop.

## Validation status (2026-06-20)

- **CI / mock STT:** `./scripts/ci-validate.sh --voice-only` passes (stt-mock → `skip`).
- **Unit tests:** `bot/src/voice/pipeline.test.ts` covers router integration + rank gating.
- **Hardware (open):** real Opus decode on TS6, round-trip latency on RK3588, music
  interrupt/resume around spoken replies — enable the `voice` profile on the Pi,
  smoke with Settings → Voice → **Test** (`POST /api/bot/voice/test`).

## Remaining / hardware

- Real Opus voice-codec decode validation on TS6 (needs live TS6 + voice profile on Pi).
- Round-trip latency on RK3588.
- Music interrupt/resume around spoken replies.