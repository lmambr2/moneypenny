# TS6 ServerQuery command reference (design notes)

**Status:** reference / design aid — not a runtime dependency  
**Last updated:** 2026-07-09  

Cheat sheet of **TeamSpeak 6 ServerQuery** verbs as exposed on TS6 (SSH /
WebQuery lineage). Use when extending `TS6HttpQuery`, SSH ops, moderation, or
file-drop — **not** as a substitute for the full-client voice bot.

---

## How Moneypenny talks to TS today

| Path | Role | Library / code |
|------|------|----------------|
| **Full client** (primary) | Voice, channel chat, poke, presence events | `@honeybbq/teamspeak-client` → `@moneypenny/ts6-client` (`bot/packages/ts6-client`) |
| **HTTP Query** (optional) | Group enrichment, some admin reads | `TS6HttpQuery` + `TS6_QUERY_HOST` / `TS6_API_KEY` |
| **SSH Query** (ops only) | Manual admin / tooling | `ssh -p 10022 …` per TS6 server config |

**Alone-stop / radio presence** use full-client **`clientEnter` / `clientLeave` /
`clientMoved`** (+ `listClients` recount), not ServerQuery polling.

**Do not** replace honeybbq with a pure Query client for the music bot (no voice).

Related: [feature-roadmap.md](./feature-roadmap.md) (teamspeak.js watch note),
[rank-gating.md](./rank-gating.md) (HTTP Query groups),
[hardening.md](./hardening.md) (query ports).

---

## Source of this list

