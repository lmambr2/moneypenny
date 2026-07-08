# Session handoff — 2026-07-08

Work log for the Grok agent session covering repo catch-up, design-doc sync,
deploy verification context, and a 12-hour Pi performance audit. Written for
Lane / the next operator or agent picking up from here.

**Production fork:** `/home/lane/Projects/moneypenny` → `dietpi@opi5:~/moneypenny`  
**Branch:** `dev`  
**Latest commits at handoff:** `3e352cb` (docs), `974ea1d` (voice Opus hardening)

---

## 1. Angelsfear play investigation (complete)

**Verdict:** Not rank/permissions. Voice pipeline failure.

**Source:** `/home/dietpi/moneypenny/bot/data/logs/bot.log` (~96k lines), Jul 5–6 radio night.

| Finding | Detail |
|---------|--------|
| Angelsfear clientIds | 18, then 21 |
| Opus decode failures | 186× for clientId 18 |
| Voice turns (any user) | 0 that evening |
| `Command denied by rights` for play | 0 |
| Text `!play` in same window | 3 successful |

**Likely cause:** Opus decode failures + mic clipping (`rawPeak: 32768`). Text `!play` works as a workaround until voice is validated on the current deploy.

---

## 2. Engineering follow-ups shipped (`974ea1d`)

Deployed to Pi via `deploy-preflight.sh` + `deploy-to-pi.sh`. Verified in container:
`opus-voice.js`, `invokerFields` in `router.js`.

### 2.1 Invoker logging on text commands

- **File:** `bot/src/control/router.ts` — `invokerFields()` helper
- **Logs:** `invokerName`, `invokerUid`, `invokerClientId` on deterministic match,
  resolve, deny, execute
- **Tests:** `bot/src/control/router.test.ts`

### 2.2 Per-client first inbound packet logging

- **File:** `bot/src/bot/voice/session.ts` — `seenInboundClients` Set
- **Log:** `"Voice: first inbound packet from client"` per `clientId` (replaces
  global first-packet log)

### 2.3 Opus decode hardening

- **New:** `bot/src/audio/opus-packet.ts` — RFC 6716 packet splitter
- **New:** `bot/src/audio/opus-voice.ts` — `decodeVoiceOpusPacket()`
- **Key fix:** Do not preemptively skip packets ≤12 bytes as DTX — valid encoded
  silence is ~3 bytes. DTX classification only after decode fails on tiny packets.
- **Fallback:** Multi-frame decode when bundled decode fails
- **Logging:** Rate-limited decode failure logs (first 3, then every 50th per client);
  `decodeFailures` + `multiFrameRecoveries` in voice capture summary
- **Tests:** `opus-packet.test.ts`, `opus-voice.test.ts`

**SSH note:** Use `ssh -F /dev/null` to avoid LocalForward conflicts on
`127.0.0.1:10080` / `:4000`.

---

## 3. Tidal bridge clarification

- **Not greenfield** — `services/tidal-bridge/server.py` exists and ships
- **Pi:** `moneypenny-tidal-bridge-1` running
- **Gap:** `STREAM_BRIDGE_URL` commented out in Pi `.env` → bot falls back to
  YouTube search for Tidal links
- **To enable:** `STREAM_BRIDGE_URL=http://tidal-bridge:8081`, confirm auth via
  `docker compose logs tidal-bridge`
- **Still stubbed:** R-R6 Spotify/Tidal playlist expansion (`getPlaylistSongs`)

---

## 4. Design doc audit and sync (`3e352cb`)

Full repo catch-up against shipped code. Test counts verified before editing docs:
**797** backend + **11** frontend tests, **110** test files (3 skipped).

### 4.1 Files updated

| File | Main changes |
|------|----------------|
| `CHANGELOG.md` | Entry for `974ea1d`; removed stale "Open: R1b" under 2026-06-20 |
| `ROADMAP.md` | Phase 9: Vue UI + `!radio pin` + `lobby`/`focus` profiles shipped |
| `README.md` | Test counts; `!intsum`/`!aar`/`!kg`/`!diary`/`!selecttracks`/`!radio pin`; deploy scripts; features |
| `DESIGN.md` | July 2026 status block; Gemma 4 split-brain; Opus/duck/tidal/radio/R3; rights JSON editor shipped |
| `docs/voice.md` | Moonshine **tiny-en**; Opus decode shipped; `duckForStt` API |
| `docs/radio.md` | Starter profiles ship; `duckForStt` not `captureDuck`; web tags admin-only |
| `docs/rank-gating.md` | Web `PATCH …/tags` is admin-only (not `@dj` yet) |
| `AGENTS.md` | Radio subsystem map; `duckForStt`; Opus DTX pitfall entry |
| `docs/hardening.md` | Compose profiles table |

### 4.2 Key facts now reflected in docs

- **LLM:** Split-brain Gemma 4 12B on LAN; Pi ollama/Gemma E2B fallback; optional
  NPU Gemma 4 `.rkllm` via rkllama
- **Radio:** Backend + UI shipped; `radio.enabled=false` by default; profiles
  `lobby`/`focus` in `defaultRadioConfig()`
- **Voice:** `decodeVoiceOpusPacket`, `duckForStt` volume duck (not hard-pause)
- **Deploy:** `deploy-preflight.sh`, `deploy-to-pi.sh`, `verify-pi-deploy.sh`
- **Phase 0:** `PHASE0_AUTO_TEST=1` on Pi for auto `!test`

