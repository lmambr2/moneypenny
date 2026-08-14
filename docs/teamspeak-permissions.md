# Moneypenny — minimum TeamSpeak permissions

Derived from the code on 2026-07-26, not from guesswork: every entry below names
the call site that needs it. The goal is to replace a blanket **Server Admin**
grant with a purpose-built server group, so a leaked bot token cannot administer
the server.

> **Verify names against your server.** These are TS3-lineage permission
> identifiers. The deployment runs a TeamSpeak **6 beta** server, where some
> names differ or do not exist. Treat this as the required *capability* list and
> map each line to the actual permission your server exposes — the capabilities
> are derived from code and are correct; the exact spellings may not be.

## Why bother

Server Admin is what set `i_client_needed_move_power = 75` on the bot, which is
what stopped Colonels (`i_client_move_power = 65`) dragging her between
channels. That specific problem was solved by raising the Colonel group, which
is correct on its own merits — officers should be able to move people. What
remains is blast radius: the bot holds a token, and that token currently has
full server administration.

## What she actually needs

### Presence and channels

| Capability | Why | Call site |
|---|---|---|
| Join the virtual server | Connect at all | `TS3Client.connect` |
| Join / switch channels | `!move`, follow-the-crowd, returning to her channel | `joinChannel`, `joinChannelById` |
| See the channel list | Resolve a channel by name (AFK exclusion, drop channel) | `resolveChannelIdByName` |
| See the client list | Presence gating, radio `minPresent`, idle disconnect, auto-follow | `getClientsInChannel`, `getAllClients`, `listClientsInCurrentChannel` |
| Read other clients' server groups | **Rank gating** — every rights decision keys off this | `getServerGroupsForClient` |

Her `i_channel_join_power` must clear `i_channel_needed_join_power` on any
channel she is expected to enter, including the ones she may auto-follow into.

### Voice

| Capability | Why | Call site |
|---|---|---|
| Speak in channel | All music and TTS output | `sendVoiceData` |
| Receive voice | STT / wake word | `ensureInboundVoiceCapture` |

`i_client_talk_power` must clear `i_channel_needed_talk_power` on channels where
she plays. In a moderated channel she also needs talker status.

### Text and poke

| Capability | Why | Call site |
|---|---|---|
| Send private text | Command replies | `sendTextMessage` (8 sites) |
| Send channel text | Announcements, `!ingeststatus` | `sendChannelMessage` |
| Poke a client | The *entire* implementation of `!kick` / `!mute` — see below | `pokeClient` |

`i_client_poke_power` must clear the target's `i_client_needed_poke_power`.

### Moving other clients

| Capability | Why | Call site |
|---|---|---|
| Move a client | `!move`, `!moveclient`, `!moveall`, `!follow` | `moveClientToChannel` (2 sites) |

Her `i_client_move_power` must clear each target's
`i_client_needed_move_power`. This is the only genuinely privileged thing she
does, and it is the one to think hardest about — a group with move power over
everyone can relocate the whole server.

### Own profile

| Capability | Why | Call site |
|---|---|---|
| Change own nickname / away | Now-playing in the nickname, away status | `clientupdate` in `bot/src/bot/profile.ts` |
| Change own description | Status line | same |
| Upload / delete own avatar | Album art as avatar | `fileTransferInitUpload`, `uploadFileData`, `fileTransferDeleteFile` on channel `0`, path `/avatar` |

The avatar path is ordinary file transfer against the virtual server's avatar
storage, so it needs upload and delete power there plus a large enough
`i_client_max_avatar_filesize`.

### File drop ingestion

| Capability | Why | Call site |
|---|---|---|
| Browse files in a channel | Poll the `moneypenny-drop` channel | `listChannelFiles` |
| Download files from a channel | Ingest dropped `.md` / audio | `fileTransferInitDownload`, `downloadFileData` |

Needed **only** on the drop channel, not server-wide. Her file browse and
download power must clear that channel's needed values.

> On the current deploy the drop watcher runs in client mode (`disk: false`). If
> you switch it to the disk-mount path (`TS6_FILES_DIR`,
> `ingest/file-drop-disk.ts`) she reads the files from the filesystem instead
> and needs **no** file-transfer permissions at all — worth considering, since
> it removes a whole capability class.

## What she does NOT need

Worth stating explicitly, because these are the ones people assume a "bot admin"
group must have:

- **Kick.** `!kick` does not kick. It pokes the target and returns
  `"kick requested … apply via server groups if API unavailable"`
  (`bot/src/bot/instance.ts`). No kick permission is used.
- **Mute.** Identical — advisory only, implemented as a poke.
- **Ban.** `!ban` / `!unban` write to the bot's own playback blacklist
  (`music/playback-blacklist.ts`). It bans *tracks*, not people, and never
  touches the TS ban list.
- **Create, edit, or delete channels.** She only joins and lists them.
- **Edit server settings or permanent rank groups.** Rank gating only *reads*
  group membership. Optional exception: when `sessionRoles.groupIds` is set,
  `!session clear` uses Query `servergroupdelclient` **only** for those
  allowlisted temporary Session / role groups (never permanent rights IDs).
- **Upload files to a channel.** The only upload is her own avatar.
- **Server-wide file browse.** Only the drop channel.

## Suggested shape

One group, `Moneypenny Bot`, with:

- join + talk power sufficient for the channels she works in
- client list, channel list, and server-group *read*
- move power set to the lowest value that still clears the people she is
  expected to move
- poke power
- private + channel text
- own nickname / description / avatar
- file browse + download **scoped to the drop channel**
- a low `i_client_needed_move_power` on the group itself, so officers can drag
  her around without needing elevated power

## Verifying after the change

Nothing here is worth trusting without a smoke test. In order:

1. `./scripts/deploy-server.sh --verify` — she is connected and STT is up.
2. Play something: audio path and talk power.
3. `!move` her, and have a Colonel drag her in the client: move power both ways.
4. Drop a `.md` into `moneypenny-drop`, then `!ingeststatus`: browse + download.
5. Watch the nickname change on a track change: `clientupdate`.
6. Confirm rank gating still works — an admin-only command from a non-admin must
   still be refused. If `getServerGroupsForClient` loses its permission, rights
   checks silently see *no* groups, which fails toward denying everyone.

Item 6 is the one most likely to break quietly, and the only one whose failure
does not produce an obvious error.
