> **HISTORICAL ARCHIVE** — point-in-time audit/notes. Paths and stack may be stale
> (e.g. `bot/src/ts-protocol`, `web/server.ts`, Qdrant). Current operator truth:
> [AGENTS.md](../AGENTS.md), [docs/editions.md](./editions.md), [docs/ts6-client.md](./ts6-client.md),
> [docs/rag-embeddings.md](./rag-embeddings.md), [docs/http-openapi.md](./http-openapi.md).

# Security audit, bug hunt, and refactor opportunities — 2026-07-09

**Scope:** Moneypenny application attack surface after the harness / org / ops /
voice-smoke / SC-client arc. Complements
[security-audit-2026-07-08.md](./security-audit-2026-07-08.md),
[hardening.md](./hardening.md), [audit-findings.md](./audit-findings.md), and
[DESIGN.md](../DESIGN.md) §11.

**Method:** Source review of `bot/src/web/**` (auth/CSRF/gates), `bot/src/rights`,
`bot/src/control`, `bot/src/ts-protocol`, `bot/src/ingest`, `bot/src/music/url-guard`,
`bot/src/harness`, `bot/src/tools` (SC/status), `bot/src/memory`, `bot/src/rag`,
`services/*` listen addresses, `docker-compose.yml` + `docker-compose.ace-step.yml`
host publish bindings, `scripts/deploy-to-pi.sh`, `scripts/rights-rank-gating.json`;
full bot vitest suite; `npm audit` (bot); static `rg` for spawn/eval/path/fetch/secrets.

**Non-goals:** Live Pi/TS pen-test, full transitive SCA product, Python brain /
Vue rewrite / teamspeak.js adoption, shipping every remediation in this pass.

---

## Executive summary

**Posture:** Consistent with design intent — **localhost-bound UI by default**,
**session + CSRF + admin gates** on sensitive APIs, **fail-open music** (LLM/RAG
must not strand playback), **rank-gated TS commands**, **parameterized SQL**,
**no shell-true on untrusted input**, **playback SSRF denylist + DNS checks**
(2026-07-08). Residual risk is mostly **operator deployment** (binding,
TLS, proxy trust) and **admin-equivalent power** on a shared dashboard.

**Top risks (ordered fix-first):**

1. **P0 (fixed this pass):** Rank-gating starter template omitted `!ops` →
   public command drift / rights template test failure.
2. **P0 (fixed this pass):** SC org status URL accepted non-http(s) schemes;
   now normalized to http(s) only, no embedded credentials.
3. **Medium (mitigated):** `trustProxy` + XFF — **fixed** with `trustProxyHops`
   rightmost-hop rate-limit keys (operator must overwrite XFF at edge).
4. **Medium (product):** Admin harness intent tools — **mitigated** with safer
   default allowlist + dry-run + `harnessIntentAllowDangerous` opt-in.
5. **Low:** `GET /api/bot/llm/status` — **fixed** (`requireAdmin`).
6. **Low/privacy:** Admin private-memory read — **mitigated** with
   `memory.private_read` audit log (still admin-capable by design).
7. **Medium (ops bind):** ACE-Step host publish — **fixed** default loopback
   (`ACE_STEP_PUBLISH=127.0.0.1`).

**No Critical** in-repo issues found in this pass. Suite: **1018+** passed after
P0 fixes; compose bind posture regression tests added.

---

## 1. Security findings

### Critical

**None.** Prior closed items (player rights C2, playback DNS rebinding H) remain
closed; see 2026-07-08 audit.

### High

**None newly confirmed.** Prior H-2026-07-08-1 (DNS rebinding on play path)
remains fixed and covered by `url-guard` / engine tests.

### Medium

#### M-2026-07-09-1 — Admin harness intent executes tools without web rights re-check

