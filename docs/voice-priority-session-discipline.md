---
classification: unclassified
tags: [teamspeak, voice-priority, session-discipline, moneypenny, ops, s-6]
---

# Voice priority & session discipline (TeamSpeak + Moneypenny)

Ops process for clear prioritization, role-based control, and reduced crosstalk
on TeamSpeak. Builds on attenuation and rank features the group already runs.
**No new Moneypenny automation** — stronger auto-assign / cross-channel duck can
come later if process alone is not enough.

**Related:** [rank-gating.md](./rank-gating.md) (permanent ranks → rights),
[voice.md](./voice.md) (music duck while STT listens),
[teamspeak-permissions.md](./teamspeak-permissions.md) (bot capabilities).

---

## Core principles

1. **Automatic attenuation is effective when it is predictable.** Keep Moneypenny’s
   existing music ducking; do not replace it with ad-hoc client faders mid-op.
2. **Server groups already gate rights in Moneypenny.** Reuse the *idea* of groups
   for **session flight roles**, but keep them **separate** from permanent rank
   groups used for command/doctrine rights (see [Coexistence](#coexistence-session-roles-vs-permanent-ranks)).
3. **Structure beats individual volume fiddling** once ~8–10 people need to talk
   at the same time — split nets instead of endless “can you hear me?”.

---

## 1. Session-role server groups

Create (or formalize) these **TeamSpeak server groups** for voice priority and
channel placement during an op. Names must match operational usage; numeric IDs
are server-local (fill in when creating the groups on your TS host).

| Session role | Purpose | Notes |
|--------------|---------|--------|
| **Flight Lead / Captain** | Net control for the flight/ship; Priority Speaker + whisper target | One (or few) per vehicle/flight net |
| **Pilot** | Primary stick authority on that ship | Not the same as permanent “pilot” identity |
| **Gunner / WSO** | Weapons / systems talk on vehicle net | |
| **Engineer / Comms (S-6)** | Session owner of groups + temp channels; may sit command or vehicle nets | Owns start/end procedure |
| **Wingman / Crew** | Default flight member | |
| **Guest** | Visitors / unassigned for this session | Lowest voice priority; still respect permanent rank for bot rights |

### Temporary assign / clear policy

- **Assign at session start** (or keep sticky only for the duration of the
  briefing → debrief window). Prefer S-6 (or designated Comms) doing bulk
  assign from a roster.
- **Clear temporary session-role groups at the end of the op** so yesterday’s
  Captain is not still Priority-Speaker tomorrow.
- **Do not use permanent ranks as voice-priority labels.** Fixed permanent ranks
  create the “pilots always loud, gunners always quiet” problem. Permanent ranks
  stay for **Moneypenny rights and doctrine clearance** only
  ([rank-gating.md](./rank-gating.md)).

### Tag as temporary (`Session /` prefix)

**Name every session-role group with the prefix `Session /`:**

| Display name on TeamSpeak |
|---------------------------|
| `Session / Flight Lead` |
| `Session / Pilot` |
| `Session / Gunner` |
| `Session / Engineer` |
| `Session / Wingman` |
| `Session / Guest` |

That prefix is the human-readable **temporary tag**. Permanent ranks keep their
normal names (Guest, Cadet, Colonel, …) and stay out of this list.

### Moneypenny config allowlist

Put the **numeric** server-group IDs for those six groups in config (Settings /
`bot/data/config.json`). Only these IDs are ever auto- or command-cleared:

```json
"sessionRoles": {
  "groupIds": [201, 202, 203, 204, 205, 206],
  "namePrefix": "Session /",
  "autoClearOnEmpty": false,
  "clearGraceMinutes": 15
}
```

| Field | Meaning |
|-------|---------|
| `groupIds` | Temporary Session / group IDs only — **never** permanent rank IDs from rights |
| `namePrefix` | Docs / status label (default `Session /`) |
| `autoClearOnEmpty` | If `true`, strip memberships when the **whole server** has 0 humans for `clearGraceMinutes` (not music-channel idle alone) |
| `clearGraceMinutes` | Grace before auto-clear (default 15) |

**Safety:** any ID that also appears in `rights.rules` / `adminGroups` is
**blocked** from clear so a mis-typed allowlist cannot demote Colonels.

### Commands

| Command | Who | Effect |
|---------|-----|--------|
| `!session` / `!session status` | mod / admin | Show configured temporary groups + auto-clear flags |
| `!session clear` | mod / admin (S-6) | Remove all clients from `sessionRoles.groupIds` via Query |
| `!session clear dry` | mod / admin | Dry-run — count only, no membership changes |

Requires TeamSpeak **HTTP Query** (`TS6_QUERY_HOST` + API key) and Query power
to list/remove clients from those groups. Without Query, clear tells you to use
the TS client manually.

---

## 2. Permanent channel layout

Stop forcing everything into one open channel once the group is large enough to
talk over itself.

### Recommended permanent template

| Channel | Join | Purpose |
|---------|------|---------|
| **Command / Captains net** | Restricted join; **Channel Commander** enabled for current controllers | Cross-flight coordination; lead talk only by default |
| **Vehicle / Flight nets** | Per flight or ship; create **temporary** children as needed | Intra-crew coordination |
| **Squad / Wing net** | Broader squad chatter | Secondary net when not on vehicle |
| **Music / Moneypenny channel** | Open (or lightly gated) | Bot music + STT; **hard-ducked** whenever the bot is listening / speaking (existing path) |

### ~8–10 simultaneous-talker split rule

**Rule of thumb:** once more than about **8–10 people** need to talk at the same
time, **split**:

1. Move crews into **Vehicle / Flight nets** (one per flight or ship).
2. Keep **Flight Leads / Captains** on **Command / Captains net** (or dual-bind
   main + command).
3. Leave social / music on **Music / Moneypenny** so ops traffic does not fight
   the playlist.

Below that size, a single Squad / Wing net plus music is usually enough.

### Temporary channels

S-6 creates flight/ship channels for the op and **deletes or archives them at
teardown**. Prefer a naming convention: `Flight Alpha`, `Idris-1`, etc.

---

## 3. Attenuation & voice priority

### Moneypenny music ducking (keep as-is)

Moneypenny already ducks bot music volume when speech/STT runs
(`duckMusicOnSpeech`, default **true**; soft target volume
`duckMusicVolume`, default **15**). Karaoke nights use `karaokeMode` /
`!karaoke on` so the same duck only goes to **80**. That path is the **music-path attenuation**
for the Music / Moneypenny channel.

- **Do not turn ducking off** for ops sessions unless diagnosing STT.
- Config: Settings → voice / `voice.duckMusicOnSpeech` in `bot/data/config.json`.
- Code default: `defaultVoiceConfig()` in `bot/src/voice/types.ts`.
- Detail: [voice.md](./voice.md) (watchword, listen window, under-music checks).

**Known gap (deferred automation):** ideal “hard-duck music whenever **any**
priority ops channel has activity” is broader than today’s duck-on-speech /
watchword path in the bot’s channel. Until automation exists, prefer keeping
ops voice **off** the music channel (use Vehicle / Command nets) so music does
not compete with priority talk. Do not invent new cross-channel duck code for
this process doc.

### TeamSpeak voice priority (human process)

Use **only tools the group already runs**:

| Tool | Who | When |
|------|-----|------|
| **Priority Speaker** | Current Flight Lead / Captain | Session start; clear at end |
| **Whisper lists** | Everyone → current lead (and optional lead → net) | Bind once; document key |
| **Channel Commander** | Controllers on Command / Captains net | Gives clear control without constant mic checks |
| **Client volume bumps** | Optional: each user raises volume on high-priority nicks **once at session start** | Not permanent presets by rank |

Avoid per-user permanent volume presets that recreate “role always loud/quiet.”

---

## 4. Session process (lightweight, enforced)

**Owner:** one designated **Comms / S-6** person owns channel creation and
session-role group assignment for the session.

### Start checklist

1. Designate S-6 (if not already sticky for the evening).
2. Confirm permanent channels exist; create temporary Vehicle / Flight nets.
3. **Assign session-role groups** from the roster (Lead, Pilot, Gunner, Engineer,
   Wingman, Guest).
4. **Move people** into the correct channels (Command vs Vehicle vs Squad).
5. Confirm **Priority Speaker** and **whisper lists** for Flight Lead / Captain.
6. Confirm **Channel Commander** on Command / Captains net for current controllers.
7. Announce **default PTT bindings** (see below).
8. Confirm Moneypenny is in Music channel with **duck music while listening** on.

### Default PTT / binding set

TeamSpeak supports multiple PTT keys natively — standardize for the group:

| Binding | Target |
|---------|--------|
| **Main net** | Current Vehicle / Flight (or Squad if not split) |
| **Secondary net** | Command / Captains (leads) or Squad / Wing |
| **Whisper to lead** | Current Flight Lead / Captain |

Exact key numbers are local preference; the **names** of the three binds should
match across the group so callouts stay short (“secondary”).

### End checklist

1. Clear **temporary session-role** group memberships — prefer
   **`!session clear`** (or `!session clear dry` first). Manual group strip in
   the TS client is fine if Query is down.
2. Clear **Priority Speaker** / session whisper list overrides.
3. Remove or archive **temporary** Vehicle / Flight channels.
4. Leave permanent ranks and permanent channel skeleton untouched.
5. Optional: short debrief note for the next S-6 (what nets worked).

If `sessionRoles.autoClearOnEmpty` is on, empty-server + grace also runs step 1
as a backup — still run `!session clear` at debrief when people remain online
for the after-action chat.

---

## 5. Coexistence: session roles vs permanent ranks

| Concern | Source of truth | Used by |
|---------|-----------------|---------|
| Command rights, DJ/mod, doctrine clearance | **Permanent rank** server groups (Guest, Cadet, Specialist, … — see production map in [rank-gating.md](./rank-gating.md) and `scripts/rights-rank-gating.json`) | Moneypenny `RightsEngine` |
| Voice priority, channel placement, Priority Speaker targets | **Session-role** groups (this doc) | Humans / TS client features; **not** the rights template |

**Rules:**

1. Session-role groups **must not** be the only groups used for Moneypenny allow/deny
   unless a deliberate, documented rights rule is added later.
2. Holding **Session / Pilot** does **not** grant admin or deny music/doctrine rights.
3. A Cadet who is Flight Lead for the op gets **Priority Speaker** via process;
   they do **not** automatically become Colonel for `!reindex` or secret doctrine.
4. When creating session-role groups on the TS server, leave their permission
   templates minimal (no extra bot rights power). Prefer empty extra permissions;
   use channel talk power / Channel Commander for net control instead.

The rights template (`scripts/rights-rank-gating.json`) maps **placeholder
permanent-rank IDs only**. Session-role names must not be silently substituted
into that file as the sole rights mapping.

---

## 6. Roll-out order

1. Create/finalize the six **session-role** server groups and the **channel template**.
2. Use this document as the one-page session start/end procedure (S-6 owner,
   role assign, channel map, PTT, teardown).
3. Confirm Moneypenny ducking remains on and rank gating still uses **permanent**
   ranks ([rank-gating.md](./rank-gating.md)).
4. Run a **10–12 person** test session with the split nets.
5. Optionally enable `sessionRoles.autoClearOnEmpty` after a few manual
   `!session clear` ops go well. Stronger automation (auto-assign, auto Priority
   Speaker, cross-channel music duck) remains deferred.

---

## 7. Non-goals (explicit)

- Auto-assign groups, auto-move channels, or auto Priority Speaker in the bot.
- Replacing permanent rank groups with session-only roles for doctrine/command rights.
- Custom client plugins or non-TS volume mixers.
- Per-user permanent volume presets by career role.
- Requiring a live multi-person op as a code-release gate (process validation is
  human ops).
- Clearing **permanent** rank groups or any group not listed in `sessionRoles.groupIds`.