### 4.3 Remaining doc-accurate gaps (not yet fixed in code)

- Live voice round-trip smoke on opi5
- Radio live smoke (`!radio ops`, bumper test)
- R-R6 optional extensions
- Wire `STREAM_BRIDGE_URL` on Pi for real Tidal playback
- Web tag API `@dj` parity (`radio.tags` token exists; endpoint still `requireAdmin`)
- Deploy rsync should exclude `models/convert/.venv/` (huge accidental sync noted)

### 4.4 Git

```text
3e352cb docs: sync design docs with July 2026 shipped state
974ea1d fix(voice): harden Opus decode and improve command/voice logging
```

Pushed to `origin/dev`. Uncommitted locals (artifacts only): `*.rkllm`,
`models/convert/hf/`, `models/npu-llm/tokenizer/`.

---

## 5. Pi performance audit — last 12 hours

**Pulled:** 2026-07-08 ~07:08 local from `dietpi@opi5` — `bot.log` JSON parse,
`docker stats`, container health, `/api/health`.

### 5.1 System snapshot (healthy)

| Metric | Value |
|--------|-------|
| Load avg | 0.03 / 0.02 / 0.00 |
| RAM | 5.2 GiB used / 15 GiB (10 GiB available) |
| Swap | None |
| Host uptime | 4 days |

**Idle container resources:**

| Service | CPU | RAM |
|---------|-----|-----|
| bot | 0.08% | 104 MiB |
| rkllama | 0.02% | 2.47 GiB |
| ollama | 0.00% | 599 MiB |
| sherpa-stt | 0.01% | 222 MiB |
| kokoro | 0.08% | 1.38 GiB |

All containers healthy; **0 restarts** on bot/rkllama/sherpa in the window.

### 5.2 Twelve-hour log summary (3,622 lines)

| Metric | Count | Notes |
|--------|-------|-------|
| Bot container starts | 11 | Deploy/rebuild churn |
| Tracks played | 9 | Mostly startup auto-`!test` |
| Voice turns | 3 | STT OK; **0 commands executed** |
| Opus decode failures | 93 | **All pre-`974ea1d` containers** |
| Opus failures (current container `2943738cfce7`) | **0** | ~10h since deploy |
| Embedding timeouts | 68 | Single old container during ollama cold-load |
| Command denials | 0 | |
| Watchdog OOM exits | 0 | `memoryLimitMb=0` |

### 5.3 Voice detail

**Pre-deploy:** 93 Opus failures — clientId 29 (60×), 28 (12×), 32 (19×);
`The compressed data passed is corrupted` from `encoder.js`.

**Post-deploy:** 0 Opus failures; one `"Voice: first inbound packet from client"`
(clientId 32). `opus-voice.js` confirmed in running container.

**Three voice turns** (older container `87e66f9c48da`):

1. *"Money Penny, play Toto Africa."*
2. *"Money petty play tonneau Africa."* (~15s later)
3. *"Forget it. I think the problem is she's slow."* (~45s later)

Transcripts captured; no routed `play` command. **37 PCM clip warnings** (hot mics).

### 5.4 RAG / embeddings

68× `Embedding request failed: timeout of 60000ms exceeded` — all from container
`64634ec3fafa` during restart/cold-load. **Current:** embedding probe to ollama
`embeddinggemma` succeeds in **~2.8s** (768 dims).

### 5.5 Minor noise (non-critical)

- 11× TS error 770 "already member of channel" on startup
- 5× avatar upload `invalid size (status=2565)`
- 2× YouTube save failures (region/403); streaming continued

### 5.6 Performance verdict

| Layer | Last 12h | Since last deploy (~10h) |
|-------|----------|--------------------------|
| Pi hardware | Excellent | Excellent |
| Music playback | Fine (light use) | Auto-`!test` OK |
| Opus decode fix | Mixed (pre-deploy noise) | **Clean** |
| Voice E2E | 3 STT hits, 0 executes | No voice activity logged |
| RAG embeddings | Bad during one restart | Healthy (~2.8s) |

**Next validation step:** Live voice smoke on current deploy — *"Moneypenny, play
Toto Africa"* — watch for `Voice turn` + actual playback. Opus side looks fixed;
STT→router latency and command execution still need operator confirmation.

---

## 6. Commands reference (audit / ops)

```bash
# Local pre-deploy
./scripts/deploy-preflight.sh
./scripts/deploy-to-pi.sh
./scripts/verify-pi-deploy.sh

# Pi log analysis (JSON bot.log uses monotonic `time` field, not ISO dates)
ssh -F /dev/null -o ClearAllForwardings=yes dietpi@opi5

# Tests (verified at doc-sync time)
cd bot && npm run test:all   # 797 passed, 3 skipped
cd bot/web && npm test       # 11 passed
```

---

## 7. Open items for next session

1. **Voice live smoke** on opi5 with `974ea1d` — confirm play routes after STT
2. **Angelsfear retest** — same voice command; compare to Jul 5–6 logs
3. **Radio live smoke** — `!radio ops`, bumper test
4. **Optional:** `STREAM_BRIDGE_URL=http://tidal-bridge:8081` on Pi
5. **Optional:** Add `models/convert/.venv/` to deploy rsync excludes
6. **Optional:** Wire web tag API to `radio.tags` / `@dj` (docs already note gap)

---

*Generated by Grok agent session, 2026-07-08. Attribution: Grok (xAI), driven by Lane Ambrose.*