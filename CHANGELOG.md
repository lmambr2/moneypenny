# Changelog

Notable changes to Moneypenny. Dates are when the work landed on `main`.

This project is developed with AI coding assistants; this log records **which
assistant** authored each batch of work, since not every commit carries a
`Co-Authored-By` trailer. Attribution here is the source of truth.

## 2026-07-06

### R3 — Pandoc export + workflow docs — `TBD`
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

**Open:** R1b async delegate (ack now, post result later) — documented in
`docs/remote-llm.md` and ROADMAP Phase 4.

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
