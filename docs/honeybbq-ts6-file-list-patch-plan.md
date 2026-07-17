> **HISTORICAL ARCHIVE** — point-in-time audit/notes. Paths and stack may be stale
> (e.g. `bot/src/ts-protocol`, `web/server.ts`, Qdrant). Current operator truth:
> [AGENTS.md](../AGENTS.md), [docs/editions.md](./editions.md), [docs/ts6-client.md](./ts6-client.md),
> [docs/rag-embeddings.md](./rag-embeddings.md), [docs/http-openapi.md](./http-openapi.md).

# Future plan: `@honeybbq/teamspeak-client` — `notifychannelfilelist`

**Status:** deferred (disk-mount path ships first for co-located Pi deploy).

## Problem

TeamSpeak file-drop needs to **list** files in a channel's file repository (`ftgetfilelist`). Two protocol paths exist; both are blocked today:

| Path | What happens on TS6 6.0.0-beta11 |
|------|----------------------------------|
| Full client `ftgetfilelist` | Server replies with `notifychannelfilelist` notifications. `@honeybbq/teamspeak-client` only registers 8 notification handlers — **`notifychannelfilelist` is not one** — so `execCommandWithResponse` always sees an empty list. |
| HTTP Query `GET /1/ftgetfilelist` | Returns `401` / code `5120` **out of scope** even with a full **manage** API key. File-transfer commands are not exposed to WebQuery in this beta. |

Download (`notifystartdownload` → `downloadFileData`) **does** work via the full client once a file is known.

## Goal

Restore protocol-correct listing for **remote** deployments (bot and TS server on different hosts) without bind-mounting the server's `files/` tree.

## Recommended approach

1. **Upstream issue / PR** to `@honeybbq/teamspeak-client` (preferred long-term):
   - Add `notifychannelfilelist` to the client's notification dispatch table.
   - Buffer rows until the matching `ftgetfilelist` command completes (same pattern as other multi-row notifications).
   - Export typed `ChannelFile` rows (name, size, datetime, type).
   - Add a unit test with a captured notification payload.

2. **Short-term fork** via `patch-package` (if upstream is slow):
   - Locate the minified notification router in `node_modules/@honeybbq/teamspeak-client/dist/`.
   - Add handler id for `notifychannelfilelist` (grep TS6 server sources or capture with wire logging).
   - Wire `fileTransferInitDownload` path unchanged.
   - Pin exact package version; re-validate on every TS6 server upgrade.

3. **Moneypenny integration** (after library fix):
   - Change `TS3Client.listChannelFiles` to prefer full-client listing when connected.
   - Keep HTTP Query as fallback for headless / query-only contexts.
   - Keep disk-mount (`TS6_FILES_DIR`) as an opt-in fast path when co-located.
   - Extend `bot/src/ts-protocol/ftfilelist.test.ts` with notification reassembly cases.

## Verification checklist

- [ ] `ftgetfilelist` on channel `moneypenny-drop` returns `recruitment spiel.md` (or test fixture) via full client.
- [ ] Subfolder recursion still works (`/sub/nested.md`).
- [ ] File-drop end-to-end without `TS6_FILES_DIR` set.
- [ ] Existing avatar upload/download FT paths unaffected.

## References

- Watcher: `bot/src/ingest/file-drop.ts`
- Parser (already tested): `bot/src/ts-protocol/client.ts` — `parseFtFileList`
- Disk workaround: `bot/src/ingest/file-drop-disk.ts`
- Test fixture filename: `recruitment spiel.md` (see `bot/src/ts-protocol/ftfilelist.test.ts`)