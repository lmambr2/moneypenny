# Phase 7 — Per-user memory & org knowledge graph

**Status:** shipped. Personal facts (`!remember`) + optional MemPalace semantic
recall; institutional temporal facts (`!kg` / `!diary`). Injected into `!ask`
when the Settings toggles are on.

See also: [rag-ingestion-cheatsheet.md](./rag-ingestion-cheatsheet.md) (MemPalace
vs doctrine), [radio.md](./radio.md) § memory bumper (org-only, opt-in).

---

## Architecture

| Store | Scope | Commands | `!ask` injection |
|-------|--------|----------|------------------|
| **SQLite** | Per TS uid | `!remember` / `!recall` / `!forget` | When **Per-user memory** is on |
| **MemPalace** (sidecar) | Same rooms, semantic | Syncs from SQLite; search on `!ask` | When **MemPalace** is on + URL set |
| **Org KG** (SQLite + MemPalace `org_kg` / diaries) | Org-wide, temporal | `!kg` / `!diary` | When **Org knowledge graph** is on |

**Never** mix private `!remember` into radio bumpers. Radio `memory` source uses
**org KG only** and requires `radio.memoryBroadcastOptIn`.

### Dashboard scopes (H3)

Admin **Harness** panel shows two walls side-by-side:

| Scope | Commands / API | Broadcast? |
|-------|----------------|------------|
| **Private** | `!remember` · `GET /api/bot/memory/private?uid=` | **Never** |
| **Hangar** | `!ships` / `!hangar` (own hulls) · MemPalace `hangar:` line | **Never** on radio |
| **Org hangars** | `!ships org …` (Colonel / Chairman · `ships.org`) | Export → `Ship_List.md` (secret RAG) |
| **Org KG** | `!kg` · `POST /api/bot/org-kg` | Only with “Org memory on air” |

`GET /api/bot/memory/scopes` returns the same catalog + isolation rule.
Helpers: `bot/src/memory/scopes.ts` (`isBroadcastSafeSource`, `filterOrgBroadcastFacts`).

---

## Install / deploy

```bash
# Installer
./install.sh --with-memory
# or wizard: “Enable MemPalace?”

# Compose
docker compose --profile memory up -d --build mempalace-bridge

# .env (install.sh writes this with --with-memory)
MEMPALACE_URL=http://mempalace-bridge:8090
```

**Settings** (required once — not auto-flipped by install):

1. **Per-user memory** — inject facts into `!ask`
2. **MemPalace** — on + URL `http://mempalace-bridge:8090`
3. **Org knowledge graph** — inject `!kg` / `!diary` into `!ask`
4. **Check** reachability · **Sync SQLite → MemPalace** if you already had facts

Health: `curl -s http://127.0.0.1:8090/health` → `{"ok":true,...}`

---

## Operator smoke (A1)

Run on TeamSpeak after Settings are on. Replace names as needed.

### Personal memory

```text
!remember I main mining and fly a Prospector
!recall
!ask what ship do I fly?
!forget all
!recall
```

Expect: recall lists the fact; `!ask` mentions Prospector/mining; after forget,
empty recall and no personal detail in `!ask`.

### MemPalace path

1. Settings → Check (bridge green).
2. `!remember callsign is Raven`
3. Settings → **Sync SQLite → MemPalace** (optional if remember already synced).
4. `!ask what is my callsign?` — should use semantic recall.
5. `!forget all`

### Org KG (analyst / rights-gated)

```text
!kg remember Fleet CO is Alice from:2026-01-01
!kg who Alice
!kg who Alice asof:2025-06-01
!diary intel Mining ops prefer Aberdeen for quantainium
!ask who is fleet CO?
```

### Voice (watchword on)

```text
Moneypenny, remember I like jazz playlists
Moneypenny, recall
Moneypenny, forget all
```

Voice `remember` needs a real payload (≥2 words or ≥8 chars after the verb).
`recall` / `forget all` / `forget N` are zero-arg shaped.

### Radio org memory bumper (optional)

1. Settings → Radio: enable radio; set `memoryBroadcastOptIn` (config /
   API — keep **false** unless you want org facts on air).
2. Include `memory` in `radio.sources`.
3. Curate `!kg` / `!diary` first — empty KG → bumper falls through.
4. **Never** broadcasts private `!remember` rooms.

---

## Commands cheatsheet

| Command | Who | Notes |
|---------|-----|--------|
| `!remember <fact>` | Any | SQLite + async MemPalace when enabled |
| `!recall` | Any | MemPalace list if available, else SQLite |
| `!forget <n\|all>` | Any | Awaits MemPalace delete; indices from `!recall` |
| `!ships` / `!hangar` | Any (own) | Personal hangar: add/remove/list/set/claim |
| `!ships org …` | **Colonel / Chairman** (`ships.org`) | Org who/list/of; import/export `Ship_List.md` |
| `!ships add for <target>` | Colonel / Chairman | Edit another member’s hangar |
| `!kg remember …` | Analyst | `from:` / `until:` optional |
| `!kg who <name> [asof:date]` | Query | Temporal roster |
| `!kg list` / `!kg forget` | List / analyst | |
| `!diary intel\|logistics <fact>` | Analyst | Specialist rooms |

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Remember works, `!ask` ignores it | **Per-user memory** toggle |
| Sync / Check red | `docker compose --profile memory ps`; `curl :8090/health` |
| Forget still shows in MemPalace | Re-run `!forget`; Check lastSync in Settings after Sync |
| Install had memory but Settings empty URL | Set URL or restart bot with `MEMPALACE_URL` in `.env` |

---

## Privacy

- Per-user facts are keyed by TeamSpeak uid — not shared across users in `!ask`.
- Org KG is institutional; rank-gate analysts who may write.
- Radio memory bumper is **opt-in** and **org-namespace only**.
