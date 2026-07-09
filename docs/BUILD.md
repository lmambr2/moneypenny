# Moneypenny — build list

Living backlog of next implementation work. Design sketches link out; this is the
ordered **do list**, not full specs.

**Last updated:** 2026-07-08

---

## Now / next (priority)

| ID | Item | Notes | Status |
|----|------|--------|--------|
| **P0** | Poke as command channel | TS poke → same ControlRouter as chat; rights + rate limit; optional poke-back ack. Client already has `on("poke")` / `poke()`. | **Queued** |
| **A\*** | ACE-Step music gen | Design: [ace-step.md](./ace-step.md). Optional sidecar; `!generate` / radio auto-fill. | **Sketch done** |
| **V1** | Server whisper.cpp Vulkan smoke | On AMD host (.89): ggml download + voice-server profile | Queued |
| **V2** | Drop sherpa/Kokoro | After dual-track voice stable in ops | Queued |
| **R-live** | Radio live smoke on opi5 | Bumpers, `!radio ops` | Queued |

---

## Recently shipped (reference)

| Item | Notes |
|------|--------|
| Dual editions (SBC / Server) | compose overlays, install wizard, RELEASES |
| Dual-track STT | stt-rknn (NPU) + stt-whisper-cpp; Piper TTS |
| RKNN Whisper tiny on Pi | Live ASR smoke with zoo test wav |
| 31B analyst opt-in | Settings toggle; VRAM helper |
| AMD packaging docs | [gpu-amd.md](./gpu-amd.md) |
| Security F1–F11 + STT alias removal | See CHANGELOG |

---

## Poke commands — acceptance sketch

1. Bind `client.on("poke", …)` next to text-message handling.
2. Parse poke body as command line (`!` optional).
3. Resolve invoker → rights subject (same as chat).
4. `ControlRouter.route` / deterministic path; no rights bypass.
5. Config: `pokeCommandsEnabled` (default **on**).
6. Rate limit per invoker; deny message via private chat or poke-back.
7. Tests: mock poke → skip / denied / ask.

**Non-goals:** multi-line pokes, poke from unauthenticated sources, privilege via poke.

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
