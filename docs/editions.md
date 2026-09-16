# Moneypenny editions — SBC and Server

One repository, one bot binary, **two product editions**. Same contracts
(OpenAI `/v1`, Whisper STT HTTP, Piper TTS HTTP, **TurboVec** vectors, rank gating).
Different **compose overlays, defaults, and host expectations**.

**Supported hosts (now):** Orange Pi / RK3588 (**SBC**) and **x86_64 Linux** with
**AMD** GPU (Radiance vLLM Qwen3.8 on dual R9700, or host Ollama / llama.cpp HIP
on a single card). NVIDIA compose paths may exist but are **untested** and
**not** used on the production desk. macOS / Apple Silicon is **out of scope**.
PersonaPlex duplex on AMD is moshi.cpp Vulkan, **RTF-gated**; default voice
remains cascaded Whisper+Piper.

**Bot primary host** = whichever machine you install: **`--edition sbc`** or
**`--edition server`**. The bot (TS client, music, rights, web UI, RAG index)
always co-locates with that install. Chat may still point at a remote OpenAI-compatible host.

| | **SBC** | **Server** |
|---|---|---|
| **Hardware** | Orange Pi 5 Max / RK3588, 16 GB, arm64 | x86_64 Linux, **AMD** GPU preferred (one card now; dual R9700: GPU0 desk / GPU1 Penny — [gpu-amd.md](./gpu-amd.md)) |
| **Bot primary host** | **Yes** — this install path | **Yes** — this install path |
| **Typical stack** | bot + embed + TurboVec + edge voice; chat often LAN Radiance / 12B | bot + embed + TurboVec + voice + **Radiance Qwen3.8** (dual R9700) or host Ollama / llama.cpp 12B; optional **TS6** |
| **Chat LLM** | LAN **Qwen3.8** (Radiance) or **Gemma 4 12B QAT**; on-device **E2B** fallback | Dual-R9700: **Radiance** `Qwen3.8` on the infer GPU (`:8080`). Single GPU: host Ollama or llama.cpp HIP Gemma 4 **12B**. 31B analyst is opt-in. |
| **Embeddings / vectors** | On this host (`nomic-embed-text-v2-moe` + TurboVec) | On this host. Dual-R9700: CPU Ollama `:11435` + **nomic 768-d** (match TurboVec). Do not switch to bge-large (1024-d) without a re-embed. |
| **STT (dual track)** | **`stt-rknn`**: RKNN NPU **base** → faster-whisper CPU fallback | **`stt-whisper-cpp`**: whisper.cpp **large-v3-turbo** Vulkan. With Radiance, bind the **display** GPU (`GGML_VK_VISIBLE_DEVICES=0`, `docker-compose.voice-radiance.yml`) |
| **TTS** | Piper `en_GB-cori-medium` (CPU; SBC) | Piper `en_GB-cori-high` (CPU; medium fail-open) |
| **NPU** | **RKNN Whisper** priority; offline chat opt-in only | N/A |
| **Compose files** | `docker-compose.yml` + `docker-compose.sbc.yml` | `docker-compose.yml` + `docker-compose.server.yml` |
| **Installer** | `./install.sh --edition sbc` | `./install.sh --edition server` |

See also: [voice-backends.md](./voice-backends.md), [remote-llm.md](./remote-llm.md),
[rag-embeddings.md](./rag-embeddings.md), [RELEASES.md](../RELEASES.md),
[DESIGN.md](../DESIGN.md) §Editions.

---

## Where the bot lives

The **bot primary host is the machine you install on**:

| Install path | Bot runs on | Typical chat |
|--------------|-------------|--------------|
| `--edition sbc` | **SBC (Pi)** | LAN Radiance `:8080` or llama.cpp `:11434`; local **E2B** if offline |
| `--edition server` | **x86 Server** | Local Radiance Qwen3.8 (dual R9700) or llama.cpp 12B (+ 31B analyst if fits) |

You do **not** run two bot primaries for one TS identity — pick one install path
per deployment. The other machine can still host **only** Ollama (or only be
unused).

**Split-brain storage rule:** `llmUrl` may be remote; **embeddings + TurboVec stay
on the bot host** (whichever edition you installed).

```
        ┌─ install --edition sbc ─────────────────────────┐
        │  BOT · music · rights · embed · turbovec · voice │
        │  llmUrl ──► (optional) Server Radiance / 12B    │
        │  fallback · local E2B                           │
        └─────────────────────────────────────────────────┘

        ┌─ install --edition server ──────────────────────┐
        │  BOT · music · rights · embed · turbovec · voice │
        │  Radiance Qwen3.8 (infer) or llama.cpp 12B      │
        │  Whisper Vulkan (display GPU if Radiance) · piper CPU │
        └─────────────────────────────────────────────────┘
```

---

## Topology A — bot on SBC (split-brain chat)

```
SBC: bot + embed + turbovec + tiny STT + piper
  └─ llmUrl → Server Radiance :8080 (Qwen3.8) or llama.cpp :11434 (12B)
  └─ llmFallbackUrl → local E2B
```

Server may run **only** Radiance / llama.cpp (and optionally TS6), or a full
Server edition if that is the bot host instead (not both bots).

## Topology B — bot on Server (all-in-one)

Everything on the x86 box: bot + Radiance or llama.cpp + voice + RAG + optional **TS6**.
No Pi required. Pi can still hold a spare SBC install for offline/edge later.

## Topology C — bot on SBC, fully offline

Local E2B (or opt-in NPU chat). Slow chat; RAG/voice edge stack still works.

---

## Install

```bash
# Interactive wizard (TTY)
./install.sh

# Non-interactive
./install.sh --edition server --with-rag --with-voice -y
./install.sh --edition sbc --with-rag --with-voice \
  --llm http://192.168.x.x:11434 \
  --model hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL -y
```

Voice is intended **on by default** once install defaults are aligned.
Prefer **host llama.cpp HIP** on the Server for AMD; Ollama is a fallback
(docs/gpu-amd.md).

```bash
./scripts/detect-edition.sh
```

---

## Compose profiles by edition

| Profile | SBC default stack | Server default stack |
|---------|-------------------|----------------------|
| `core` | when bot on Pi | always (primary) |
| `ollama` | E2B fallback + embed (or host LLM via URL) | embeddings only if host llama.cpp |
| `rag` | if bot on Pi (`turbovec`) | recommended |
| `voice-edge` | recommended | — |
| `voice-server` | — | recommended (→ Vulkan path on AMD) |
| `server` | rare | **TS6** when co-located |
| `npu` | opt-in offline / future RKNN host prep | never |

`install.sh` writes `COMPOSE_PROFILES` and `COMPOSE_FILE` into `.env`.

---

## What is *not* different between editions

- Bot TypeScript codebase and web UI
- Rank gating, radio, roast, doctrine RAG ingest paths
- STT/TTS HTTP contracts
- Security posture (localhost binds, CSRF, rights in executor)
- HTTP app (Express plugins), `@moneypenny/ts6-client`, brain `/v1/turn`

Only **where models run**, **STT backend**, and **default profiles** change.

---

## Explicitly out of scope (for now)

- **macOS / Apple Silicon** as an install or GPU target
- Day-to-day chat on RK3588 NPU
- Shipping sherpa/Kokoro (removed V2 — Whisper + Piper only)
- NVIDIA as a first-class tested path (docs may mention; untested here)
