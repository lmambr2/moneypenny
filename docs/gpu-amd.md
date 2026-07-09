# AMD GPU — Server edition (host Ollama + whisper.cpp Vulkan)

Primary accelerator path for the **Server** edition. NVIDIA is untested.

## Layout (recommended)

| Component | Where | Notes |
|-----------|--------|--------|
| **Chat 12B** | **Host Ollama** (ROCm or Vulkan backend) | Not Docker Ollama unless CPU-only |
| **Analyst 31B** | Same host, **opt-in** Settings toggle | Only with VRAM headroom; see below |
| **STT** | Compose `stt-whisper-cpp` | Build with `WHISPER_VULKAN=1` |
| **Bot / RAG / Piper** | Compose Server edition | Embeddings on bot host |

Workstation example: `192.168.1.89` running host Ollama; Pi or Server bot uses
`llmUrl: http://192.168.1.89:11434`.

## Host Ollama (ROCm)

```bash
# Install Ollama for Linux, then ROCm stack per AMD docs for your card (e.g. R9700).
ollama serve   # listen on 0.0.0.0:11434 if LAN clients need it
ollama pull hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL
# Firewall: allow 11434 only from bot host IP(s)
```

Bot Settings (or install `--llm http://192.168.1.89:11434`):

```json
{
  "llmUrl": "http://192.168.1.89:11434",
  "llmModel": "hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL",
  "llmFallbackUrl": "http://ollama:11434",
  "llmFallbackModel": "hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL"
}
```

Do **not** enable 31B until `./scripts/check-analyst-vram.sh` says OK (or you
accept model swap).

## whisper.cpp Vulkan in Docker

```bash
./scripts/download-whisper-ggml.sh --dir ./models/whisper-cpp small
# Map ./models/whisper-cpp into volume whisper-models

export WHISPER_VULKAN=1 STT_MODEL=small STT_DEVICE=vulkan
# Host groups for /dev/dri:
# Arch / CachyOS: GIDs are often ~987/983, not Debian 992/44 — always export from host:
export RENDER_GID=$(getent group render | cut -d: -f3)
export VIDEO_GID=$(getent group video | cut -d: -f3)
# docker CLI may be podman; both work if /dev/dri is passed.

docker compose -f docker-compose.yml -f docker-compose.server.yml \
  --profile core --profile voice-server up -d --build stt-whisper
```

If the container cannot see the GPU: check `RENDER_GID`/`VIDEO_GID`,
`/dev/dri`, and host Vulkan ICD (`vulkaninfo | head`).

## Optional: compose Ollama with ROCm image

When host Ollama is not preferred:

```yaml
# docker-compose.server.rocm.yml (see file) — ollama/ollama:rocm
# devices: /dev/kfd, /dev/dri
```

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml \
  -f docker-compose.server.rocm.yml --profile ollama up -d
```

## VRAM policy (12B + 31B)

| Approx free VRAM | Action |
|------------------|--------|
| &lt; 20 GB | 12B only |
| 20–24 GB | 31B only with swap (`OLLAMA_MAX_LOADED_MODELS=1`) |
| ≥ ~28–32 GB | optional concurrent |

```bash
./scripts/check-analyst-vram.sh
```

## Installer

```bash
./install.sh --edition server --with-rag --with-voice
# or wizard; on AMD it prefers whisper.cpp Vulkan defaults
./scripts/detect-gpu.sh
```
