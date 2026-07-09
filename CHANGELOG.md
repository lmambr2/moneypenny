# Changelog

Notable changes to Moneypenny. Dates are when the work landed on `main`.

This project is developed with AI coding assistants; this log records **which
assistant** authored each batch of work, since not every commit carries a
`Co-Authored-By` trailer. Attribution here is the source of truth.

## 2026-07-08

### ACE-Step A4 — radio auto-fill
**Author: Grok (xAI), driven by Lane Ambrose.**

- Dead air / empty profile pool → ACE-Step when `aceStepAutoFill` (fail-open)
- `!radio gen <prompt>` alias; prompt from profile tone/topics/seeds

### ACE-Step A3 — Settings UI
**Author: Grok (xAI), driven by Lane Ambrose.**

- Settings → ACE-Step: enable, URL, timeout, output dir, auto-fill flag
- `GET /api/bot/ace-step/status` health probe; live apply via `updateAceStep`

### ACE-Step A2 — !generate → library → play
**Author: Grok (xAI), driven by Lane Ambrose.**

- `GenerateProvider`: job poll, shared path or audio download, index under `generated/ace-step/`
- `!generate <prompt>` (@dj/admin); 3/hour rate limit; max 1 concurrent
- Config: `aceStepEnabled`, `aceStepUrl`, `aceStepTimeoutMs`, `aceStepOutputDir`

### Next-slice: @dj tags, deploy excludes, ACE-Step A1
**Author: Grok (xAI), driven by Lane Ambrose.**

- PATCH `/api/music/tracks/:id/tags` allows admin **or** `radio.tags` (@dj) web users
- `deploy-to-pi.sh` excludes convert `.venv` / vendor / hf
- ACE-Step HTTP client + config keys (docs/ace-step.md A1)

### Radio / DJ Settings: sources + org memory on air
**Author: Grok (xAI), driven by Lane Ambrose.**

- Bumper source checkboxes + `memoryBroadcastOptIn` in Settings
- Persist via existing radio API validation
- `docs/radio.md` smoke + dashboard notes

### Voice polish (under music)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Settings: duck volume + listen window (seconds); Piper placeholders
- Quiet “duck skipped when idle” logs (debug only)
- `docs/voice.md` under-music tips for base NPU

### Phase 8 roast polish
**Author: Grok (xAI), driven by Lane Ambrose.**

- `!roastin` rejoin after opt-out; capture sanitizes BBCode/URLs
- Settings applies `roastMinScore` live; richer `!roast` status
- `docs/roast.md` operator guide; ROADMAP marked shipped

### Phase 7 polish — memory A1–A5
**Author: Grok (xAI), driven by Lane Ambrose.**

- **A1** `docs/memory.md` operator guide + smoke checklist
- **A2** Voice `remember` / `recall` / `forget` shape rules (real payloads only)
- **A3** Radio org-memory bumper when `memoryBroadcastOptIn` (KG only, never private)
- **A4** Await MemPalace on remember/forget; richer sync status + Settings messages
- **A5** `install.sh --with-memory` → profile `memory` + `MEMPALACE_URL`

### SBC STT default — Whisper base on NPU (RKNN)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Product default for `voice-edge`: `STT_MODEL=base`, `STT_BACKEND=rknn`,
  `STT_DEVICE=npu` (was CPU `small` / optional NPU `tiny`)
- Validated live: base RKNN snappier and cleaner than faster-whisper `small` on CPU
- Export: `MODEL_TYPE=base ./models/convert/export-whisper-rknn.sh` →
  `models/rknn/whisper-base-{encoder,decoder}.rknn`
- Zoo ladder note: tiny / base / medium only (no Rockchip `small`)
- Updated `install.sh`, compose overlays, `.env.example*`, voice docs, RELEASES

### V2 — remove sherpa/Kokoro (Whisper + Piper only)
**Author: Grok (xAI), driven by Lane Ambrose.**

- Deleted compose profile `voice`, services `sherpa-stt` / `kokoro`, volume `kokoro-models`
- Removed `services/sherpa-stt/` tree and install `--with-voice-legacy`
- `voice-smoke.sh` / `ci-validate` / `voice-profile.sh` target dual-track + mock only
- Docs: `docs/voice-backends.md`, `docs/voice.md`, hardening, AGENTS, BUILD V2 **Done**
- Bot HTTP client class names `SherpaSttClient` / `KokoroTtsClient` kept (historical); contract unchanged

