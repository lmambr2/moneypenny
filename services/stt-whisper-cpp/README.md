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

Image is **Ubuntu 24.04** (Debian bookworm Vulkan headers are too old for current
ggml-vulkan). Copies `libwhisper` / `libggml*` into the runtime image.

```bash
# Host (Arch/CachyOS): real GIDs — not Debian defaults
export RENDER_GID=$(getent group render | cut -d: -f3)
export VIDEO_GID=$(getent group video | cut -d: -f3)
export WHISPER_VULKAN=1 STT_DEVICE=vulkan STT_MODEL=tiny

./scripts/download-whisper-ggml.sh --dir ./models/whisper-cpp tiny

docker build --build-arg WHISPER_VULKAN=1 -t moneypenny-stt-whisper-cpp:vulkan \
  -f services/stt-whisper-cpp/Dockerfile services/stt-whisper-cpp

# Smoke (podman-as-docker OK)
docker run --rm -p 19000:9000 --device /dev/dri \
  --group-add "$RENDER_GID" --group-add "$VIDEO_GID" \
  -e STT_MODEL=tiny -e STT_DEVICE=vulkan \
  -v "$PWD/models/whisper-cpp:/models:ro" \
  moneypenny-stt-whisper-cpp:vulkan
# curl -s localhost:19000/health  → device: vulkan
```

## Dual track

| Edition | Service image | Engine |
|---------|---------------|--------|
| Server | **this** | whisper.cpp (+ Vulkan) |
| SBC | `services/stt-rknn` | RKNN NPU (+ faster-whisper CPU fallback) |
