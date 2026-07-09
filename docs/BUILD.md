# Moneypenny — build list

Living backlog of next implementation work. Design sketches link out; this is the
ordered **do list**, not full specs.

Product sequence and locked decisions: **[feature-roadmap.md](./feature-roadmap.md)**
(harness-first, Station via feedback, Vue polish, brain boundary plan-only).

**Last updated:** 2026-07-09 (harness-first sequence locked)

---

## Now / next (priority)

Harness-first queue from [feature-roadmap.md](./feature-roadmap.md) §6 — Station
bugs still interrupt from live feedback.

| ID | Item | Notes | Status |
|----|------|--------|--------|
| **H1** | Chat-first dashboard panel | `/harness` + `POST /api/bot/harness/ask` | **Shipped** 2026-07-09 |
| **H2** | Cited answers in UI | Sources + classification on harness turns | **Shipped** 2026-07-09 |
| **H5** | Tool transparency | Intent mode tool records on harness panel | **Shipped** 2026-07-09 |
| **R4** | Org KG seed path | `POST /api/bot/org-kg` + `searchOrg` for memory bumper | **Shipped** 2026-07-09 |
| **R1–R2** | Topic packs + ingest hygiene | mining profile topics; `GET …/doctrine/hygiene` | **Shipped** 2026-07-09 |
| **G1–G2** | Org commands + SC/external status tools | `!ops` + fail-open plugins | **Shipped** 2026-07-09 |
| **Brain** | Python brain boundary sketch | [brain-boundary.md](./brain-boundary.md) only | **Shipped** (doc) |
| **V1** | Voice under music smoke | Feedback-driven; text fallback always works | Partial / deferred |
| **S\*** | Station polish | Continuous via user feedback (not a gate) | Ongoing |

### Recently closed build items (2026-07)

| ID | Item | Notes | Status |
|----|------|--------|--------|
| **A1** | ACE-Step client + health + config keys | `bot/src/music/ace-step-client.ts` | **Shipped** |
| **A2** | `!generate` → job → library → play | `GenerateProvider` + rights `generate` | **Shipped** |
| **A3** | Settings panel for ACE-Step | Enable, URL, Check status | **Shipped** |
| **A4** | Radio auto-fill | Dead air empty pool → gen; `!radio gen` | **Shipped** |
| **A5** | Prune + tags | Max files, `!generate prune`, prompt tags | **Shipped** |
| **A6** | Host docs + adapter | Mock CI stub; non-mock needs `ACE_STEP_WORKER_URL` | **Shipped** (worker contract; no GPU weights in CI) |
| **Duck** | Softer music duck default 25 | Migrates legacy 2 | **Shipped** |
| **Web-gen** | Library Generate button | `POST /api/bot/ace-step/generate` | **Shipped** |
| **R-R6** | Icecast tee + relay-in + Spotify/Tidal playlist | Bridges + bot fail-open; Spotify audio needs librespot | **Shipped** (contract + unit tests; live audio/ops optional) |
| **Spotify** | librespot bridge service | Metadata/playlist via Web API; audio via `LIBRESPOT_HTTP_BASE` | **Shipped** (health splits audio vs metadata) |
| **Tags-depth** | Embedded ID3 seed + bulk tags + rating weight + harmonic | See CHANGELOG flesh-out | **Shipped** |
| **Radio-color** | Music AM/FM/… color overlay | Settings + `radio.audioColor` | **Shipped** |
| **Bumper-prewarm** | TTS cache pre-generate | Settings + `!radio prewarm` | **Shipped** |
| **Presence-gate** | Human count for scheduled bumpers | `countChannelHumans` + refresh on boundary | **Shipped** (fixes silent skip of every-N bumpers) |
| **Docs-UI** | radio.md scrub + Settings/Library tooltips | Hover titles on Radio/DJ + Track tags | **Shipped** |
| **STT-large** | Whisper large-v3 selectable | `stt-models.ts` + server compose | **Shipped** |
| **STT-int8** | RKNN INT8 quant path | `STT_COMPUTE_TYPE=int8` + health | **Shipped** |
| **ACE-compose** | Adapter compose profile | `docker-compose.ace-step.yml` | **Shipped** |
| **Vue-crit** | Admin login critical path | `bot/web/src/e2e/admin-login.e2e.test.ts` (vitest/happy-dom, **not** browser E2E) | **Shipped** |
| **R-live** | Radio live smoke on opi5 | Host health + STT/TTS; in-repo `!radio ops` | **Partial** (ops notes + unit substitutes; full TS under-music smoke optional) |
| **V-live** | Voice under music on Pi | base NPU loaded; duck 25; command-shape tests | **Partial** (same) |

---

## Recently shipped (reference)

| Item | Notes |
|------|--------|
| Radio presence gate fix + gate logging | See [docs/radio.md](./radio.md) “Presence gate” |
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