### Dual-track STT — RKNN on SBC, whisper.cpp on Server
**Author: Grok (xAI), driven by Lane Ambrose.**

- **SBC:** `services/stt-rknn` — Rockchip NPU RKNN Whisper with
  **faster-whisper CPU fallback** until `.rknn` weights + full mel pipeline land
- **Server:** `services/stt-whisper-cpp` — **whisper.cpp** (`whisper-cli`) with
  optional **Vulkan** build (`WHISPER_VULKAN=1`) for AMD
- Same compose service name `stt-whisper` / bot URL; overlays swap the image
- Docs: `docs/voice-backends.md`, edition env examples, install voice defaults
- **AMD packaging:** `docs/gpu-amd.md`, `docker-compose.server.rocm.yml`,
  `scripts/detect-gpu.sh`, `scripts/check-analyst-vram.sh` (R9700 ~32 GB →
  both-resident-ok), `scripts/download-whisper-ggml.sh`
- Pi smoke: dual-track voice live (CPU tiny fallback), LAN chat → `.89:11434`
  12B, Piper TTS, sherpa/Kokoro stopped
- **RKNN Whisper tiny built** (20s FP export) + zoo mel/decoder path on Pi NPU;
  live ASR smoke: *“Mr. Quilter is the apostle…”* on `test_en.wav`

### Dual editions — SBC + Server product packaging
**Author: Grok (xAI), driven by Lane Ambrose.**

One repo, two releases ([docs/editions.md](./docs/editions.md), [RELEASES.md](./RELEASES.md)):

- **SBC** (`docker-compose.sbc.yml`, `.env.example.sbc`): RK3588 edge — E2B
  fallback + embeddinggemma, Whisper **tiny**, Piper British TTS; chat prefers LAN 12B
- **Server** (`docker-compose.server.yml`, `.env.example.server`): x86 — Gemma 4
  **12B** local, Whisper **small** / **large-v3**, same Piper voice
- `install.sh --edition sbc|server|auto` writes `COMPOSE_FILE` + `COMPOSE_PROFILES`
- `scripts/detect-edition.sh`, `scripts/package-release.sh` → `dist/release/*.tar.gz`
- DESIGN v3, ROADMAP, README, AGENTS, remote-llm, voice-backends rethought for
  dual-host product (NPU = offline opt-in, not day-to-day chat)

### Security audit remediation + Pi perf + STT alias removal
**Author: Grok (xAI), driven by Lane Ambrose.**

Security (F1–F11):
- **F1** yt-dlp: every HTTP input gated (`safeYtDlpMediaUrl` / YouTube host only)
- **F2** web↔TS nickname: exact case-insensitive match only (no substring rank steal)
- **F3/F4** `url-guard`: CGNAT, IPv4-mapped IPv6; `assertPublicPlaybackUrl` DNS check;
  bridge `streamUrl` revalidated
- **F5–F7** cover embed cap 48 KiB; music upload 40 MiB×5; queue-replace needs `clear`
- **F8–F11** generic player 500s; history limit 1–200; CSRF before `/api/session`;
  docs for unused `BOT_SESSION_SECRET`

Pi perf:
- Voice: demote hot-path logs; single-pass PCM peak + Int16Array; prune client maps;
  cache passive KWS rank; cache-first subject; voice `allowedClassifications` parity
- Player: chunk queue (no per-chunk concat); Int16 volume path
- TagStore prepare-once ratings; `play_history(botId)` index

Voice STT:
- **Removed** `VOICE_COMMAND_ALIASES` / `COMMAND_MODE_ALIASES` and wake garble list
  (no English-word → command translation). Shape checks + exact verbs only.

### Voice false-positive hardening (follow-up)
**Author: Grok (xAI), driven by Lane Ambrose.**

Corrected the earlier "0 voice commands executed" audit: Pi logs show
`play Toto Africa` *did* start playback after `974ea1d`. Remaining failures were
**false-positive command extraction** from channel banter and bare `play`.

- **`voiceCommandShapeOk`:** zero-arg commands (`now`, `pause`, …) reject trailing
  free-form junk; `forget` only accepts `all` / a number; `vol` needs digits.
- **`extractPlaybackVerb`:** deep-scan only short utterances (≤5 tokens); long
  speech only accepts leading/`play <title>`.
- **Partial-safe set:** drop `now`/`queue` (common English false-fires).
- **Silence-tail finals:** allow `play <title>` on peak-0 endpoint; still reject
  bare play/search without a title.
- **Tests:** live-log cases in `watchword.test.ts`.

