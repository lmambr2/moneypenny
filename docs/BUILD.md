# Moneypenny — build list

Living backlog of next implementation work. Design sketches link out; this is the
ordered **do list**, not full specs.

**Last updated:** 2026-07-08

---

## Now / next (priority)

| ID | Item | Notes | Status |
|----|------|--------|--------|
| **P0** | Poke as command channel | TS poke → ControlRouter; rights + rate limit; poke-back ack. | **Shipped** |
| **A\*** | ACE-Step music gen | Design: [ace-step.md](./ace-step.md). Optional sidecar; `!generate` / radio auto-fill. | **Sketch done** |
| **V1** | Server whisper.cpp Vulkan smoke | AMD R9700 + CachyOS/podman: image builds, `/health` device=vulkan, JFK ASR OK | **Done** |
| **V2** | Drop sherpa/Kokoro | Removed compose services, install legacy flag, `services/sherpa-stt` | **Done** |
| **R-live** | Radio live smoke on opi5 | Bumpers, `!radio ops` | Queued |

---

## Recently shipped (reference)

| Item | Notes |
|------|--------|
| Dual editions (SBC / Server) | compose overlays, install wizard, RELEASES |
| Dual-track STT | stt-rknn (NPU) + stt-whisper-cpp; Piper TTS |
| RKNN Whisper base on Pi | Live ASR smoke; health `engine=rknn model=base` |
| 31B analyst opt-in | Settings toggle; VRAM helper |
| AMD packaging docs | [gpu-amd.md](./gpu-amd.md) |
| Security F1–F11 + STT alias removal | See CHANGELOG |

---

## Poke commands — shipped

1. Library event `poked` → `TS3Client` emits `poke`.
2. `PokeHandler` → `routeVoice` (prefix optional) → same rights/execute as chat.
3. Config: `pokeCommandsEnabled` (default on), `pokeCommandsPerMinute` (default 12).
4. Settings → AI & Permissions → Poke commands toggle.
5. Reply: poke-back (truncated); channel mirror for now-playing / long replies.

**Non-goals still:** multi-line pokes; privilege via poke.

---

## ACE-Step — PR order (from sketch)

See [ace-step.md](./ace-step.md) §9:

1. **A1** Client + config + health  
2. **A2** `!generate` → file → play  
3. **A3** Settings UI  
4. **A4** Radio auto-fill  
5. **A5** Prune + tags  
6. **A6** Host install docs / optional compose  

---

## Later / optional

- Icecast tee / relay-in (radio R-R6)
- Spotify librespot bridge
- Vue E2E
- Whisper large-v3 on server when VRAM free
- INT8 quant path for RKNN Whisper (currently FP tiny)