| | |
|--|--|
| **Severity** | Medium (admin-only) |
| **Location** | `bot/src/bot/instance.ts` `runHarnessTurn` → `commands.execute` after `toolCallToCommand` |
| **Threat** | Compromised admin session or prompt-injection against the local LLM can drive **play / skip / stop / volume** (and any mapped tool) on the live queue without the web player’s `canWebUserRunCommand` path. |
| **Impact** | Live music disruption; not a cross-user privilege escalation (route is `requireAdmin`). |
| **Remediation** | Document as “admin equals DJ console”; optionally restrict intent tools to a safer allowlist (`play`/`now` only) or dry-run mode. **Accepted risk** for current product if operators keep UI localhost/TLS. |

#### M-2026-07-09-2 — Admin-configured outbound URLs (LAN SSRF by design)

| | |
|--|--|
| **Severity** | Medium (operator/admin) |
| **Location** | Settings: `llmUrl`, `aceStepUrl`, `streamBridgeUrl`, `scOrgStatusUrl`, `mempalaceUrl`, `vectorDbUrl`, … consumed by axios/fetch/ffmpeg |
| **Threat** | Admin can point the bot at internal metadata IPs / sidecars. |
| **Impact** | Expected for self-hosted LAN; catastrophic if the dashboard is exposed to untrusted admins on the internet. |
| **Remediation** | Keep UI off public internet ([hardening.md](./hardening.md)); do not grant admin to untrusted users. Optional future: warn when URL resolves private. |
| **This pass** | SC base URL now **http(s) only** (`normalizeScOrgBaseUrl`) — reduces `file:` / credential-in-URL footguns. |

#### M-2026-07-09-3 — Rate-limit key under `trustProxy` — **mitigated**

| | |
|--|--|
| **Severity** | Medium (ops) |
| **Location** | `bot/src/web/middleware/client-ip.ts` + `trustProxyHops` |
| **Threat** | Spoofed `X-Forwarded-For` can dilute login/player limits. |
| **Remediation** | Only enable trust proxy behind a hop that overwrites XFF; configure `trustProxyHops` to match the chain. |
| **This pass** | Rightmost-N XFF selection + unit tests; residual: operator misconfig. |

#### M-2026-07-09-4 — Admin private-memory inspection by arbitrary TS uid

| | |
|--|--|
| **Severity** | Medium (privacy) |
| **Location** | `GET /api/bot/memory/private?uid=` — `bot/src/web/api/bot.ts` |
| **Threat** | Any admin can read every user’s private `!remember` facts. |
| **Impact** | Privacy violation on multi-admin shared logins; not a member→member leak. |
| **Remediation** | Audit-log each private read; optional confirm dialog in Harness; restrict to super-admin. **Accepted** for single-operator deployments. |

### Low / Info

| ID | Location | Note |
|----|----------|------|
| L-2026-07-09-1 | `GET /api/bot/llm/status` | **Fixed:** `requireAdmin`. |
| L-2026-07-09-2 | `GET /api/bot/`, `GET /api/bot/:id` | Bot name, connected, now-playing metadata for all authed users — intentional for the SPA player. |
| L-2026-07-09-3 | `GET /api/health`, `public-url` | Unauthenticated by design; no secrets. |
| L-2026-07-09-4 | In-memory harness turn ring | Shared process-wide among admins; last turns visible to next admin session. |
| L-2026-07-09-5 | `npm audit` | 1 **low**: esbuild Windows dev-server advisory — not production path. |
| L-2026-07-09-6 | `BOT_SESSION_SECRET` | Still reserved/unused; sessions are random DB-hashed tokens. |
| L-2026-07-09-7 | Deploy rsync | `scripts/deploy-to-pi.sh` excludes `.env`; `--delete` gated — good. Operator must protect SSH and host `bot/data`. |
| L-2026-07-09-8 | Sidecar in-container `0.0.0.0` | STT/TTS/bridges/MemPalace/ACE listen on all interfaces **inside** the container; safety depends on **host publish** mapping. |

#### M-2026-07-09-5 — ACE-Step compose host publish — **fixed (loopback default)**

