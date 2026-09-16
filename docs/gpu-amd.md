# AMD GPU — Server edition (host Ollama + whisper.cpp Vulkan)

Primary accelerator path for the **Server** edition. NVIDIA is untested.


**This workstation (2026-09-15):** two R9700s are in the box. Day-to-day **chat is
Radiance vLLM Qwen3.8** (AMD Quark MXFP4) on the infer UUID at `:8080`, not
Ollama 12B. Whisper.cpp Vulkan runs on the **display** GPU. Embeddings are CPU
Ollama `:11435` (`nomic-embed-text-v2-moe`, 768-d). Dual-Ollama penny/desk below
is the fallback layout if Radiance is down. See [Qwen3.8 Radiance](#qwen38-radiance-infer-r9700).

## Layout

Two discrete cards is the **target** workstation (dual Radeon AI PRO R9700).
Until a second *dGPU* is installed, Penny uses the one visible discrete GPU —
do not set the dual-GPU pins below or you will hide the only card.

This box now has **two R9700s (32 GB each) + a disabled/unused Raphael iGPU**.
Identify cards by **PCI / ROCm UUID**, not `GPU 0`. Display = `0000:03:00.0`
(`GPU-fc88d268d1867ded`). Infer / Penny = `0000:07:00.0` (`GPU-e8d920aa6c70376b`).
`scripts/detect-gpu.sh` still skips Raphael / Granite Ridge iGPU names. Official
PersonaPlex (NVIDIA CUDA) is not a path here; duplex stays **cascaded** until
`scripts/duplex-rtf.sh` measures moshi.cpp Vulkan q4_k.

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

## Qwen3.8 Radiance (infer R9700)

On this dual-R9700 workstation the **primary chat/tools** path is vLLM Radiance
MXFP4 on the **infer** card, not llama.cpp 12B. That changes where STT and
embeddings live: the infer card is full (~29 GB of 32 GB). Do not share it.

| Piece | Where | Why |
|---|---|---|
| **Chat / tools** | Radiance `:8080` on **infer** UUID | Qwen3.8 MXFP4 + DFlash2 |
| **Embeddings / RAG** | CPU Ollama `:11435` (`nomic-embed-text-v2-moe`, 768-d) | Matches TurboVec; never vLLM; never either GPU |
| **Vector store** | TurboVec `:6333` | Already on disk at `bot/data/turbovec` |
| **STT** | whisper.cpp Vulkan **medium** on the **display** card (`GGML_VK_VISIBLE_DEVICES=0`) | Infer has ~3 GB free — medium will OOM or hitch decode |
| **TTS** | Piper **CPU** `en_GB-cori-medium` | Do not GPU-offload |

| | |
|---|---|
| Serve | `~/radiance/serve.sh` (solo, `ROCR_VISIBLE_DEVICES=$INFER_UUID`) |
| Image | `stilldeadcode/vllm-radiance:0.9.3` |
| Origin | `http://127.0.0.1:8080` — **no `/v1`**; the bot appends `/v1/chat/completions` |
| Model | `Qwen3.8` |
| Settings preset | **Local — Radiance Qwen3.8 (R9700)** |
| Fallback | llama.cpp Gemma 12B on `:11434` if that unit is up |
| Embeddings unit | `systemctl --user start ollama-embed` (`127.0.0.1:11435`) |

Do **not** tensor-parallel onto the display GPU unless `/tmp/mp-allow-display-gpu`
exists. Do **not** start the system `ollama.service`: it pins the infer UUID and
points `OLLAMA_MODELS` at `/Mandragora/models` (broken). Do not load llama.cpp
HIP 12B on the infer UUID while Radiance is up.

The bot sends `chat_template_kwargs.enable_thinking=false` so Qwen does not
burn the reply budget on a think block (voice + `!ask` latency).

Compose overlay so Docker Ollama does not steal :11434 or the GPU:

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml \
  -f docker-compose.server.llamacpp.yml \
  --profile core --profile ollama --profile rag --profile voice-server up -d
```

### Flag reasons

| Flag | Reason |
|------|--------|
| UD-Q4_K_XL / Google QAT Q4_0 | QAT was trained for this bit-width. Do not requant to Q3. |
| `--spec-type draft-mtp` + n-max 2 | First measure n-max 2. n-max 4 is faster when accept rate stays >0.65; drop to 2 if voice replies get garbled. |
| `--parallel 1` | Voice is single-stream. Extra slots steal KV. |
| `-c 16384` | TS commands + RAG snippets. 32K is optional. 128K is wasted on a secretary bot and inflates KV. |
| `--cache-type-k/v q8_0` | Cuts KV ~2× vs f16 with almost no quality loss. Use q4_0 only if Whisper OOMs you. |
| `--reasoning off` | Thinking mode doubles tokens and kills barge-in latency. |
| No mmproj / no audio projector | Separate Whisper/Piper already exist. |

## Whisper + Piper on the same card

MoneyPenny server STT is whisper.cpp Vulkan **medium**. Keep it that way.

```bash
export GGML_VK_VISIBLE_DEVICES=1
export STT_MODEL=medium
export STT_DEVICE=vulkan
# do not jump to large-v3 on a shared 32 GB card until the LLM is stable
```

If VRAM spikes when both are hot:

1. Drop LLM ctx to 8192
2. KV `q4_0`
3. MTP n-max 2
4. Only then consider Whisper `base` instead of `medium`

Piper stays on CPU.

Host groups for `/dev/dri` (Arch / CachyOS GIDs are often ~987/983, not Debian
992/44):

```bash
export RENDER_GID=$(getent group render | cut -d: -f3)
export VIDEO_GID=$(getent group video | cut -d: -f3)
./scripts/download-whisper-ggml.sh --dir ./models/whisper-cpp medium
```

## What not to do on one R9700

- Serve `google/gemma-4-12B-it` BF16 in vLLM (~25 GB weights). Whisper dies.
- Use a non-QAT Q4_0 / IQ3 “to save VRAM.” You already fit. Quality is the
  scarce resource, not gigabytes.
- Leave thinking mode on.
- Load 131K context “because the card can.” Voice + RAG does not need it; KV
  will fight Whisper.
- Run Ollama and llama.cpp both claiming the GPU.
- Compile llama.cpp HIP and expect Ollama’s bundled ROCm binary to pick up MTP.

## Optional: vLLM on this one card

Use Google’s official compressed-tensors QAT, not BF16:

```text
google/gemma-4-12B-it-qat-w4a16-ct
```

```bash
vllm serve google/gemma-4-12B-it-qat-w4a16-ct \
  --max-model-len 16384 \
  --gpu-memory-utilization 0.55 \
  --enable-auto-tool-choice \
  --reasoning-parser gemma4 \
  --tool-call-parser gemma4 \
  --limit-mm-per-prompt '{"image":0,"audio":0}' \
  --attention-backend TRITON_ATTN
```

`--gpu-memory-utilization 0.55` leaves ~14 GB for Vulkan Whisper + graphs.
Full 0.90 will evict STT.

vLLM wins later if you add a second card or concurrent chat. For phase 0/1
voice, llama.cpp + MTP is the better single-stream path.

This host has **two** R9700s. DRM `cardN` swaps; pin by PCI / by-path:

| Role | PCI | by-path render | HIP/ROCR | Vulkan |
|------|-----|----------------|----------|--------|
| Display (Hyprland, DP-4 Dell) | `0000:03:00.0` | `renderD128` | **0 — never** | 0 |
| Compute (no monitor) | `0000:07:00.0` | `renderD129` | **1** | 1 |

`scripts/lib/llama-cpp-env.sh` `pin_rocm_compute_gpu` refuses `renderD128`.
Do not run `rocminfo`, `llama-server`, or `llama-bench` unpinned — that wakes
the idle card and DRM-hotplugs Hyprland. Do not split 12B across both cards.

## 31B analyst

Do **not** enable 31B until `./scripts/check-analyst-vram.sh` says OK (or you
accept model swap). 32 GB is **not** enough for 12B + 31B + Whisper resident.

| Approx free VRAM | Action |
|------------------|--------|
| &lt; 20 GB | 12B only |
| 20–24 GB | 31B only with swap (unload 12B) |
| ≥ ~48 GB | optional concurrent (32 GB + Whisper OOMs) |

## Bench protocol (~30 minutes)

```bash
./scripts/bench-llama-cpp-gemma4.sh
```

Pass criteria for a secretary bot:

- Decode ≥ 60 tok/s with thinking off (you should beat this)
- TTFT &lt; 150 ms on an 8K prompt
- Whisper still healthy under music (`./scripts/voice-under-music-check.sh`)
- `amd-smi` / `rocm-smi` peak &lt; 24 GB so you have a buffer

## Installer

```bash
./install.sh --edition server --llm llamacpp --with-rag --with-voice
./scripts/detect-gpu.sh
```

## Fallback: host Ollama (ROCm)

Only if llama.cpp is blocked:

```bash
ollama serve
ollama pull hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL
```

Docker `ollama/ollama:rocm` (`docker-compose.server.rocm.yml`) is the same
fallback, not the default.