**Open:** re-smoke voice on opi5 after deploy; banter should not trigger `now`/`forget`.

### Session handoff + design-doc sync — `3e352cb`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Design docs:** Synced 9 files to July 2026 shipped state (test counts 797+11,
  radio UI/profiles, voice Opus/duck, Gemma split-brain, deploy scripts, tidal-bridge).
- **Handoff:** `docs/session-handoff-2026-07-08.md` — Angelsfear investigation,
  `974ea1d` voice work, doc audit, 12h Pi performance audit.

### Voice Opus hardening + command/voice logging — `974ea1d`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Invoker logging:** `invokerFields()` in `bot/src/control/router.ts` — text
  command routing logs `invokerName`, `invokerUid`, `invokerClientId` on match,
  resolve, deny, and execute.
- **Voice diagnostics:** per-client `"Voice: first inbound packet from client"`
  log (`bot/src/bot/voice/session.ts`); rate-limited Opus decode failure warnings;
  `decodeFailures` + `multiFrameRecoveries` in voice capture summary.
- **Opus decode:** `bot/src/audio/opus-packet.ts` + `opus-voice.ts` — decode-first
  path with multi-frame fallback; valid tiny silence frames (≤12 bytes) no longer
  skipped as DTX before decode.
- **Tests:** `opus-packet.test.ts`, `opus-voice.test.ts`, router invoker tests.

**Open:** live TS6 voice round-trip smoke on opi5 with the `voice` profile.

## 2026-07-06

### R3 — Pandoc export + workflow docs — `d327f64`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Pandoc export:** `bot/src/docs/export.ts` — markdown → docx/pdf via `pandoc`;
  `GET /api/rag/doctrine/:source/export`, capabilities probe, Library **Export** button.
- **Docker:** `pandoc` added to `bot/Dockerfile` runtime image.
- **Docs:** `docs/r3-workflows.md` (INTSUM/AAR/analyst + export); `docs/rag-ingestion.md`
  export section; DESIGN §R3 status updated.

### Radio dashboard + `!radio pin` — `e02b87f`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **`!radio pin`:** copies the last played bumper into `data/bumpers/` for reuse;
  `radio.pin` rights token; migration v2 (`bot/src/radio/pin.ts`).
- **Dashboard:** Settings **Radio / DJ** panel (toggle, sliders, profile picker, test
  bumper, status); Library **Track tags** + star ratings (`StarRating.vue`).
- **APIs:** `GET /api/bot/radio/status`, `POST /api/bot/radio/test-bumper`,
  `GET /api/music/tracks/:id/tags`; settings payload includes `radio` block.
- **Starter profiles:** `lobby` and `focus` in `defaultRadioConfig()`.
- **Docs:** `docs/intercom.md` (listen-only voice delegate design); `docs/voice.md`
  listen window corrected to 15s; `docs/radio.md` status updated.

**Open:** TS live radio smoke on opi5; OQ3 `library-tag-scan` on full music corpus.

## 2026-06-20

### Security audit + rank gating
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Security (merged `main`):** SSRF guard on music URLs, secret redaction in logs,
  player API hardening, avatar path guard, env fallback hygiene (`bot/src/music/url-guard.ts`,
  `bot/src/data/bot-secrets.ts`, web player routes).
- **Custom rank gating:** `scripts/rights-rank-gating.json` starter template with
  placeholder server-group tiers; doctrine clearance ladder wired through `commandGroups`.
- **TS6 group resolution:** HTTP Query enriches `serverGroups` for rank checks when the
  full client omits them; web volume follows TS rank, not Moneypenny web admin role.
- **`!follow`:** implemented channel move; TS error 770 (already in channel) treated as success.
- **Doctrine upload cap:** 5 MiB → 15 MiB (web upload, editor, TS file-browser drop).
- **Docs:** `docs/rank-gating.md`; scrubbed stale limits and rights examples in README / rag-ingestion.

### R4 — channel moves (continued)
**Author: Grok (xAI), driven by Lane Ambrose.**

- **NL/voice:** `move_client` / `move_all_clients` LLM tools (included when invoker
  has `moveclient` rights); fuzzy chat + voice routing.
- **Mass move:** `!moveall <channel>` stages moves for others in-channel;
  `!moveall confirm` within 30s (max 10 clients).

### R4 — `!moveclient` (admin channel moves)

- `!moveclient <nickname|clid> <channel>` — move another user via TS6 HTTP Query
  (TS3 fallback); nickname prefix resolution, 5 moves/min rate limit.