| | |
|--|--|
| **Severity** | Medium (ops / multi-service bind) |
| **Location** | `docker-compose.ace-step.yml` `ports: "${ACE_STEP_PUBLISH:-127.0.0.1}:${ACE_STEP_PORT:-7865}:7865"` |
| **Threat** | On a GPU host, all-interface publish left the generate adapter LAN-reachable without auth. |
| **Remediation** | Default loopback; set `ACE_STEP_PUBLISH=0.0.0.0` only on trusted single-operator boxes. |
| **Tests** | `compose-bind-posture.test.ts` asserts ACE overlay includes `127.0.0.1`. |

### Multi-service network bind posture

**Design:** Process listen address inside the container is often `0.0.0.0` (required for Docker port mapping). **Host-side publish** is the security boundary for “is this on the LAN?”

| Service | Compose file | Host publish (shipped default) | In-container bind | Posture |
|---------|--------------|--------------------------------|-------------------|---------|
| **bot** (UI/API) | `docker-compose.yml` | `127.0.0.1:3000:3000` | `BIND_ADDRESS=0.0.0.0` | **OK** — localhost host publish |
| **ollama** | same | `127.0.0.1:11434:11434` | image default | **OK** |
| **rkllama** | same | `127.0.0.1:8080:8080` | `0.0.0.0` | **OK** |
| **stt-whisper** | same | `127.0.0.1:9000:9000` | `0.0.0.0` | **OK** — no auth on STT |
| **stt-mock** | same | `127.0.0.1:9001:9000` | `0.0.0.0` | **OK** (dev) |
| **piper-tts** | same | `127.0.0.1:8880:8880` | `0.0.0.0` | **OK** — no auth on TTS |
| **spotify-bridge** | same | `127.0.0.1:8082:8082` | `0.0.0.0` | **OK** |
| **mempalace-bridge** | same | `127.0.0.1:8090:8090` | `0.0.0.0` | **OK** |
| **qdrant** | same | *none* (compose network only) | container default | **OK** — bot uses `http://qdrant:6333` |
| **tidal-bridge** | same | *none* (network only) | `0.0.0.0` | **OK** — bot uses `http://tidal-bridge:8081` |
| **teamspeak** (profile `server`) | same | `9987/udp`, `30033`, `10080`, `10022` **all interfaces** | image | **OK intentional** — clients must reach voice/query |
| **ace-step** | `docker-compose.ace-step.yml` | `127.0.0.1:${PORT:-7865}:7865` (default) | `HOST=0.0.0.0` | **OK** — loopback host publish |

**Evidence / regression guard:** `bot/src/data/compose-bind-posture.test.ts` parses shipped compose YAML and fails if AI sidecars lose `127.0.0.1:` host publish.

**Operator residual:** Changing any `127.0.0.1:…` publish to `0.0.0.0:…` without a firewall exposes **unauthenticated** STT/TTS/LLM/bridge HTTP. Never do that on an untrusted network. See [hardening.md](./hardening.md).

### Surfaces reviewed (OK / residual)

| Surface | Status | Residual |
|---------|--------|----------|
| Session cookie httpOnly + SameSite=Lax + Secure under HTTPS | **OK** | Cleartext LAN without TLS |
| CSRF Origin/Referer host match (case-insensitive) | **OK** | SameSite already helps |
| requireAuth on `/api/*` after public health/session | **OK** | |
| requireAdmin on settings, harness, org-kg, rag, rights debug, bot secrets config | **OK** | llm/status is weaker (L1) |
| WebSocket upgrade session cookie | **OK** | |
| Player → `executeRoutedCommand` + rights | **OK** | |
| Rank gating engine + migrations (incl. ops v5) | **OK** after template fix | Custom ruleset operator risk |
| Doctrine `safeName` path containment | **OK** | |
| Playback URL SSRF denylist + DNS | **OK** (2026-07-08) | TOCTOU theoretical |
| child_process arg arrays, no shell:true on untrusted | **OK** | |
| Secrets redaction on `GET /api/bot/:id/config` | **OK** | |
| Parameterized better-sqlite3 | **OK** | |
| File-drop channel | **OK** | Trust TS channel ACLs |
| SC org / host status plugins | **OK** fail-open | Admin URL LAN SSRF (M2) |
| **Multi-service compose host publish / bind** | **OK** for core AI sidecars (loopback publish) | ACE-Step default all-if; TS server all-if intentional; in-container 0.0.0.0 |

