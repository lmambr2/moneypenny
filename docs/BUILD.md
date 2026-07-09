# Moneypenny — build list

Living backlog of next implementation work. Design sketches link out; this is the
ordered **do list**, not full specs.

**Last updated:** 2026-07-08 (evening)

---

## Now / next (priority)

| ID | Item | Notes | Status |
|----|------|--------|--------|
| **A1** | ACE-Step client + health + config keys | `bot/src/music/ace-step-client.ts` | **Shipped** |
| **A2** | `!generate` → job → library → play | `GenerateProvider` + rights `generate` | **Shipped** |
| **A3** | Settings panel for ACE-Step | Enable, URL, Check status | **Shipped** |
| **A4** | Radio auto-fill | Dead air empty pool → gen; `!radio gen` | **Shipped** |
| **R-live** | Radio live smoke on opi5 | Bumpers, `!radio ops` | Queued (ops) |
| **V-live** | Voice round-trip under music on Pi | Base NPU already default | Queued (ops) |

---

## Recently shipped (reference)

| Item | Notes |
|------|--------|
| Library scroll + track delete | Full library panel, admin delete |
| Phase 7 memory A1–A5 | docs/memory.md, voice remember, radio org bumper, install `--with-memory` |
| Phase 8 roast polish | `!roastin`, capture hygiene, docs/roast.md |
| Voice under-music polish | Duck volume + listen window Settings |
| Radio Settings | Bumper sources + org memory on air |
| Dual editions + dual-track STT | SBC base NPU / Server medium Vulkan |
| V2 drop sherpa/Kokoro | Whisper + Piper only |
| **@dj tag edit (web)** | PATCH tags: admin **or** `radio.tags` rights |
| Deploy excludes | No rsync of convert venv/vendor/hf |

---

## ACE-Step — PR order (from sketch)

See [ace-step.md](./ace-step.md) §9:

1. **A1** Client + config + health — **done**
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
- INT8 quant path for RKNN Whisper