Command overview text adapted from the MIT project
[jxcsx/ts6-query-web-interface](https://github.com/jxcsx/ts6-query-web-interface)
(`cmds.txt` — “ts6 query cmd's exported”). That app is a small SSH Query + React
admin UI; we **do not depend on it**. We only keep the verb list as design
reference.

Official TS6 server config / Query: [teamspeak6-server CONFIG.md](https://github.com/teamspeak/teamspeak6-server/blob/main/CONFIG.md).

---

## Command overview (by area)

### Session / instance

| Command | Summary |
|---------|---------|
| `login` | Authenticate with the server |
| `logout` | Deselect virtual server and log out |
| `quit` | Close connection |
| `use` | Select virtual server |
| `whoami` | Display current session info |
| `version` | Display version information |
| `hostinfo` | Display server instance connection info |
| `instanceinfo` | Display server instance properties |
| `instanceedit` | Change server instance properties |
| `bindinglist` | List IP addresses used by the server instance |
| `help` | Read help files |

### Virtual server

| Command | Summary |
|---------|---------|
| `serverlist` | List virtual servers |
| `serverinfo` | Display virtual server properties |
| `serveredit` | Change virtual server properties |
| `servercreate` | Create a virtual server |
| `serverdelete` | Delete a virtual server |
| `serverstart` | Start a virtual server |
| `serverstop` | Stop a virtual server |
| `serverprocessstop` | Shutdown server process |
| `serveridgetbyport` | Find database ID by virtual server port |
| `serverrequestconnectioninfo` | Display virtual server connection info |
| `serversnapshotcreate` | Create snapshot of a virtual server |
| `serversnapshotdeploy` | Deploy snapshot of a virtual server |
| `servertemppasswordadd` | Create a temporary server password |
| `servertemppassworddel` | Delete a temporary server password |
| `servertemppasswordlist` | List temporary server passwords |

### Events (Query notify — not full-client voice events)

| Command | Summary |
|---------|---------|
| `servernotifyregister` | Register for event notifications |
| `servernotifyunregister` | Unregister from event notifications |

Moneypenny presence prefers **full-client** notifies via honeybbq. Query
`servernotifyregister` is relevant only for a pure-Query sidecar.

### Clients (online)

| Command | Summary |
|---------|---------|
| `clientlist` | List clients online on a virtual server |
| `clientinfo` | Display client properties |
| `clientfind` | Find client by nickname |
| `clientmove` | Move a client |
| `clientkick` | Kick a client |
| `clientpoke` | Poke a client |
| `clientedit` | Change client properties |
| `clientupdate` | Set own properties |
| `clientaddperm` | Assign permission to client |
| `clientdelperm` | Remove permission from client |
| `clientpermlist` | List client-specific permissions |
| `clientgetdbidfromuid` | Find client database ID by UID |
| `clientgetids` | Find client IDs by UID |
| `clientgetnamefromdbid` | Find client nickname by database ID |
| `clientgetnamefromuid` | Find client nickname by UID |
| `clientgetuidfromclid` | Find client UID by client ID |
| `clientsetserverquerylogin` | Set own login credentials |
| `setclientchannelgroup` | Set a client’s channel group |

**Moneypenny touchpoints:** moderation poke/kick ideas; group enrichment already
uses `clientlist` / `clientinfo` style data via HTTP Query when configured.

### Clients (database / offline identity)

| Command | Summary |
|---------|---------|
| `clientdblist` | List known client UIDs |
| `clientdbinfo` | Display client database properties |
| `clientdbfind` | Find client database ID by nickname or UID |
| `clientdbedit` | Change client database properties |
| `clientdbdelete` | Delete client database properties |

### Channels

| Command | Summary |
|---------|---------|
| `channellist` | List channels on a virtual server |
| `channelinfo` | Display channel properties |
| `channelfind` | Find channel by name |
| `channelcreate` | Create a channel |
| `channeldelete` | Delete a channel |
| `channeledit` | Change channel properties |
| `channelmove` | Move channel to new parent |
| `channeladdperm` | Assign permission to channel |
| `channeldelperm` | Remove permission from channel |
| `channelpermlist` | List channel-specific permissions |
| `channelclientaddperm` | Assign permission to channel–client combo |
| `channelclientdelperm` | Remove permission from channel–client combo |
| `channelclientpermlist` | List channel–client specific permissions |

### Channel groups

| Command | Summary |
|---------|---------|
| `channelgrouplist` | List channel groups |
| `channelgroupadd` | Create a channel group |
| `channelgroupdel` | Delete a channel group |
| `channelgrouprename` | Rename a channel group |
| `channelgroupcopy` | Copy a channel group |
| `channelgroupaddperm` | Assign permission to channel group |
| `channelgroupdelperm` | Remove permission from channel group |
| `channelgrouppermlist` | List channel group permissions |
| `channelgroupclientlist` | Find channel groups by client ID |

### Server groups

| Command | Summary |
|---------|---------|
| `servergrouplist` | List server groups |
| `servergroupadd` | Create a server group |
| `servergroupdel` | Delete a server group |
| `servergrouprename` | Rename a server group |
| `servergroupcopy` | Create a copy of an existing server group |
| `servergroupaddclient` | Add client to server group |
| `servergroupdelclient` | Remove client from server group |
| `servergroupclientlist` | List clients in a server group |
| `servergroupsbyclientid` | Get all server groups of specified client |
| `servergroupaddperm` | Assign permissions to server group |
| `servergroupdelperm` | Remove permissions from server group |
| `servergrouppermlist` | List server group permissions |
| `servergroupautoaddperm` | Globally assign permissions to server groups |
| `servergroupautodelperm` | Globally remove permissions from server group |

**Moneypenny touchpoints:** rank gating / rights (server group IDs).

### Permissions

| Command | Summary |
|---------|---------|
| `permissionlist` | List permissions available |
| `permidgetbyname` | Find permission ID by name |
| `permget` | Display client permission value for yourself |
| `permfind` | Find permission assignments by ID |
| `permoverview` | Display client permission overview |
| `permreset` | Delete all server and channel groups and restore defaults |

### Privilege keys / tokens

| Command | Summary |
|---------|---------|
| `privilegekeyadd` | Create a privilege key |
| `privilegekeydelete` | Delete a privilege key |
| `privilegekeylist` | List privilege keys |
| `privilegekeyuse` | Use a privilege key |
| `tokenadd` | Alias for `privilegekeyadd` |
| `tokendelete` | Alias for `privilegekeydelete` |
| `tokenlist` | Alias for `privilegekeylist` |
| `tokenuse` | Alias for `privilegekeyuse` |

### Query logins & API keys (TS6-oriented)

| Command | Summary |
|---------|---------|
| `queryloginadd` | Add a query client login |
| `querylogindel` | Remove a query client login |
| `queryloginlist` | List all query client logins |
| `apikeyadd` | Create an API key |
| `apikeydel` | Delete an API key |
| `apikeylist` | List API keys |
| `authenticationtoken` | Create an authentication token |
| `chatlogintoken` | Create login token for Matrix chat |

### Messaging

| Command | Summary |
|---------|---------|
| `sendtextmessage` | Send text message |
| `gm` | Send global text message |
| `messageadd` | Send an offline message |
| `messagedel` | Delete an offline message from your inbox |
| `messageget` | Display an offline message from your inbox |
| `messagelist` | List offline messages from your inbox |
| `messageupdateflag` | Mark an offline message as read |

### Bans & complaints

| Command | Summary |
|---------|---------|
| `banadd` | Create a ban rule |
| `banclient` | Ban a client |
| `bandel` | Delete a ban rule |
| `bandelall` | Delete all ban rules |
| `banfind` | Find bans on a virtual server |
| `banlist` | List ban rules on a virtual server |
| `complainadd` | Create a client complaint |
| `complaindel` | Delete a client complaint |
| `complaindelall` | Delete all client complaints |
| `complainlist` | List client complaints on a virtual server |

### Custom client properties

| Command | Summary |
|---------|---------|
| `custominfo` | Display custom client properties |
| `customsearch` | Search for custom client properties |
| `customset` | Add or update a custom client property |
| `customdelete` | Remove a custom client property |

### File transfer

| Command | Summary |
|---------|---------|
| `ftcreatedir` | Create a directory |
| `ftdeletefile` | Delete a file |
| `ftgetfileinfo` | Display details about a file |
| `ftgetfilelist` | List files stored in a channel filebase |
| `ftinitdownload` | Init a file download |
| `ftinitupload` | Init a file upload |
| `ftlist` | List active file transfers |
| `ftrenamefile` | Rename a file |
| `ftstop` | Stop a file transfer |
| `ftgetchannelfilehttptoken` | Create a login token for HTTP file transfer |

**Moneypenny touchpoints:** channel file drop / `ftgetfilelist` history (see
[honeybbq-ts6-file-list-patch-plan.md](./honeybbq-ts6-file-list-patch-plan.md)).

### Logs & license

| Command | Summary |
|---------|---------|
| `logadd` | Add custom entry to log |
| `logview` | List recent log entries |
| `licensesignmessage` | Sign arbitrary message with license key |

---

## Design rules when using Query from Moneypenny

1. **Prefer full client** for anything in-channel (voice, chat, poke, membership events).
2. **Prefer HTTP Query** for read-only enrichment already supported (`clientlist` flags, groups) when `TS6_API_KEY` is set.
3. **SSH Query** is for operators and rare tools — never put `serveradmin` password in the Vue dashboard.
4. **Never** open raw “send any query command” to the public web (the jxcsx Socket.IO pattern is a footgun).
5. Rate-limit Query (TS historically throttles bursty clients).
6. Re-verify verbs after TS6 server upgrades — this list is a snapshot from community export, not CIG’s live help tree.

---

## Full alphabetical dump (source export)

For grepping / completeness, the same overview as captured in upstream `cmds.txt`:

```
apikeyadd, apikeydel, apikeylist, authenticationtoken,
banadd, banclient, bandel, bandelall, banfind, banlist, bindinglist,
channeladdperm, channelclientaddperm, channelclientdelperm, channelclientpermlist,
channelcreate, channeldelete, channeldelperm, channeledit, channelfind,
channelgroupadd, channelgroupaddperm, channelgroupclientlist, channelgroupcopy,
channelgroupdel, channelgroupdelperm, channelgrouplist, channelgrouppermlist,
channelgrouprename, channelinfo, channellist, channelmove, channelpermlist,
chatlogintoken,
clientaddperm, clientdbdelete, clientdbedit, clientdbfind, clientdbinfo,
clientdblist, clientdelperm, clientedit, clientfind, clientgetdbidfromuid,
clientgetids, clientgetnamefromdbid, clientgetnamefromuid, clientgetuidfromclid,
clientinfo, clientkick, clientlist, clientmove, clientpermlist, clientpoke,
clientsetserverquerylogin, clientupdate,
complainadd, complaindel, complaindelall, complainlist,
custominfo, customsearch, customset, customdelete,
ftcreatedir, ftdeletefile, ftgetchannelfilehttptoken, ftgetfileinfo, ftgetfilelist,
ftinitdownload, ftinitupload, ftlist, ftrenamefile, ftstop,
gm, help, hostinfo, instanceedit, instanceinfo, licensesignmessage,
logadd, login, logout, logview,
messageadd, messagedel, messageget, messagelist, messageupdateflag,
permfind, permget, permidgetbyname, permissionlist, permoverview, permreset,
privilegekeyadd, privilegekeydelete, privilegekeylist, privilegekeyuse,
queryloginadd, querylogindel, queryloginlist, quit,
sendtextmessage, servercreate, serverdelete, serveredit,
servergroupadd, servergroupaddclient, servergroupaddperm, servergroupautoaddperm,
servergroupautodelperm, servergroupclientlist, servergroupcopy, servergroupdel,
servergroupdelclient, servergroupdelperm, servergrouplist, servergrouppermlist,
servergrouprename, servergroupsbyclientid, serveridgetbyport, serverinfo,
serverlist, servernotifyregister, servernotifyunregister, serverprocessstop,
serverrequestconnectioninfo, serversnapshotcreate, serversnapshotdeploy,
serverstart, serverstop, servertemppasswordadd, servertemppassworddel,
servertemppasswordlist, setclientchannelgroup,
tokenadd, tokendelete, tokenlist, tokenuse, use, version, whoami
```

---

## Changelog

| Date | Note |
|------|------|
| 2026-07-09 | Initial import of command overview from jxcsx `cmds.txt` + Moneypenny path map |
