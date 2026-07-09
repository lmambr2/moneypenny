# Voice Loop — Phase 2

**Goal (DESIGN §10):** Inbound TeamSpeak audio → STT → the same control router as chat → optional TTS reply.

## Sidecars

**Multi-backend layout:** see **[voice-backends.md](./voice-backends.md)** (edge Pi vs x86 server).

| Service | Profile | URL (Docker) | Purpose |
|---------|---------|--------------|---------|
| **`stt-whisper`** | **`voice-edge`**, **`voice-server`** | `http://stt-whisper:9000` | **Whisper** dual-track (RKNN / whisper.cpp) |
| **`piper-tts`** | edge + server | `http://piper-tts:8880` | British female Piper |
| `stt-mock` | `voice-dev` | host `:9001` | CI |

**Removed (V2):** `sherpa-stt` (Moonshine) and `kokoro` TTS.

```bash
./scripts/voice-profile.sh
# Pi: RKNN Whisper base + Piper (export .rknn first — models/rknn/README.md)
export STT_MODEL=base STT_BACKEND=rknn STT_DEVICE=npu
docker compose -f docker-compose.yml -f docker-compose.sbc.yml --profile voice-edge up -d --build
# x86 AMD: whisper.cpp Vulkan
export STT_MODEL=medium STT_DEVICE=vulkan WHISPER_VULKAN=1
docker compose -f docker-compose.yml -f docker-compose.server.yml --profile voice-server up -d --build
```

## Smoke tests

```bash
./scripts/voice-smoke.sh --up-mock --no-tts   # CI-fast STT only
./scripts/voice-smoke.sh --up edge            # product edge stack
./scripts/ci-validate.sh --voice-only
```

## Enable in Settings

1. Settings → AI & Permissions → **Voice loop** → enable.
2. STT `http://stt-whisper:9000`, TTS `http://piper-tts:8880`, voice **`en_GB-southern_english_female-low`**.
3. Turn on **text wake fallback** (`textWakeFallback: true`) — Whisper has no separate KWS.
4. **Watchword** defaults to `moneypenny` — say **“Moneypenny, pause”**.
5. **Check** + synthetic **Test** (transcript `Moneypenny pause`).

## HTTP contract

`stt-whisper` (any dual-track image) and `stt-mock` implement `bot/src/voice/stt.ts`:

- `GET /health` → `{ "ok": true, "streaming": true, … }`
- `POST /asr` — batch offline decode (smoke tests)
- `POST /asr/stream` — streaming chunks; headers `X-Client-Id`, `X-Sample-Rate`, `X-Channels` → `{ "partial", "final", "speaking" }`
- `DELETE /asr/stream` — reset per-speaker session (`X-Client-Id`)

The bot feeds 100 ms PCM chunks while you talk. Sidecars resample to 16 kHz mono as needed.

## API (admin)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/bot/voice/status` | Sidecar probes + pipeline active flag |
| `POST /api/bot/voice/test` | `{ "transcript": "Moneypenny pause", "speak": false }` |

## Watchword

Voice commands require the configured **watchword** (default `moneypenny`) before the command:

- “**Moneypenny**, pause” — watchword + command in one breath
- “**Moneypenny**” … then “pause” within 15 seconds — two-step wake (music stays ducked while listening)
- “Hey **Moneypenny**, play jazz”

STT mishearings like “money penny” / “money petty” are accepted. Toggle **Require watchword** off in Settings to restore always-on listening (not recommended in busy channels).

Music ducks briefly **only while STT runs** on the watchword (not on the first syllable). After a watchword-only utterance, playback **stays ducked** for up to 15 seconds (`listenWindowMs`, minimum 15s) so a short follow-up like “pause” is not drowned out by the bot’s own music. Volume restores when the armed window expires, after a routed command, or after you say pause/stop. Restore is **immediate** (no fade) when ducking ends.

For a planned listen-only delegate bot (Intercom), see [`docs/intercom.md`](./intercom.md).

## Validation status (2026-07-08)

- **CI / mock STT:** `./scripts/ci-validate.sh --voice-only` passes (stt-mock → `skip`).
- **Unit tests:** `bot/src/voice/pipeline.test.ts`, `opus-packet.test.ts`, `opus-voice.test.ts`.
- **Opus decode (shipped `974ea1d`):** `bot/src/audio/opus-voice.ts` — decode-first path
  with multi-frame fallback; valid tiny silence frames no longer skipped as DTX; per-client
  decode-failure rate limiting + stats in capture summary.
- **Invoker/voice logging:** text commands log `invokerName`/`invokerUid`/`invokerClientId`;
  per-client `"Voice: first inbound packet from client"` for TS debugging.
- **Ducking:** `AudioPlayer.duckForStt()` / `restoreFromSttDuck()` — volume attenuation
  during STT capture (not hard-pause). TTS replies still use save-position → speak → resume.

## Under-music tips (SBC)

- Product STT: **Whisper base on NPU** (`STT_MODEL=base`, `STT_BACKEND=rknn`).
- Keep **Duck music while listening** on; set duck volume low (default 2).
- **Listen window** ≥ 15s so “Moneypenny” … “pause” works without re-saying the watchword.
- Prefer short transport verbs: pause / skip / clear / next (no synonym maps).
- Memory / roast: “Moneypenny, remember I like jazz” · “Moneypenny, roast”.

## Remaining / hardware

- Live TS6 round-trip latency on RK3588 with `voice-edge`.
- STT/TTS sidecar tuning on the Pi (Settings → Voice → **Test**).