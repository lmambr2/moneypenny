# ACE-Step host setup (LAN GPU)

Run ACE-Step on a **Server / workstation** (e.g. AMD GPU box), not the Orange Pi.
The bot only needs HTTP + optional shared `MUSIC_DIR`.

See also: [ace-step.md](./ace-step.md) (product design), [gpu-amd.md](./gpu-amd.md).

---

## 1. What the bot expects

| Endpoint | Role |
|----------|------|
| `GET /health` | `{ "ok": true, "engine": "ace-step", "busy": false }` |
| `POST /v1/generate` | Body: `{ prompt, durationSec?, tags? }` → `{ id, status }` |
| `GET /v1/jobs/:id` | `{ id, status: queued\|running\|done\|error, path?, error? }` |
| `GET /v1/jobs/:id/audio` | Raw audio bytes if **not** using shared filesystem |

**Shared FS (preferred):** write finished files into a path the bot mounts as  
`MUSIC_DIR/generated/ace-step/…` and set `path` on the job to a **relative** path  
under `MUSIC_DIR` (e.g. `generated/ace-step/2026-….mp3`).

**HTTP fallback:** leave `path` null; bot downloads `/audio` into that subdir.

---

## 2. Minimal adapter sketch

If you run upstream ACE-Step / Gradio / a custom API, put a thin **adapter** in front
that maps to the table above. Example layout:

```text
gpu-host:7865  ← adapter (this contract)
       │
       └─► acestep worker / Python API
```

Pin versions in your own repo; Moneypenny only talks HTTP.

---

## 3. Docker (host-side adapter — shipped)

Repo files:

| Artifact | Role |
|----------|------|
| [`docker-compose.ace-step.yml`](../docker-compose.ace-step.yml) | Profile `ace-step` on the GPU host |
| [`services/ace-step-adapter/`](../services/ace-step-adapter/) | HTTP adapter (`/health`, `/v1/generate`, jobs + audio) |

```bash
# On the GPU host (shared MUSIC_DIR with the bot mount recommended)
export MUSIC_DIR=/srv/moneypenny-music
export ACE_STEP_MOCK=1   # stub audio without a full ACE-Step GPU stack
docker compose -f docker-compose.ace-step.yml --profile ace-step up -d --build
# → http://<gpu-host>:7865/health
```

GPU drivers vary — edit the compose file for NVIDIA (`deploy.resources`) or AMD
ROCm (`/dev/kfd`, `/dev/dri`). Pin `ACE_STEP_IMAGE` when you have a real worker
image; the default adapter builds from `services/ace-step-adapter`.

Firewall: allow the bot host (Pi/server) to reach `gpu:7865`; do not expose
publicly without auth.

---

## 4. Wire Moneypenny

**Settings → ACE-Step music gen**

| Field | Example |
|-------|---------|
| Enabled | on |
| URL | `http://192.168.1.89:7865` |
| Timeout | `300000` (5 min) |
| Output subdir | `generated/ace-step` |
| Max files keep | `40` (0 = never prune) |
| Radio auto-fill | on if dead-air gen is wanted |

Or env (optional): `ACE_STEP_URL=http://192.168.1.89:7865` when `aceStepEnabled` is true.

**Rights:** `@dj` / admin for `!generate` and `!radio gen`.

**Commands**

```text
!generate late night focus, 110 bpm, no vocals
!generate prune
!radio gen chill synthwave bed
```

---

## 5. VRAM / concurrency

- Bot enforces **1 concurrent** gen.
- Keep **31B analyst** and ACE-Step from thrashing: prefer not running both full-blast.
- See [gpu-amd.md](./gpu-amd.md) for host Ollama notes.

---

## 6. Smoke

```bash
curl -sS http://GPU:7865/health
# from TS as DJ:
!generate soft ambient pad 90 bpm
# file appears under MUSIC_DIR/generated/ace-step/
!generate prune
```

If health is red in Settings → Check, fix URL/firewall before blaming the bot.
