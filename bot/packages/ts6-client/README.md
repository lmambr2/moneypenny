# `@moneypenny/ts6-client`

TeamSpeak 3/6 dual-protocol client used by Moneypenny.

Extracted from `bot/src/ts-protocol/` (PR-B1). Public surface locked in PR-B2.
Wraps [`@honeybbq/teamspeak-client`](https://www.npmjs.com/package/@honeybbq/teamspeak-client)
with HTTP Query (TS6), channel presence helpers, move resolution, file-list
parsing, and voice transport health.

**Prefer:** `import { … } from "@moneypenny/ts6-client"`  
**Avoid:** deep subpaths for host code (subpaths remain for advanced/tools only).

## Public surface

| Area | Import |
|------|--------|
| Connect | `TS3Client`, `TS3ClientOptions`, `detectServerProtocol`, `ServerProtocol` |
| Text / poke | `TS3TextMessage`, `TS3Poke`, `escapeTS3` |
| Voice | `TS3VoiceData`, `CODEC_OPUS_VOICE`, `CODEC_OPUS_MUSIC`, `ensureInboundVoiceCapture` (on client) |
| File drop | `ChannelFile`, `parseFtFileList`, list/upload/download methods on client |
| Query | `HttpQueryError`, `TS6HttpQuery`, `QueryClient` |
| Logger | inject `Ts6Logger` (pino duck-type) — package does **not** import bot logger |

### Events (`TS3Client`)

| Event | Payload | Used for |
|-------|---------|----------|
| `connected` | — | lifecycle |
| `disconnected` | — | reconnect |
| `textMessage` | `TS3TextMessage` | `!` commands / chat |
| `poke` | `TS3Poke` | poke-as-command |
| `voiceData` | `TS3VoiceData` | STT capture |
| `clientEnter` / `Leave` / `Moved` | library client info | alone-stop, radio presence |
| `voiceTransportUnhealthy` | — | fail-open / reconnect (S-OC2) |

See `TS3ClientEventMap` for the typed list.

## Dual protocol detect (PR-B3)

`connect()` auto-detects TS3 vs TS6 unless `serverProtocol` is forced:

1. TCP probe **10011** — TS3 ServerQuery banner starting with `TS3`
2. HTTP probe **10080** — TS6 HTTP Query responds
3. Prefer TS3 if both answer (rare); else `unknown` (voice-only may still work)

```ts
import { detectServerProtocol, TS3Client } from "@moneypenny/ts6-client";

const probe = await detectServerProtocol("ts.example.net");
// { protocol: "ts6" | "ts3" | "unknown", queryPort, voicePort }

const client = new TS3Client(
  {
    host: "ts.example.net",
    port: 9987,
    queryPort: probe.queryPort ?? 10080,
    nickname: "Moneypenny",
    serverProtocol: probe.protocol === "unknown" ? undefined : probe.protocol,
    ts6ApiKey: process.env.TS6_API_KEY, // TS6 HTTP Query
  },
  logger,
);
await client.connect();
console.log(client.getServerProtocol()); // "ts3" | "ts6" | "unknown"
```

Operator docs: [docs/ts6-client.md](../../../docs/ts6-client.md) (repo root).

## Usage (minimal)

```ts
import { TS3Client, type Ts6Logger } from "@moneypenny/ts6-client";

const client = new TS3Client(
  { host, port, queryPort, nickname },
  logger as Ts6Logger,
);
await client.connect();
client.on("textMessage", (msg) => { /* … */ });
```

## Scripts

```bash
# from bot/ (workspace root)
npm run build -w @moneypenny/ts6-client
npm run test -w @moneypenny/ts6-client
```

Build emits `dist/` (gitignored). The bot package builds this workspace first.

## Out of scope (PR-B4 deferred)

Rust Opus/VAD via Neon — only if profiled as a bottleneck after B1–B3 are stable.
