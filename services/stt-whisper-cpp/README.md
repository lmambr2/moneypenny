# stt-whisper-cpp — Server STT track

**whisper.cpp** sidecar for the **Server edition** (AMD Vulkan preferred).

Same HTTP contract as `stt-rknn` / legacy `stt-whisper` (`bot/src/voice/stt.ts`).

## Env

| Variable | Default | Notes |
|----------|---------|--------|
| `STT_MODEL` | `small` | Maps to `ggml-{name}.bin` under `/models` |
| `STT_MODEL_PATH` | — | Explicit ggml file |
| `STT_DEVICE` | `auto` | `cpu` · `vulkan` · `cuda` |
| `STT_MODELS_DIR` | `/models` | Volume for weights |
| `WHISPER_BIN` | `whisper-cli` | |

## Models

Download into the compose volume (example):

```bash
# From host with network
mkdir -p models/whisper-cpp
# e.g. https://huggingface.co/ggerganov/whisper.cpp — ggml-small.bin
```

## Vulkan (AMD)

```bash
docker build --build-arg WHISPER_VULKAN=1 -t stt-whisper-cpp .
# compose: devices /dev/dri, group_add render/video
```

## Dual track

| Edition | Service image | Engine |
|---------|---------------|--------|
| Server | **this** | whisper.cpp (+ Vulkan) |
| SBC | `services/stt-rknn` | RKNN NPU (+ faster-whisper CPU fallback) |