---

## 2. Bug hunt

### Confirmed (code + test)

#### B-2026-07-09-1 — Rank-gating template missing `ops` — **FIXED**

| | |
|--|--|
| **Evidence** | `vitest` `src/rights/rank-gating-template.test.ts` failed: `missing = ['ops']` |
| **Location** | `scripts/rights-rank-gating.json` vs `COMMAND_MANIFEST` public `ops` |
| **Impact** | Operators importing the starter template deny `!ops` to everyone; drift class that previously broke `!playnext` / `!chevron7`. |
| **Fix** | Added `ops` to `defaultAllow` and to admin/dj/analyst groups in the template. Runtime migration v5 already granted ops on live configs. |

### Confirmed (fixed this pass)

#### B-2026-07-09-2 — SC org URL scheme not validated — **FIXED**

| | |
|--|--|
| **Location** | `bot/src/tools/sc-org-client.ts` |
| **Impact** | Misconfiguration could attempt non-HTTP fetches. |
| **Fix** | `normalizeScOrgBaseUrl` — http(s) only, no userinfo; tests added. |

### Hypotheses (read path; not repro’d failing)

| ID | Hypothesis | Read path |
|----|------------|-----------|
| H1 | Harness intent + aggressive local model might call `stop` during demos more often than chat rights would allow a DJ | `instance.ts` executeTool → `toolCallToCommand` includes `stop` |
| H2 | Shared harness turn buffer could confuse multi-admin debugging | `InMemoryHarnessStore` per bot process |
| H3 | TOCTOU DNS rebinding still theoretical between assert and ffmpeg connect | `url-guard.ts` + player spawn |

### Suite status

```
Full bot vitest (pre-fix): 1 failed (rank-gating template ops), 1016 passed, 3 skipped
After P0 fixes: rank-gating-template + sc-org-client + external-status green
npm audit: 1 low (esbuild, Windows dev only)
```

---

## 3. Refactor opportunities

### Quick wins

| Item | Observation | Why |
|------|-------------|-----|
| **Admin-only on `GET /llm/status`** | Auth-only while other LLM routes are admin | Consistency + less recon |
| **Harness intent dry-run flag** | Always executes tools | Safer demos / shared admin |
| **Audit log private memory reads** | No trail today | Privacy accountability |
| **Split `createBotRouter`** | `bot.ts` is a mega-router | Testability, reviewability |

### Medium

| Item | Observation | Why |
|------|-------------|-----|
| **Thin adapter for outbound service clients** | LLM, ACE, MemPalace, SC, stream bridge each roll their own fetch | Shared timeout, URL normalize, metrics |
| **BotInstance façade growth** | harness/ops/kg/voice methods keep landing on instance | Extract `HarnessFacade` / `OpsFacade` |
| **Duplicate ask surfaces** | `POST /llm/ask` vs `POST /harness/ask` | Single turn pipeline, two thin handlers |
| **Rights template + migrations dual source** | Template JSON vs `migrations.ts` deltas | Generate template from manifest or test both |

### Large (do **not** start now)

| Item | Why deferred |
|------|----------------|
| Python “brain” extract | Plan-only until pain criteria ([brain-boundary.md](./brain-boundary.md)) |
| Vue → Svelte/Next | Explicit non-goal |
| teamspeak.js swap for voice | Query-only; keep honeybbq ([feature-roadmap watchlist](./feature-roadmap.md)) |
| Full microservice split | Overkill for current ops load |

---

## 4. Fix-first backlog (recommended order)

