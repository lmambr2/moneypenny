# Voice backends — dual-track Whisper + Piper

Moneypenny does **not** embed STT/TTS. The bot only calls HTTP sidecars.

| Role | Client (class name is historical) | Contract |
|------|-------------------------------------|----------|
| STT | `SherpaSttClient` | `GET /health`, `POST /asr`, `POST /asr/stream`, `DELETE /asr/stream` |
| TTS | `KokoroTtsClient` | `POST /v1/audio/speech` → audio bytes |

**Canonical TTS:** Piper `en_GB-southern_english_female-low`.  
**Canonical STT:** Whisper dual-track (below).  
**No** English-word → command alias tables.  
**No** KWS on Whisper path → enable `voice.textWakeFallback`.

**Removed (V2, 2026-07):** Moonshine **sherpa-stt**, **Kokoro** TTS, compose profile `voice`.

---

## Dual track (product default)

| Edition | Image | Engine | Default model | Accelerator |
|---------|-------|--------|---------------|-------------|
| **SBC** | `services/stt-rknn` | **RKNN** → faster-whisper fallback | `tiny` | Rockchip **NPU** |
| **Server** | `services/stt-whisper-cpp` | **whisper.cpp** | `small` | **Vulkan** (AMD) / CPU |

Same compose service name: **`stt-whisper`** → bot always uses  
`http://stt-whisper:9000`. Overlays swap the build context.

```text
                    ┌─ docker-compose.sbc.yml ──► stt-rknn (NPU)
 bot ──sttUrl──► stt-whisper
                    └─ docker-compose.server.yml ► stt-whisper-cpp (Vulkan)
```

---

## Profiles

| Profile | Edition | STT image | TTS |
|---------|---------|-----------|-----|
| **`voice-edge`** | SBC | stt-rknn | piper-tts |
| **`voice-server`** | Server | stt-whisper-cpp | piper-tts |
| **`voice-dev`** | CI | stt-mock | — |

```bash
# SBC
export STT_MODEL=tiny STT_BACKEND=rknn
docker compose -f docker-compose.yml -f docker-compose.sbc.yml \
  --profile voice-edge up -d --build

# Server (AMD / CachyOS)
export STT_MODEL=small STT_DEVICE=vulkan WHISPER_VULKAN=1
export RENDER_GID=$(getent group render | cut -d: -f3)
export VIDEO_GID=$(getent group video | cut -d: -f3)
./scripts/download-whisper-ggml.sh --dir ./models/whisper-cpp small
docker compose -f docker-compose.yml -f docker-compose.server.yml \
  --profile voice-server up -d --build
```

Smoke: `./scripts/voice-smoke.sh` · `./scripts/voice-profile.sh`

---

## Model assets

### Server (whisper.cpp)

Volume / bind `models/whisper-cpp` → `/models`: `ggml-tiny.bin`, `ggml-small.bin`, …

### SBC (RKNN)

`/models/rknn/`: `whisper-tiny-encoder.rknn`, `whisper-tiny-decoder.rknn`, vocab, mel filters.

---

## Bot Settings

```json
{
  "voice": {
    "enabled": true,
    "sttUrl": "http://stt-whisper:9000",
    "ttsUrl": "http://piper-tts:8880",
    "ttsVoice": "en_GB-southern_english_female-low",
    "textWakeFallback": true,
    "requireWatchword": true
  }
}
```

---

## Migrating off legacy sherpa/Kokoro

If an old host still has `COMPOSE_PROFILES=…,voice` or `sherpa-stt` / `kokoro` containers:

```bash
docker compose --profile voice stop sherpa-stt kokoro 2>/dev/null || true
docker rm -f moneypenny-sherpa-stt-1 moneypenny-kokoro-1 2>/dev/null || true
# Set profiles to voice-edge (Pi) or voice-server (x86); sttUrl/ttsUrl as above
```

Install flag `--with-voice-legacy` now **errors** with a pointer to edge/server.
