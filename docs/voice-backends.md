# Voice backends — dual-track Whisper + Piper

Moneypenny does **not** embed STT/TTS. The bot only calls HTTP sidecars.

| Role | Client (class name is historical) | Contract |
|------|-------------------------------------|----------|
| STT | `SherpaSttClient` | `GET /health`, `POST /asr`, `POST /asr/stream`, `DELETE /asr/stream` |
| TTS | `KokoroTtsClient` | `POST /v1/audio/speech` → audio bytes |

**Canonical TTS:** Piper **`en_GB-cori-medium`** (British female, medium quality).  
Samples: [rhasspy.github.io/piper-samples](https://rhasspy.github.io/piper-samples/) · models: [huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) (`en/en_GB/…`).  
Download helper: `./scripts/download-piper-voice.sh [en_GB-cori-medium]`.  
After changing voice: Settings → **Clear TTS bumper cache**, then **Pre-generate bumpers**.

**Canonical STT:** Whisper dual-track (below).  
**No** English-word → command alias tables.  
**No** KWS on Whisper path → enable `voice.textWakeFallback`.

**Removed (V2, 2026-07):** Moonshine **sherpa-stt**, **Kokoro** TTS, compose profile `voice`.

---

## Dual track (product default)

| Edition | Image | Engine | Default model | Accelerator |
|---------|-------|--------|---------------|-------------|
| **SBC** | `services/stt-rknn` | **RKNN** NPU (faster-whisper CPU if weights missing) | **`base`** | **NPU** (`STT_DEVICE=npu`) |
| **Server** | `services/stt-whisper-cpp` | **whisper.cpp** | `medium` | **Vulkan** (AMD) / CPU |

Same compose service name: **`stt-whisper`** → bot always uses  
`http://stt-whisper:9000`. Overlays swap the build context.

```text
                    ┌─ docker-compose.sbc.yml ──► stt-rknn (NPU base)
 bot ──sttUrl──► stt-whisper
                    └─ docker-compose.server.yml ► stt-whisper-cpp (Vulkan medium)
```

Rockchip zoo RKNN Whisper ladder: **tiny / base / medium** (no `small`). Product
default on the Pi is **base** — validated as snappier and cleaner than CPU
`small` on RK3588. Optional: `tiny` (lighter) or `medium` (heavier NPU RAM).

---

## Profiles

| Profile | Edition | STT image | TTS |
|---------|---------|-----------|-----|
| **`voice-edge`** | SBC | stt-rknn | piper-tts |
| **`voice-server`** | Server | stt-whisper-cpp | piper-tts |
| **`voice-dev`** | CI | stt-mock | — |

```bash
# SBC — base on NPU (export .rknn first; else CPU fallback)
export STT_MODEL=base STT_BACKEND=rknn STT_DEVICE=npu
docker compose -f docker-compose.yml -f docker-compose.sbc.yml \
  --profile voice-edge up -d --build

# Server (AMD / CachyOS) — medium on Vulkan
export STT_MODEL=medium STT_DEVICE=vulkan WHISPER_VULKAN=1
export RENDER_GID=$(getent group render | cut -d: -f3)
export VIDEO_GID=$(getent group video | cut -d: -f3)
./scripts/download-whisper-ggml.sh --dir ./models/whisper-cpp medium
docker compose -f docker-compose.yml -f docker-compose.server.yml \
  --profile voice-server up -d --build
```

Smoke: `./scripts/voice-smoke.sh` · `./scripts/voice-profile.sh`

---

## Model assets

### Server (whisper.cpp)

Volume / bind `models/whisper-cpp` → `/models`: `ggml-tiny.bin`, `ggml-base.bin`,
`ggml-small.bin`, `ggml-medium.bin`, …

### SBC (RKNN)

Runtime opts (see `services/stt-rknn/README.md`): multi-core init
(`RKNN_CORE_MASK`, prefer all three cores), faster log-mel, reused buffers,
decoder step cap. Quant is in the `.rknn` export — not `STT_COMPUTE_TYPE`.

`/models/rknn/` (product default **base**):

```text
whisper-base-encoder.rknn
whisper-base-decoder.rknn
vocab_en.txt
mel_80_filters.txt
```

Export on an x86 host with rknn-toolkit2:

```bash
MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh
# → models/rknn/whisper-base-{encoder,decoder}.rknn (+ vocab, mel)
# rsync to the Pi, copy into the whisper-models volume if used
```

Optional overrides: `RKNN_ENCODER` / `RKNN_DECODER`. Tiny/medium pairs use the
same naming (`whisper-tiny-*`, `whisper-medium-*`).

Without weights the service falls back to **faster-whisper** on CPU
(`STT_FALLBACK=faster-whisper`, often `STT_MODEL=base` or `small`).

---

## Bot Settings

```json
{
  "voice": {
    "enabled": true,
    "sttUrl": "http://stt-whisper:9000",
    "ttsUrl": "http://piper-tts:8880",
    "ttsVoice": "en_GB-cori-medium",
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
