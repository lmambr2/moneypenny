# Moneypenny — build list

Living backlog of next implementation work. Design sketches link out; this is the
ordered **do list**, not full specs.

Product sequence and locked decisions: **[feature-roadmap.md](./feature-roadmap.md)**
(harness-first, Station via feedback, Vue polish, brain boundary plan-only).

**Last updated:** 2026-07-09 (reliability S-OC1–3 + RAG/memory P1–P5 foundations)

---

## Reliability (S-OC) — shipped

| ID | Item | Status |
|----|------|--------|
| **S-OC3** | Event reconnect + exp backoff | **Shipped** |
| **S-OC2** | Voice transport self-heal | **Shipped** |
| **S-OC1** | TTS barge-in (speech-only) | **Shipped** |

## RAG / memory / intent (P1–P5) — foundations shipped, flags off

| ID | Item | Status |
|----|------|--------|
| **P2** | Typed budgets + injection dedup | **Shipped** (ask path) |
| **P5** | Memory eval axes skeleton | **Shipped** |
| **P1** | Claim-check RAG | **Shipped** (default off) |
| **P4** | Clarify-once | **Shipped** (default off) |
| **P3** | Playbooks store | **Shipped** (capture/retrieve; inject optional) |

See [rag-claim-check-and-typed-memory.md](./rag-claim-check-and-typed-memory.md).

---

## Now / next (priority)

Harness-first sequence from [feature-roadmap.md](./feature-roadmap.md) §6 — Station
bugs still interrupt from live feedback.

### Economy — community code lifts (implement next)

Ideas distilled from SuperCargo / HAULER OPS (MIT fan tools). **Reimplement pure
TS** in `bot/src/economy/` — no vendored Electron/OCR, no scrapers. Accept
criteria: [economy.md §6a](./economy.md).

| Order | ID | Item | Notes | Status |
|------:|----|------|--------|--------|
| 1 | **E-BOX** | SCU → fewest crates | Pure `calculateBoxes` / `splitIntoContainers` style: e.g. `64` → `2×32`. Surface on `!work-items` / craft totals + dashboard shopping list. Standard crate sizes only (1–32 SCU). | **Shipped** 2026-07-09 |
| 2 | **E-FUZZY** | Fuzzy name match | Typo/confusable match for seed ores, trade ships/shops, craft search — SuperCargo `fuzzy.ts` idea, small pure function. | **Shipped** 2026-07-09 |
| 3 | **E-UEX-SUP** | UEX supply / richer prices | Per-commodity `commodities_prices` + supply % + top terminals; 12h L2 TTL (`UEX_PRICES_CACHE_TTL_MS`). | **Shipped** 2026-07-09 |
| 4 | **E-FOOT** | Box footprints + "fits ship?" | Crate grid cells + ship max-box helpers; trade ships list shows largest crate; `GET /api/economy/boxes`. | **Shipped** 2026-07-09 |
| — | **E-SNAP** | Ships/locations offline seed | SuperCargo snapshot pattern — largely covered by **E-CACHE** SWR; only if cold-start still hurts. | **Optional / park** |

**PR sketch:** `E-BOX` (+ tests) → `E-FUZZY` → `E-UEX-SUP` (or key env only) → `E-FOOT`.

### Economy backlog (ops feedback — park until wanted)

Full notes: [economy.md §6](./economy.md). Shopping list + **dashboard `/economy`** shipped; do not re-guidebook.

| ID | Item | Notes | Status |
|----|------|--------|--------|
| **E-UI** | Economy dashboard | `/economy` + `/api/economy/*` (work orders, craft, trade routes/buyers/itinerary/circuit, prices, catalog, cache); residual tests + clear rights | **Shipped** 2026-07-09 |
| **E-UEX-KEY** | UEX API key | Optional `UEX_API_KEY` — commodities works without key today; get free app token for prod/etiquette. **Parked for Lane decision.** → [economy.md § Decision: UEX key](./economy.md) | **Decision later** |
| **E-CACHE** | SQLite L2 cache | `economy_cache` table in main DB; SWR; craft detail + trade routes on L2; JSON migrate | **Shipped** 2026-07-09 |
| **E-RAW** | Reverse refine → raw ore | From work-item totals × method yield → raw SCU; opt-in only. Miners over-mine for quality anyway. | **Backlog** |
| **E-SIG** | Node sensor signatures | Possible rock/node sigs + rocks/node for a given ore (offline planning). Ops have a Python script — port/seed later. | **Backlog** |
| **E-STN** | Station refine modifiers | HUR-L1 vs Seraphim-style yield deltas after method rates trusted. | **Backlog** |

| ID | Item | Notes | Status |
|----|------|--------|--------|
| **H1** | Chat-first dashboard panel | `/harness` + `POST /api/bot/harness/ask` | **Shipped** 2026-07-09 |
| **H2** | Cited answers in UI | Sources + classification on harness turns | **Shipped** 2026-07-09 |
| **H5** | Tool transparency | Intent mode tool records on harness panel | **Shipped** 2026-07-09 |
| **R4** | Org KG seed path | `POST /api/bot/org-kg` + `searchOrg` for memory bumper | **Shipped** 2026-07-09 |
| **R1–R2** | Topic packs + ingest hygiene | mining profile topics; `GET …/doctrine/hygiene` | **Shipped** 2026-07-09 |
| **G1–G2** | Org commands + SC/external status tools | `!ops` + fail-open plugins | **Shipped** 2026-07-09 |
| **Brain** | Python brain boundary sketch | [brain-boundary.md](./brain-boundary.md) only | **Shipped** (doc) — **not** implement |
| **H3** | Memory scopes UI | Harness dual wall + `/api/bot/memory/scopes` | **Shipped** 2026-07-09 |
| **V1/H4** | Voice under music | `under-music.ts` + API + script | **Shipped** 2026-07-09 |
| **G2 depth** | SC org client | Settings URL + `docs/sc-org-status.md` | **Shipped** 2026-07-09 |
| **R3** | RAG eval loop | `eval-loop.ts` + API + `scripts/rag-eval.mjs` | **Shipped** 2026-07-09 |
| **H6** | Channel/server scope config | `scope` settings + Live status | **Shipped** 2026-07-09 |
| **G3** | Member read-only Live | `GET /api/bot/live` + `/live` Vue | **Shipped** 2026-07-09 |
| **G4** | Moderation hooks | `!mute` / `!kick` rights-gated, fail-open | **Shipped** 2026-07-09 |
| **R5** | SC members/fleet | `!ops members` / `!ops fleet` via ScOrgClient | **Shipped** 2026-07-09 |
| **V2** | STT ladder docs | [voice-backends.md](./voice-backends.md) matches editions | **Shipped** (docs accuracy) |
| **V3** | Spoken radio status | `!radio speak-status` / `announce` | **Shipped** 2026-07-09 |
| **Hardening** | Audit leftovers 2026-07-09 | LLM admin, XFF hops, ACE loopback, harness dry-run, private-memory audit | **Shipped** 2026-07-09 |
| **Recordings** | Dashboard capture/upload | Opt-in `data/recordings/` + `/recordings` | **Shipped** 2026-07-09 |
| **V4** | Voice orchestration extract | FastAPI voice-turn | **Deferred** (plan only) |
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
