# `@moneypenny/ts6-client`

TeamSpeak 3/6 dual-protocol client used by Moneypenny.

Extracted from `bot/src/ts-protocol/` (PR-B1). Wraps
[`@honeybbq/teamspeak-client`](https://www.npmjs.com/package/@honeybbq/teamspeak-client)
with HTTP Query (TS6), channel presence helpers, move resolution, file-list
parsing, and voice transport health.

## Usage

```ts
import { TS3Client, type Ts6Logger } from "@moneypenny/ts6-client";

const client = new TS3Client(
  { host, port, queryPort, nickname },
  logger as Ts6Logger, // pino is fine
);
await client.connect();
```

## Scripts

```bash
# from bot/ (workspace root)
npm run build -w @moneypenny/ts6-client
npm run test -w @moneypenny/ts6-client
```

Build emits `dist/` (gitignored). The bot package builds this workspace first.
