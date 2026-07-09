# Star Citizen / org status bridge (G2)

Optional HTTP bridge used by `!ops sc` and the `sc-org` external status plugin.
**Fail-open:** if the URL is unset or the bridge is down, ops returns a clear
message and **never** blocks music or transport.

## Configure

**Settings → AI:** *Star Citizen org status URL* + optional *Org display name*  
or env: `SC_ORG_STATUS_URL`, `SC_ORG_NAME`.

```bash
# .env
SC_ORG_STATUS_URL=http://192.168.1.89:9100
SC_ORG_NAME=MyOrg
```

## Contract

Base URL has no trailing path. Bridge implements any subset:

| Method | Path | Body |
|--------|------|------|
| GET | `/health` | `{ "ok": true }` |
| GET | `/status` | `{ "status": "green", "membersOnline": 4, "summary": "…", "org": "…" }` |
| GET | `/members` | `{ "members": [{ "name": "Alice", "rank": "FC", "online": true }] }` |
| GET | `/fleet` | `{ "vessels": [{ "name": "Idris", "role": "flag" }], "summary": "…" }` |

Aliases accepted on `/status`: `state` for `status`, `online` for `membersOnline`.

Client: `bot/src/tools/sc-org-client.ts`  
Plugin: `createStarCitizenOrgStatusPlugin` in `external-status.ts`.

## Smoke

```bash
# With a running bridge
curl -s "$SC_ORG_STATUS_URL/status" | jq .
# In TS / dashboard
!ops sc
!ops status
# Admin Harness → Ops status
```

Without a bridge, `!ops sc` should say unavailable and leave playback alone.