1. ~~Sync `rights-rank-gating.json` with public commands (`ops`)~~ **done**  
2. ~~Validate SC org URL scheme~~ **done**  
3. Optionally `requireAdmin` on `GET /api/bot/llm/status`  
4. Optional harness intent allowlist / dry-run  
5. Audit-log `memory/private` reads  
6. Keep proxy/TLS discipline from [hardening.md](./hardening.md)  
7. Periodic `npm audit` / dependabot  

---

## 5. Verification notes

Evidence under implementer scratch (not committed): suite log, static scan,
npm audit, spot-checks.

```bash
# Spot-check cited modules exist
test -f bot/src/web/middleware/csrf.ts
test -f bot/src/music/url-guard.ts
test -f bot/src/bot/instance.ts
test -f bot/src/tools/sc-org-client.ts
test -f scripts/rights-rank-gating.json
test -f docker-compose.yml
test -f docker-compose.ace-step.yml

cd bot && npx vitest run src/rights/rank-gating-template.test.ts \
  src/tools/sc-org-client.test.ts src/music/url-guard.test.ts \
  src/web/middleware/csrf.test.ts src/data/compose-bind-posture.test.ts
```

---

*Analysis goal: document first. Trivial P0 template + URL normalize shipped in
the same batch. Residual risk remains for live network ops not exercised here.*

---

## Addendum — same-day follow-up sweep (Claude Fable 5)

Independent pass over the post-audit commits (`6ac7fbf..8a30089`: recordings,
economy dashboard/L2 cache, UEX dropdown) plus scope gaps in the passes above.
Corroborated the earlier findings; the following were new and are **fixed**:

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| A-2026-07-09-1 | **High (dep)** | `bot/web` npm audit was **not** covered above (bot-only): 7 vulns — `form-data` CRLF injection (high), `postcss` (mod), and 5 moderates via **unused** `node-vibrant` (declared since initial release, never imported) | `npm audit fix` + `npm uninstall node-vibrant` → **0 vulns** |
| A-2026-07-09-2 | Low | `GET /api/bot/recordings/:name` echoed the raw route param into `Content-Disposition` — a quote-bearing name breaks the quoted-string (admin-only; Node blocks CRLF) | Sanitize via `safeRecordingBasename` before lookup and header; test added |
| A-2026-07-09-3 | Bug (functional) | Recordings upload sends base64 JSON through the **global 2 MB parser** while `writeRecording` allows 50 MiB — captures over ~1.5 MB always failed 413 | Scoped `express.json({ limit: "70mb" })` for `/api/bot/recordings` (S2 pattern, admin-gated route) |
| A-2026-07-09-4 | Low | `safeYtDlpMediaUrl` passed non-http(s) scheme URLs (`ftp://youtube.com/…` parses with an allowlisted hostname) through the bare-id branch straight to yt-dlp, skipping `assertPublicPlaybackUrl` | Reject any scheme-bearing non-http(s) input; tests added |

**Verified OK in this sweep (no findings):** recordings path containment
(`safeRecordingBasename` + resolve-prefix), economy router validation/limits as
documented in the economy audit, `/commodities` endpoint (post-audit commit),
economy L2 SQLite cache (parameterized), refresh scheduler (single-flight,
unref, stoppable), sessions/CSRF/client-ip middleware, uploads
(multer memory + ext allowlist + basename sanitize), websocket (broadcast-only),
tidal-bridge compose posture (network-only). Suite after fixes: **1166 backend
+ 13 web passed**, tsc + Biome clean, web build OK.

**Follow-up batch (same day, all fixed):** `formatCacheStatus()` now redacts
the cache root in TS chat via a shared `cacheRootLabel` in the store (E-M3
parity); the economy scheduler's 15 s first-warm `setTimeout` is now tracked,
unref'd, and cancelled by `stopEconomyCacheScheduler()`; the two open economy
checklist items shipped — audit rows for clear-all/refresh
(`economy.workorders_clear` / `economy.cache_refresh`) and per-user rate-limit
keys on all four economy limiters.
