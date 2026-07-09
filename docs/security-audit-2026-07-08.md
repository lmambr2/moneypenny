# Security audit — 2026-07-08

**Scope:** Moneypenny application attack surface (web auth/session/CSRF/rate
limits, rights/rank gating, music/ffmpeg/bridge SSRF & path containment, secrets
redaction, TS/command boundaries). Not a paid pen-test or full supply-chain
CVE campaign.

**Prior art:** [audit-findings.md](./audit-findings.md) (2026-06-20 AGENTS audit
— closed), [hardening.md](./hardening.md) (deployment checklist).

**Method:** Source review of `bot/src/web/**`, `bot/src/music/url-guard.ts`,
stream/youtube/local/generate, `bot/src/rights/**`, `bot/src/data/bot-secrets*`,
plus `npm audit` on bot package.

---

## Surfaces reviewed (including “no issue”)

| Surface | Status | Residual risk |
|---------|--------|---------------|
| Session cookie (`httpOnly`, `SameSite=Lax`, `Secure` under HTTPS) | **OK** | Cookie theft on pure-HTTP LAN if UI published without TLS (deploy) |
| Session store (SHA-256 of token, touch TTL) | **OK** | DB file perms are operator responsibility |
| Login rate limit (token bucket / IP) | **OK** | With `trustProxy`, spoofed `X-Forwarded-For` can dilute buckets (document) |
| First-run setup (empty user table → admin) | **OK** | Must complete on localhost before expose ([hardening.md](./hardening.md)) |
| CSRF origin/referer host match | **Fixed (M)** | Case-insensitive host compare shipped this pass |
| requireAuth / requireAdmin | **OK** | Admin-only routes double-gated where needed |
| WebSocket upgrade session check | **OK** | Same cookie validator as HTTP |
| Player API → `executeRoutedCommand` + rights | **OK** | Closed C2 in 2026-06 audit |
| Rank gating / rights engine | **OK** | Misconfigured custom rights JSON is operator risk |
| Music URL SSRF literal denylist | **OK** | Expanded sidecars this pass |
| Music URL DNS rebinding (play path) | **Fixed (H)** | `assertPublicPlaybackUrl` / `assertSafePlaybackTarget` at play |
| Local library path containment (`realpath`) | **OK** | Opaque ids; delete/upload under MUSIC_DIR |
| Upload isolation (`uploads/`) | **OK** | Extension allowlist + basename sanitize |
| Bot secrets redaction in admin API | **OK** | Empty field = leave unchanged on update |
| Parameterized SQL (better-sqlite3) | **OK** | No string-concat query building in hot paths |
| child_process | **OK** | `execFile`/arg arrays; no `shell: true` on untrusted input |
| npm audit (bot) | **info** | 1 low (esbuild Windows dev server) — non-prod |
| ACE-Step / MemPalace / LLM URLs | **OK (admin)** | Admin can point at LAN internals by design |
| Icecast mount URL | **OK (admin)** | ffmpeg argv, no shell; default off |

---

## Findings

### Critical

**None found** that are fixable in-repo without production credentials. Prior C1–C2 remain closed ([audit-findings.md](./audit-findings.md)).

### High

#### H-2026-07-08-1 — Stream / CDN play path lacked DNS rebinding check — **FIXED**

| | |
|--|--|
| **Location** | `StreamProvider.getSongUrl`, `resolveBridge`; `YouTubeProvider.getSongUrl` CDN hop; `PlaybackEngine.resolveAndPlayOnce` |
| **Issue** | `isPublicPlaybackUrl` only blocks private **literals** and known hostnames. A hostname that resolves to `127.0.0.1` / link-local / RFC1918 at play time (DNS rebinding or evil CDN hop from yt-dlp/bridge) could reach ffmpeg. |
| **Fix** | Call `assertPublicPlaybackUrl` on stream URLs and bridge/yt-dlp final URLs; final gate `assertSafePlaybackTarget` in `resolveAndPlayOnce` (local paths allowed, http(s) DNS-checked). |
| **Tests** | `url-guard.test.ts`, `stream.test.ts` private refusals, `engine.test.ts` resolveAndPlay SSRF refusal |
| **Residual** | TOCTOU between DNS check and ffmpeg connect remains theoretical; fail-closed on DNS error. |

### Medium

#### M-2026-07-08-1 — Incomplete Docker sidecar hostname denylist — **FIXED**

| | |
|--|--|
| **Location** | `url-guard.ts` `BLOCKED_HOSTNAMES` |
| **Issue** | Newer compose names (`stt-whisper`, `piper-tts`, `spotify-bridge`, `ace-step`) not blocked by literal hostname check. |
| **Fix** | Added to denylist. |
| **Residual** | Unknown future service names; DNS assert covers resolution to private nets. |

#### M-2026-07-08-2 — CSRF host compare case-sensitive — **FIXED**

| | |
|--|--|
| **Location** | `csrf.ts` |
| **Issue** | `Host` / `Origin` host compared with raw equality; rare case mismatch could 403 legitimate clients or confuse operators. |
| **Fix** | Compare lowercased hosts. |
| **Tests** | `csrf.test.ts` case-insensitive acceptance |

#### M-2026-07-08-3 — Rate-limit key under trust proxy — **DEFERRED**

| | |
|--|--|
| **Location** | `rateLimit.ts` + `trustProxy` |
| **Issue** | With `trustProxy: true`, `req.ip` follows `X-Forwarded-For`; a client that can spoof it may bypass login/player limits. |
| **Deferral** | Correct fix is proxy config (overwrite XFF); app already documents TLS proxy in hardening. Code change without trusted hop count is easy to get wrong. |
| **Residual** | Operators must set trust proxy only behind a real reverse proxy. |

### Low / info

| ID | Note |
|----|------|
| L1 | `BOT_SESSION_SECRET` reserved/unused — sessions are random DB-backed tokens |
| L2 | esbuild low advisory — dev-only Windows path |
| L3 | Health + public-url endpoints unauthenticated by design (no secrets) |
| L4 | Admin can set `llmUrl` / `aceStepUrl` / bridge to private LAN — intentional |

---

## Non-security improvements (this pass)

| Kind | Change |
|------|--------|
| **Bugfix** | `PlayQueue.remove` / `addNext` did not rewrite `forwardStack` indices — after remove + prev/next in random mode, `next()` could return `undefined`. Shift/filter `forwardStack` like history; bounds-check on pop. |
| **Refactor** | Session logout/change-password use shared `extractSessionToken` (safe URI decode) instead of a duplicate cookie parser that could throw on bad encoding. |
| **API (security)** | `assertSafePlaybackTarget` shared helper for “local path OR public network URL” (H-2026-07-08-1). |

---

## Verification

```bash
cd bot && npx vitest run src/music/url-guard.test.ts src/music/stream.test.ts \
  src/web/middleware/csrf.test.ts src/bot/playback/engine.test.ts
cd bot && npm run test:all
cd bot/web && npm test
```

See also CHANGELOG entry for this audit batch.