### R1b async delegate + analyst rights gating
**Author: Grok (xAI), driven by Lane Ambrose.**

- **R1b:** `!analyst` / `delegate_to_agent` ack immediately and post results via
  `postFollowUp` (chat + voice); `formatDelegateFollowUp` in `bot/src/llm/delegate.ts`.
- **Rights:** `analyst`/`agent` removed from default public allow; `@analyst` command
  group granted to admin server-groups by default.

### Gemma 4 migration + R1 analyst delegation — `7f47978`
**Author: Grok (xAI), driven by Lane Ambrose.**

- **Remote chat default:** Unsloth Gemma 4 12B QAT (`UD-Q4_K_XL`) replaces Qwen
  as the primary LAN chat model; Gemma 4 preferred across defaults, presets, and
  embeddings (`27512ca`, `63269d6`).
- **Split-brain production:** LAN workstation (12B chat/tools), Pi ollama
  (Gemma E2B fallback + `embeddinggemma`), documented in `docs/remote-llm.md`
  (`f0c89ab`, `3680330`).
- **DESIGN §R1 shipped:** `!analyst` / `!agent` commands, `delegate_to_agent`
  tool, `DelegateClient` → `llmDelegateUrl` (production: Gemma 4 31B Q6 on a
  second LAN host); Settings delegate fields + presets (`138a47f`,
  `7f47978`).
- **Docs:** README commands/features/config, ROADMAP Phase 4 + R1b open items,
  DESIGN §R1 status, `docs/rag-ingestion.md` analyst path, `.env.example` pointer.

**Note:** R1b async delegate shipped in the same release batch (see above).

## 2026-06-19

### Voice STT sidecar, doctrine hardening, CI, and bot refactor — `c4c3850`
**Author: Cursor Composer (AI agent), driven by Lane Ambrose.** Committed under
Lane's identity without a `Co-Authored-By` trailer; recorded here for accurate
attribution.

- **Voice (Phase 2):** `sherpa-onnx` STT sidecar (`services/sherpa-stt`,
  Moonshine-tiny-en) + a dev `stt-mock`; voice probes, a synthetic
  `POST /api/bot/voice/test` (admin-only), a Settings voice panel, and
  `voice-smoke.sh`.
- **Doctrine wiki-as-code hardening:** nested doctrine paths (e.g.
  `intel/intsum.md`) with path-traversal containment in `DoctrineStore.safeName`,
  a recursive watcher, and `doctrine-sync-test.sh`.
- **CI / validation:** `ci-validate.sh`, an improved `phase0-validate.sh`.
- **BotInstance refactor:** split into `playback/commands/control/voice/`
  `knowledge/lifecycle/llm/rights/community` modules under `bot/src/bot/`.
- **Web/admin:** rights JSON editor, stream-bridge + RAG test panels, remote-LLM
  presets; `errorMessage` util; cookie-based session via `withCredentials`.
- Removed dead `ts-protocol/connection.ts` and `web/src/api/http.ts`.

### Follow-up audit + hardening of `c4c3850`
**Author: Claude (Anthropic), via Claude Code** (commit carries `Co-Authored-By`).
Audited the Composer commit (security, correctness, scope), then: STT `/asr`
body-size cap (413 over 25 MiB), `auth.ts` trailing newline, and this CHANGELOG.

## 2026-06-14

**Author: Claude (Anthropic), via Claude Code** (commits carry `Co-Authored-By`).

- **Tidal HiFi bridge** taken live: diagnosed the playback 401 (0.7.x's
  "Android Automotive" OAuth client → subStatus 4005), bumped `python-tidal` to
  0.8.x, fixed the login-link buffering. (`df9cd83`)
- **TeamSpeak file-browser ingestion:** drop `.md` → RAG doctrine, audio → the
  music library, from a `moneypenny-drop` channel; recursion, retry/timeout,
  `!ingeststatus`. (`c83af2d`, `520729f`)
- Regression tests locking in the `.env` inline-comment and `!play` YouTube-
  fallback fixes. (`029dd7b`)

## Earlier

- **Phases 5–8** (vector store, doctrine RAG, long-term memory, the roast),
  on-device LLM serving (Gemma 4 E2B on ollama), and the public GitHub release —
  Claude (Anthropic). A `grok-build-*` line of work was archived (see
  `archive/grok-build-corrupted-*` branches).
- Derived from [ZHANGTIANYAO1/teamspeak-music-bot](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot)
  (MIT).
