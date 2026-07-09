# Voice backends — dual-track Whisper + Piper

Moneypenny does **not** embed STT/TTS. The bot only calls HTTP sidecars.

| Role | Client | Contract |
|------|--------|----------|
| STT | `SherpaSttClient` (name is historical) | `GET /health`, `POST /asr`, `POST /asr/stream`, `DELETE /asr/stream` |
| TTS | `KokoroTtsClient` (OpenAI speech) | `POST /v1/audio/speech` → audio bytes |

**Canonical TTS:** Piper `en_GB-southern_english_female-low`.  
**Canonical STT family:** Whisper (dual implementation tracks).  
**No** English-word → command alias tables.  
**No** KWS on Whisper path → enable `voice.textWakeFallback`.

Moonshine/sherpa + Kokoro remain **legacy only** (`--profile voice`) until Whisper is proven, then removed.

---

## Dual track (product default)

| Edition | Image | Engine | Default model | Accelerator |
|---------|-------|--------|---------------|-------------|
| **SBC** | `services/stt-rknn` | **RKNN** → faster-whisper fallback | `tiny` | Rockchip **NPU** (CPU until `.rknn` ready) |
| **Server** | `services/stt-whisper-cpp` | **whisper.cpp** | `small` | **Vulkan** (AMD) / CPU |

Same compose service name: **`stt-whisper`** → bot always uses  
`http://stt-whisper:9000`. Overlays swap the build context.

```text
                    ┌─ docker-compose.sbc.yml ──► stt-rknn (NPU)
 bot ──sttUrl──► stt-whisper
                    └─ docker-compose.server.yml ► stt-whisper-cpp (Vulkan)
```

### Why not one engine everywhere?

- **AMD Server** wants whisper.cpp + Vulkan (no CUDA).  
- **Pi** wants NPU utilization via **RKNN** Whisper.  
- Shared **HTTP contract** keeps the bot single-path.

---

## Profiles

| Profile | Edition | STT image | TTS |
|---------|---------|-----------|-----|
| **`voice-edge`** | SBC | stt-rknn | piper-tts |
| **`voice-server`** | Server | stt-whisper-cpp | piper-tts |
| **`voice`** | legacy | sherpa + Kokoro | — |
| **`voice-dev`** | CI | stt-mock | — |

```bash
# SBC
export STT_MODEL=tiny STT_BACKEND=rknn
docker compose -f docker-compose.yml -f docker-compose.sbc.yml \
  --profile voice-edge up -d --build

# Server (AMD)
export STT_MODEL=small STT_DEVICE=vulkan WHISPER_VULKAN=1
# Place ggml-small.bin in the whisper-models volume
docker compose -f docker-compose.yml -f docker-compose.server.yml \
  --profile voice-server up -d --build
```

---

## Model assets

### Server (whisper.cpp)

Volume `whisper-models` → `/models`. Files like:

- `ggml-tiny.bin`, `ggml-base.bin`, `ggml-small.bin`, `ggml-medium.bin`, `ggml-large-v3.bin`

From [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) (or `STT_MODEL_PATH`).

### SBC (RKNN)

Volume path `/models/rknn/`:

- `whisper-tiny-encoder.rknn` + `whisper-tiny-decoder.rknn`

From Rockchip [rknn_model_zoo whisper](https://github.com/airockchip/rknn_model_zoo/tree/main/examples/whisper).  
Until present, **faster-whisper tiny on CPU** runs automatically (`STT_FALLBACK`).

Full mel→token RKNN loop may still fall back until the zoo I/O is fully wired — see `services/stt-rknn/README.md`.

---

## Bot config (both editions)

```json
{
  "voice": {
    "enabled": true,
    "sttUrl": "http://stt-whisper:9000",
    "ttsUrl": "http://piper-tts:8880",
    "ttsVoice": "en_GB-southern_english_female-low",
    "respondWithVoice": true,
    "requireWatchword": true,
    "textWakeFallback": true
  }
}
```

---

## Legacy

| Profile | Engine |
|---------|--------|
| `voice` | sherpa Moonshine + KWS (port 9002) + Kokoro |
| `services/stt-whisper` | faster-whisper only (dev / unoverlaid base compose) |

---

## Security

- Host ports bind `127.0.0.1` only.  
- No cloud STT/TTS in default profiles.  
