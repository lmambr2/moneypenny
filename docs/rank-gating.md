# Rank gating (TeamSpeak server groups)

Moneypenny maps **TeamSpeak server-group IDs** to command and doctrine permissions.
Typed chat, voice, LLM tool calls, and the web player all go through the same
`RightsEngine` — natural language cannot escalate past what the invoker's rank allows.

Starter template: [`scripts/rights-rank-gating.json`](../scripts/rights-rank-gating.json).
Replace every `serverGroups` value with the numeric IDs from **your** TS6 server
(TeamSpeak → Server Groups). Copy the finished `rights` object into
`bot/data/config.json` with `rightsEnabled: true`.

---

## How subjects are resolved

1. **TeamSpeak chat / voice** — match the invoker's UID (and `invokerId` / clid) against
   clients in the bot's channel, then read `serverGroups`.
2. **TS6 caveat** — the full-client `clientlist` often omits `client_servergroups`.
   When HTTP Query is configured (`TS6_QUERY_HOST`, `TS6_API_KEY`), the bot enriches
   groups via `clientlist?-groups` and falls back to `clientinfo` by clid
   (`bot/src/bot/rights/subject.ts`).
3. **Web UI (members)** — match the logged-in username to a TS nickname in the bot's
   channel and inherit that client's groups.
4. **Web UI (admins)** — inherit `adminGroups` from config when not nickname-matched.
5. **Lookup failure** → empty groups (lowest privilege; never grants on error).

Debug effective permissions (admin only):

```http
GET /api/bot/rights/debug?groups=<your-officer-sgid>,<your-admin-sgid>
GET /api/bot/rights/debug?uid=<ts-uid>&groups=<sgid>,<sgid>
```

Also available under **Settings → Rights debug**.

---

## Evaluation model

1. Start from `defaultAllow` (public music, `!ask`, roast/memory, etc.).
2. Walk `rules` in order; each matching rule applies `allow` then `deny`.
3. Tokens like `@admin` expand via `commandGroups`.
4. `superAdminUids` bypass all checks.
5. Rules may set `scope: "voice"` or `"chat"` to limit a surface.

---

## Command groups (template)

| Group | Commands |
|-------|----------|
| `@dj` | `stop`, `clear`, `vol`, `mode`, `remove`, `radio.ops`, `radio.bumper`, `radio.say`, `radio.skip`, `radio.tags` |
| `@mod` | `move`, `moveclient`, `moveall`, `follow` |
| `@admin` | All `@dj` + `@mod` + `reindex`, `ingeststatus`, `radio.power` |
| `@analyst` | `analyst`, `agent` |

`radio.*` are **sub-command tokens**, not typed commands: `!radio` itself is
public (status / `ops list`), but the router additionally checks `radio.power`
for `on`/`off`, `radio.ops` for `ops <profile>`, and `radio.bumper`/`radio.say`/
`radio.skip` for the operator controls ([docs/radio.md](./radio.md) §12). So a
section lead in `@dj` can run the station's *programming* without holding
`radio.power` or any transport-admin rights. `radio.tags` gates the tag-edit API for chat/voice. The web
`PATCH /api/music/tracks/:id/tags` endpoint is **admin-only** in v1 (uses
`requireAdmin`, not `canWebUserRunCommand('radio.tags')` yet).

---

## Rank tiers (example hierarchy)

Map each row to a **server-group ID on your server** in `rights.rules[].match.serverGroups`.
Names are illustrative — use whatever your TS groups are actually called.

| Example role | Typical access |
|--------------|----------------|
| Guest | Public commands only; `@admin` / `@dj` / `@mod` / `@analyst` **denied** |
| Cadet | Public + `@dj`; no mod/admin/analyst |
| Specialist | `doctrine:restricted`; optional voice-only `stop` |
| Junior NCO | `@dj` + `doctrine:restricted` (no `follow` / mass move) |
| Senior NCO / Chief | `@dj` + `@mod` + restricted + **confidential** docs |
| Field-grade officer | Full `@admin` + restricted + confidential + **secret** docs |
| General / command staff | `@admin` + `@analyst` + all doctrine levels |
| Server admin | Same as top command tier (or your highest trust group); also `test.skip` |
| Chairman (if separate SG) | Same as top command tier + `test.skip` (skip/clear the `!test` demo only) |
| Department staff | `doctrine:restricted` only (no DJ/admin unless they also hold another group) |

### `test.skip` — protect the `!test` demo track

`!skip` / `!next` / `!clear` / `!stop` while the demo is playing require the
**`test.skip`** token. It is **not** part of `@admin` or `@dj`, so colonels and
other officers keep normal clear/stop for station music but cannot end the
smoke track. Grant `test.skip` only on your **server-admin** and **Chairman**
rules (see production names `server-admin` / `chairman`).
(`!jump` / `!go` that replace the demo also need the same gate where enforced.)

### `ships.org` — org hangar rollup (Colonel / Chairman)

Personal hangars (`!ships add/list/…`) are on **defaultAllow** for everyone.
Org commands and editing others need the **`ships.org`** token:

| Command | Token |
|---------|--------|
| `!ships` / `!ships add` (self) | public (`ships`) |
| `!ships org` / `org who` / `org of` / `org list` | `ships.org` |
| `!ships add for <nick>` / `import` / `export` | `ships.org` |

Production rules (migration v12): `colonel-officer`, `chairman`, `server-admin`,
`coc-staff`, `csa-staff`. Template: field-grade / command-staff / server-admin.

Org export rewrites doctrine **`Ship_List.md`** (`classification: secret`) for RAG.
After export, run **`!reindex`**. Personal hangars never feed radio memory bumpers.

Set `adminGroups` to the server-group IDs that should inherit admin rights for
web UI users who are not nickname-matched in-channel (usually your officer and
server-admin groups).

---

## Doctrine classifications

Frontmatter `classification:` on each `.md` doc maps to `doctrine:<level>` rights:

| Level | Typical clearance (configure per rule) |
|-------|----------------------------------------|
| `unclassified` | Everyone |
| `restricted` | Specialist tier and above |
| `confidential` | Senior NCO / chief tier and above |
| `secret` | Field-grade officer tier and above |

See [rag-ingestion.md](./rag-ingestion.md) for how classification is set at ingest time.

---

## Customizing

1. Look up your server-group IDs in TS6 (or `GET /1/servergrouplist` via HTTP Query).
2. Edit `scripts/rights-rank-gating.json` (or paste into Settings → advanced rights JSON).
3. Set `rightsEnabled: true` and `adminGroups` to your trusted admin/officer sgids.
4. Hot-reload via Settings save or `BotInstance.updateRights()`.
5. Verify with `/api/bot/rights/debug` before relying on it in production.

For the underlying model see **DESIGN.md §8**.