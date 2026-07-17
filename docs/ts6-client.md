# `@moneypenny/ts6-client` — dual-protocol client

**Status:** shipped (PR-B1 extract, PR-B2 public surface, PR-B3 docs)  
**Package:** `bot/packages/ts6-client`  
**Import:** `import { TS3Client, … } from "@moneypenny/ts6-client"`

This is the **only** TeamSpeak transport boundary for the station process. Music
fail-open, alone-stop, voice STT, and file-drop all go through this package —
not a pure ServerQuery bot.

---

## Roles

| Path | Role |
|------|------|
| **Full client** (`TS3Client` + `@honeybbq/teamspeak-client`) | Voice UDP, channel chat, poke, presence events, file transfer |
| **HTTP Query** (`TS6HttpQuery`, optional) | Server groups, some admin reads (TS6 + API key) |
| **SSH Query** | Ops / manual only — not in the bot process |

**Do not** replace the full client with Query-only for the music bot (no Opus).

Related: [ts6-serverquery-commands.md](./ts6-serverquery-commands.md),
[rank-gating.md](./rank-gating.md), [hardening.md](./hardening.md).

---

## Dual-protocol detection

TeamSpeak 3 and TeamSpeak 6 share voice port **9987** but differ on query:

| | TS3 | TS6 |
|---|-----|-----|
| Query | TCP **10011** ServerQuery (banner `TS3…`) | HTTP **10080** WebQuery |
| Auth for groups | often identity / server groups via full client | optional `TS6_API_KEY` HTTP Query |

### Algorithm (`detectServerProtocol`)

1. In parallel (default 3s timeout):
   - TCP connect to `ts3QueryPort` (default 10011); success if banner starts with `TS3`
   - HTTP GET to `ts6HttpPort` (default 10080); success if any valid HTTP response
2. Prefer **TS3** if both succeed (unusual dual stack)
3. Else return the one that responded, or `protocol: "unknown"`

`TS3Client.connect()` runs the same detection unless
`options.serverProtocol` is set (`"ts3"` | `"ts6"`). After connect,
`getServerProtocol()` reflects the active mode.

### Operator env (typical)

```bash
# Voice
TS_HOST=…
TS_PORT=9987

# Query port: 10011 (TS3) or 10080 (TS6 HTTP)
TS_QUERY_PORT=10080

# TS6 HTTP Query (groups enrichment / some admin)
TS6_API_KEY=…
# Optional separate query host if voice and query differ
TS6_QUERY_HOST=…
```

Exact env names live in `bot` config / `.env.example` — keep query ports
off the public internet ([hardening.md](./hardening.md)).

### Smoke checks

| Edition | Check |
|---------|--------|
| **SBC / Server** | Bot log: `Using forced server protocol` or `Detecting server protocol` then connect success |
| **TS6** | `getServerProtocol() === "ts6"`; optional HTTP Query groups on join |
| **TS3** | Banner path; no `TS6_API_KEY` required for basic music |
| **Both** | `!skip` / local play still work if LLM is down (fail-open; not this package’s job) |

Unit test: package `protocol-detect.test.ts` (unreachable host → `unknown`).

---

## Public surface (hosts)

Station code (BotInstance, ingest, control types) should import **only** the
package root. Subpaths (`/voice`, `/http-query`, …) are for advanced tools.

| Concern | API |
|---------|-----|
| Connect / disconnect | `new TS3Client(opts, logger)`, `connect()`, events `connected` / `disconnected` |
| Text | `sendTextMessage`, event `textMessage` |
| Poke | `pokeClient`, event `poke` |
| Voice in/out | `ensureInboundVoiceCapture`, event `voiceData`, `sendVoiceData`, codecs |
| File drop | `listChannelFiles`, upload/download helpers, `ChannelFile` / `parseFtFileList` |
| Presence | `clientEnter` / `clientLeave` / `clientMoved`, `getClientsInChannel` |
| Move | `moveClientToChannel`, move-resolver pure helpers |

Logger: inject any pino-compatible `Ts6Logger` — the package never imports
`bot/src/logger.ts`.

---

## Phase B roadmap

| Step | Status |
|------|--------|
| **B1** Workspace package extract | Done |
| **B2** Public surface; host uses barrel only | Done |
| **B3** Dual-protocol docs + smoke notes | Done (this doc) |
| **B4** Rust Opus/VAD N-API (`@moneypenny/audio-native`) | Done (optional; falls back to `@discordjs/opus`) |

Related (separate packages/layers): Nest HTTP app (`bot/src/http/`), brain
`POST /v1/turn` (`bot/src/brain/`). This package stays TS6-only.

---

## Development

```bash
cd bot
npm run build -w @moneypenny/ts6-client
npm run test -w @moneypenny/ts6-client
```
