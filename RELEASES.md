# Releases — SBC and Server editions

Moneypenny ships **two editions from one git tree**. There is no separate
fork; overlays + install flags select the product shape.

| Artifact | Edition | Target |
|----------|---------|--------|
| `moneypenny-sbc-<ver>.tar.gz` | **sbc** | Orange Pi 5 Max / RK3588 arm64 |
| `moneypenny-server-<ver>.tar.gz` | **server** | x86_64 Linux (AMD preferred; NVIDIA untested) |

Full product matrix: [docs/editions.md](./docs/editions.md).

---

## What each release contains

Both tarballs include:

- Bot source + Dockerfiles (`bot/`, `services/`)
- Base compose + **edition overlay** (`docker-compose.yml` + `.sbc.yml` / `.server.yml`)
- Edition env template (`.env.example.sbc` / `.env.example.server`)
- `install.sh`, `scripts/detect-edition.sh`, `scripts/package-release.sh`
- Operator docs (`DESIGN.md`, `ROADMAP.md`, `docs/*`)

Excluded from packages (filled on first install / host):

- `bot/node_modules`, `bot/dist`, `bot/web/node_modules`
- `bot/data/*` runtime state, `.env` secrets
- Large model weights under `models/` (except optional small fixtures)
- Git history (source tarball is a filtered export)

---

## Build packages (maintainer)

From a clean checkout of the release tag:

```bash
./scripts/package-release.sh              # both editions, version from git describe
./scripts/package-release.sh --edition sbc
./scripts/package-release.sh --edition server --version 1.2.0
```

Outputs land in `dist/release/`:

```
dist/release/moneypenny-sbc-vX.Y.Z.tar.gz
dist/release/moneypenny-server-vX.Y.Z.tar.gz
dist/release/SHA256SUMS
dist/release/MANIFEST-sbc.txt
dist/release/MANIFEST-server.txt
```

Validate without uploading:

```bash
./scripts/package-release.sh --dry-run
docker compose -f docker-compose.yml -f docker-compose.sbc.yml config >/dev/null
docker compose -f docker-compose.yml -f docker-compose.server.yml config >/dev/null
```

---

## Install from a release tarball

### SBC (Orange Pi)

```bash
tar -xzf moneypenny-sbc-vX.Y.Z.tar.gz
cd moneypenny-sbc-vX.Y.Z
./install.sh --edition sbc --with-rag --with-voice -y
# Fast chat: Settings → llmUrl → LAN Ollama 12B (docs/remote-llm.md)
```

### Server (x86)

```bash
tar -xzf moneypenny-server-vX.Y.Z.tar.gz
cd moneypenny-server-vX.Y.Z
./install.sh --edition server --with-rag --with-voice -y
# Optional: ollama pull hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL for !analyst
```

### From git (same result)

```bash
git clone https://github.com/lmambr2/moneypenny.git && cd moneypenny
git checkout vX.Y.Z   # or dev
./install.sh --edition auto --with-rag --with-voice
```

---

## Default stacks

### SBC edition

| Service | Profile | Default |
|---------|---------|---------|
| bot | core | always |
| ollama | ollama | E2B fallback + nomic-embed-text-v2-moe |
| turbovec | rag | vectors on-device (TurboQuant) |
| stt-whisper | voice-edge | `STT_MODEL=base` (RKNN NPU) |
| piper-tts | voice-edge | southern English female |
| rkllama | npu | **opt-in** offline chat only |

### Server edition

| Service | Profile | Default |
|---------|---------|---------|
| bot | core | always |
| ollama | ollama | Gemma 4 **12B** (+ embed) |
| turbovec | rag | on-device (TurboQuant) |
| stt-whisper | voice-server | `medium` (Vulkan on AMD; large-v3 optional) |
| piper-tts | voice-server | same British voice |

---

## Versioning

- Git tags: `vMAJOR.MINOR.PATCH`
- Both editions share the same version number (same bot code).
- Breaking compose/env changes are called out in [CHANGELOG.md](./CHANGELOG.md).
- Default branch for day-to-day work: `dev`; cut releases from `main` or a tag.

---

## Smoke checklist (after install)

1. `docker compose ps` — bot healthy; edition services up
2. Web UI http://localhost:3000 — create admin
3. Settings → LLM status reachable
4. `!play` local or YouTube smoke
5. With RAG: upload a `.md`, `!ask` returns `📎 Sources:`
6. With voice: Settings voice on + `textWakeFallback`; speak a skip
7. **Optional MCP (Grok Build):** set `MCP_ENABLED=1` + long `MCP_TOKEN` in `.env`,
   recreate bot, point Grok at `http://<host>:3000/mcp` with Bearer token
   (see [docs/mcp-server.md](./docs/mcp-server.md), `.grok/config.toml.example`).
   Smoke: `status_now_playing` / `music_play` from Grok; admin UI audit log shows
   `mcp.tool` / `mcp.tool.denied` entries.
