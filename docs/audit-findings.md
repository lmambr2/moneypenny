# AGENTS.md Audit Findings & Remediation

Audit date: 2026-06-20. Steering reference: `AGENTS.md`.

## Baseline (pre-remediation)

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` | Pass |
| `npm run test:all` | 410 passed, 3 skipped |
| `npm run build` (web) | Pass |
| `./scripts/ci-validate.sh --voice-only` | Pass |
| `./scripts/doctrine-sync-test.sh` | Pass |
| `./scripts/phase0-validate.sh --check-only` | Pass (warn: `TS6_API_KEY` empty) |

---

## Findings & remediation status

### Critical

- [x] **C1 — Chinese runtime strings in `bot/src/bot/profile.ts`**
  - `\u7B49\u5F85\u64AD\u653E` (away message) and `\u6B63\u5728\u64AD\u653E` (now-playing chat) violate English-only policy.
  - Fix: replace with English; strengthen `no-non-english.test.ts` to catch `\u` escapes.

- [x] **C2 — Web Player API bypasses `ControlRouter` + rights (`bot/src/web/api/player.ts`)**
  - TS/voice use the router; web player called `bot.executeCommand()` directly.
  - Fix: route command paths through `BotInstance.executeRoutedCommand()` with web subject + rights.

### High

- [x] **H1 — `MusicProvider` CN-era shims (`bot/src/music/provider.ts`)**
  - QR/SMS/cookie stubs and dead HTTP routes (`/personal/fm`, `/recommend/songs`, etc.).
  - Fix: slim interface; delete stubs and dead routes in one cut.

- [x] **H2 — `stream` platform dropped at music HTTP boundary (`bot/src/web/api/music.ts`)**
  - `getProvider()` only handled `local`; everything else hit YouTube.
  - Fix: wire `stream` provider through `createMusicRouter`.

- [x] **H3 — Web player `platformFlag` ignores `stream` (`bot/src/web/api/player.ts`)**
  - Fix: map `stream` → `-s`, `local` → `-l`.

### Medium

- [x] **M1 — English-only guard bypass via `\uXXXX` escapes**
  - Fix: decode escapes in `no-non-english.test.ts` before matching.

- [x] **M2 — Router transition fallback still live (`control/router.ts`)**
  - Fix: return standard unknown-command message (all known commands registered).

- [x] **M3 — `!fm` registered but permanently stubbed**
  - Fix: remove from command sets and handlers.

- [x] **M4 — Missing API tests for music/player/rag HTTP seams**
  - Fix: add route tests (rights denial, stream routing, rag delete validation).

- [x] **M5 — `music.ts` search `limit` unbounded**
  - Fix: cap at HTTP boundary (max 50).

### Low / informational (no code change required)

- [x] **L1 — Legacy DB/config migration (`index.ts`)** — intentional one-time path.
- [x] **L2 — `stt-mock` / `voice-dev`** — documented CI stub.
- [x] **L3 — `ftgetfilelist` HTTP Query fix** — implemented; parser tested.
- [x] **L4 — Secrets** — `.env` gitignored; no production secrets in tracked source.
- [x] **L5 — Hardware validation** — operator-gated per AGENTS phase priority.

---

## Post-remediation verification

- [x] `cd bot && npx tsc --noEmit`
- [x] `cd bot && npm run test:all` — 417 passed, 3 skipped
- [x] `cd bot/web && npm run build`
- [x] `./scripts/ci-validate.sh --voice-only`
- [x] `AGENTS.md` §4 updated with confirmed patterns

---

## Follow-up security pass (2026-06-20, same day)

Additional hardening merged after the AGENTS audit baseline:

- [x] Music URL SSRF guard (`bot/src/music/url-guard.ts`)
- [x] Secret redaction helper for logs (`bot/src/data/bot-secrets.ts`)
- [x] Web player routed through rank gating (confirms C2 closure on deployed branch)
- [x] Custom military-rank ruleset (`scripts/rights-rank-gating.json`, `docs/rank-gating.md`)

Operator docs scrubbed for stale 5 MiB doctrine limits and outdated rights examples.