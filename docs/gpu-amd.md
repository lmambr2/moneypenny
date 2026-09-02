# AMD GPU — Server edition (host Ollama + whisper.cpp Vulkan)

Primary accelerator path for the **Server** edition. NVIDIA is untested.

## Layout

Two cards is the **target** workstation (dual Radeon AI PRO R9700). Until the
second card is installed, Penny uses the one visible GPU — do not set the
dual-GPU pins below or you will hide the only card.

| Job | Where | Model |
|---|---|---|
| Voice + tools + `!ask` | GPU **Penny** Ollama `:11434` | Gemma 4 12B QAT (Q8 if it fits with 8k KV; else Q4) |
| STT | same GPU, Vulkan whisper.cpp | `large-v3-turbo` |
| TTS | **CPU** (Piper) | `en_GB-cori-high` (medium fail-open) |
| Embeddings | Penny GPU or CPU | `bge-large-en-v1.5` |
| Coding / `!analyst` | GPU **Desk** `:11435` | coder / Gemma 4 31B QAT, `keep_alive=5m` |
| Crash fallback | CPU | E2B only if `:11434` is dead |

**Gemma 4 12B is text-out only.** Whisper is the ear. Piper (or optional Kokoro
on CPU) is the mouth. Do not put Qwen3-TTS or 31B on the Penny GPU next to a
hot 12B. Do not tensor-split any model across the two cards.

### Dual R9700 pin (after the second card is in)

- **GPU 0 = desk.** Games when gaming. Coder / 31B when not. MoneyPenny must
  never load weights here.
- **GPU 1 = Penny.** Voice + chat + STT only.

Two Ollama **processes**, never one `ollama serve` that can see both cards:

| Daemon | Port | Pin | keep_alive |
|---|---|---|---|
| `ollama-penny` | `:11434` | `HIP_VISIBLE_DEVICES=1`, `GGML_VK_VISIBLE_DEVICES=1`, optional `ROCR_VISIBLE_DEVICES=<gpu1-uuid>` | `24h` |
| `ollama-desk` | `:11435` | `HIP_VISIBLE_DEVICES=0` | `5m` |

Unit templates: `host-setup/ollama-penny.service`, `host-setup/ollama-desk.service`.

Bot Settings: `llmUrl` → `:11434`. `llmDelegateUrl` → `:11435`. Coding tools →
`:11435` only.

Whisper must **not** mount every `/dev/dri` node. Bind GPU 1's render node
only, via `PENNY_RENDER_NODE` (often `/dev/dri/renderD129` — confirm with
`ls -l /dev/dri`). Until then, compose defaults to `/dev/dri/renderD128`
(the first / only card).

```bash
# After dual-GPU is installed:
export PENNY_GPU_INDEX=1
export PENNY_RENDER_NODE=/dev/dri/renderD129
# .env — see .env.example.server
```

`rocm-smi` while a game is running on GPU 0 should show Penny VRAM only on GPU 1.

## Host Ollama (ROCm) — single card today

```bash
# Install Ollama for Linux, then ROCm stack per AMD docs for your card.
ollama serve   # listen on 0.0.0.0:11434 if LAN clients need it
ollama pull hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL
# Firewall: allow 11434 only from bot host IP(s)
```

Bot Settings (or install `--llm http://127.0.0.1:11434`):

```json
{
  "llmUrl": "http://127.0.0.1:11434",
  "llmModel": "hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL",
  "llmFallbackUrl": "http://ollama:11434",
  "llmFallbackModel": "hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL"
}
```

Penny `keep_alive` is **24h** (bot request + `OLLAMA_KEEP_ALIVE`). Flash
attention is requested on each chat (`options.flash_attention`). Gemma 4 MTP
drafter is used when the Ollama/llama.cpp build supports it — do not add a
second model on the Penny GPU to force it.

Do **not** enable 31B on the same daemon as 12B. After dual-GPU, put 31B on
desk `:11435` and `./scripts/check-analyst-vram.sh` before first load.

## Game mode / desk mode

```bash
./scripts/game-mode.sh   # unload desk models (no-op if :11435 is down)
./scripts/desk-mode.sh   # warm desk with keep_alive=5m
```

Voice stays up: game-mode never stops `:11434`.

## whisper.cpp Vulkan in Docker

```bash
./scripts/download-whisper-ggml.sh --dir ./models/whisper-cpp large-v3-turbo
# Map ./models/whisper-cpp into volume whisper-models

export WHISPER_VULKAN=1 STT_MODEL=large-v3-turbo STT_DEVICE=vulkan
export RENDER_GID=$(getent group render | cut -d: -f3)
export VIDEO_GID=$(getent group video | cut -d: -f3)

docker compose -f docker-compose.yml -f docker-compose.server.yml \
  --profile core --profile voice-server up -d --build stt-whisper
```

Compose binds **one** render node (`PENNY_RENDER_NODE`, default
`/dev/dri/renderD128`) into the container as `renderD128`. Inside the
container `GGML_VK_VISIBLE_DEVICES=0` is that node.

## Optional: compose Ollama with ROCm image

Prefer host Ollama. Container path (single visible card):

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml \
  -f docker-compose.server.rocm.yml --profile ollama up -d
```

## VRAM policy (12B + 31B)

| Approx free VRAM | Action |
|------------------|--------|
| &lt; 20 GB | 12B only |
| 20–24 GB | 31B only with swap (`OLLAMA_MAX_LOADED_MODELS=1`) on **desk**, never beside 12B |
| ≥ ~48 GB (two cards) | 12B on GPU 1, 31B on GPU 0 when not gaming |

Do not measure a GPU TTS sidecar until 12B Q8 + Whisper turbo are resident.

## Installer

```bash
./install.sh --edition server --with-rag --with-voice
./scripts/detect-gpu.sh
```
