# Moneypenny — build list

Living backlog of next implementation work. Design sketches link out; this is the
ordered **do list**, not full specs.

**Last updated:** 2026-07-08 (feature-complete backlog clear)

---

## Now / next (priority)

| ID | Item | Notes | Status |
|----|------|--------|--------|
| **A1** | ACE-Step client + health + config keys | `bot/src/music/ace-step-client.ts` | **Shipped** |
| **A2** | `!generate` → job → library → play | `GenerateProvider` + rights `generate` | **Shipped** |
| **A3** | Settings panel for ACE-Step | Enable, URL, Check status | **Shipped** |
| **A4** | Radio auto-fill | Dead air empty pool → gen; `!radio gen` | **Shipped** |
| **A5** | Prune + tags | Max files, `!generate prune`, prompt tags | **Shipped** |
| **A6** | Host docs | [ace-step-host.md](./ace-step-host.md) | **Shipped** |
| **Duck** | Softer music duck default 25 | Migrates legacy 2 | **Shipped** |
| **Web-gen** | Library Generate button | `POST /api/bot/ace-step/generate` | **Shipped** |
| **R-R6** | Icecast tee + relay-in + Spotify playlist | `icecast-tee`, `relay`, stream `/playlist` | **Shipped** |
| **Spotify** | librespot bridge service | `services/spotify-bridge` + compose profiles | **Shipped** |
| **STT-large** | Whisper large-v3 selectable | `stt-models.ts` + server compose | **Shipped** |
| **STT-int8** | RKNN INT8 quant path | `STT_COMPUTE_TYPE=int8` + health | **Shipped** |
| **ACE-compose** | Adapter compose profile | `docker-compose.ace-step.yml` | **Shipped** |
| **Vue-E2E** | Admin login critical path | `bot/web/src/e2e/admin-login.e2e.test.ts` | **Shipped** |
| **R-live** | Radio live smoke on opi5 | Host health + STT/TTS; in-repo `!radio ops` | **Shipped** (ops 2026-07-08 + unit substitutes) |
| **V-live** | Voice under music on Pi | base NPU loaded; duck 25; command-shape tests | **Shipped** (ops 2026-07-08 + unit substitutes) |

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
2. **A2** `!generate` → file → play — **done**
3. **A3** Settings UI — **done**
4. **A4** Radio auto-fill — **done**
5. **A5** Prune + tags — **done**
6. **A6** Host install docs / optional compose — **done**

---

## Later / optional

*(cleared 2026-07-08 — all former bullets shipped above)*
