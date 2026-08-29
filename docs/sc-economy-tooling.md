# Star Citizen economy tooling survey — 2026-08-28

Live PU around **Star Citizen 4.10.0**. CIG has **no public live kiosk API**.
Community prices are crowdsourced (UEX + SC Trade Tools). Static game-file
data (ships, items, mining tables) comes from wiki / sc-db / fleetyards /
Erkul.

**Moneypenny constraint:** no HTML scrapers. Prefer public JSON APIs and
**user-submitted terminal snapshots**. Do not copy ARR/AGPL/GPL OCR clients
into this MIT tree.

---

## Architecture (2026)

```
CIG PU (no public live economy API)
   │  Print Screen → <install>/StarCitizen/{LIVE|PTU}/ScreenShots
   ▼
Datarunner (OCR locally) ──POST /2.0/data_submit──► UEX Datacenter
   │                                               secret-key + Bearer
   │                                               90-day screenshot eval
   ▼
SC Trade Companion ──CSV/API──► SC Trade Tools ◄──bidirectional──► UEX
                         │
                         ├── GET /2.0/commodities_prices(_all)
                         ├── GET /2.0/data_monitor
                         └── GET /2.0/marketplace_listings   (P2P, not NPC)
```

Static (not live prices): Star Citizen Wiki API, sc-db.fr, fleetyards, Erkul,
sc-craft.tools.

---

## Catalog

| Project | License | OS | Role | Reuse? |
|---------|---------|----|------|--------|
| UEX site + API 2.0 + `/data_submit` + `/data_monitor` + `/commodities_prices` | closed site, public API; ToS personal/non-commercial | web | source of truth for NPC kiosk prices | **client only** (GET ingest + our own submitter) |
| uexcorp/uex-cli | no SPDX (treat as UEX sample) | Linux native (bash) | lookup / trade log, no OCR | **cite** / reference |
| Shebuka/SC-Datarunner-UEX | all rights reserved, binaries only | Windows | OCR + submit | **behavior reference only, do not copy code** |
| Olrik-WP/SC-DataRunnerNet | AGPL-3.0 | Windows WPF | OCR + 5-gate validation | **study validation gates, not the UI stack** |
| OviiiOne/SC-Datarunner-Tool | source was public Python; GitHub 404 on 2026-08-28 | listed Windows | folder-watch OCR + fuel | **cite**; repo missing |
| Zamotic Data Runner Client 2.0 | closed ClickOnce | Windows | legacy client (2022) | **note only** |
| Hybris95/UEX-Trader | MIT, Python | Windows + Linux from source | routes + declare trades | **compare route math vs our `!trade`** |
| Citizen Nexus MCP | no SPDX | local stdio MCP | UEX + wiki tools | **cite**; wrap APIs ourselves |
| UEE.trading | closed | web | mining/refinery + UEX routes | **cite, no scrape** |
| SC Trade Tools + Companion | API closed; companion GPL-3.0 | web + Windows Java | prices / routes / MCP | **ingest with token**; companion OCR **study only** |
| Erkul | closed | web | loadouts / DPS | **cite**; no public API |
| Regolith | closed | web | mining | **dead** (shut down 2026-06-01) |
| SC Wiki API | MIT code; data is CIG IP | HTTP | items/ships/commodities (static) | **ingest** static only |
| sc-craft.tools | fan site | web | in-game blueprints | already wired (`sc-craft.ts`) |
| fleetyards | GPL-3.0 | web | hangar / ship matrix | **cite**; not PU prices |
| hangar.link | closed | web + Chrome | pledge hangar | **cite**; not economy |
| slancinator | — | — | — | **not found** 2026-08-28 |

---

## UEX stack (required)

**Canonical API base (2026):** `https://api.uexcorp.uk/2.0/{resource}`  
Legacy `https://api.uexcorp.space/2.0/` still answers; UEX recommends `.uk`
after the 2025-08-22 infra split (Cloudflare on `.space` can interrupt).

Docs: https://uexcorp.space/api/documentation/  
Apps (Bearer): https://uexcorp.space/api/apps/  
Community tools: https://uexcorp.space/api/community_made/

### Auth

| Secret | Where | Used for |
|--------|-------|----------|
| App **Bearer** token | My Apps | API identity / quota (`Authorization: Bearer`) |
| User **`secret-key`** header (40 chars, profile) | datarunner submit | `data_submit` / edit / remove, marketplace writes, wallet |

Not interchangeable. Using the Bearer as `secret-key` returns `user_not_found`.

Quota (docs): 172800/day or 120/min. Over: `requests_limit_reached`.

### Live `GET /data_parameters` (2026-08-28)

```json
{
  "global": {
    "is_accepting_reports": 1,
    "is_accepting_ptu_reports": 0,
    "is_datacenter_enabled": 1,
    "game_version": "4.10.0",
    "evaluation_period_days": 90
  },
  "commodity": { "is_accepted": 1, "price_variation": 25, "scu_variation": 5000, "ttl": 15 },
  "item":         { "is_accepted": 1, "price_variation": 100, "ttl": 60 },
  "vehicle_rent": { "is_accepted": 1, "price_variation": 60,  "ttl": 60 },
  "vehicle_buy":  { "is_accepted": 1, "price_variation": 10,  "ttl": 60 }
}
```

TTL is **days until stale**. Variation is the ±% Data Guardians use. Commodity
SCU swing gate: 5000. Marketplace WTS/WTB is a **separate** stream
(`/marketplace_listings`), not NPC kiosk prices.

### `POST /data_submit`

- URL: `https://api.uexcorp.uk/2.0/data_submit`
- Headers: Bearer + **`secret-key`**
- Body: `id_terminal`, `type` ∈ `commodity|item|vehicle_buy|vehicle_rent`,
  `is_production` 0/1, `prices[]`, optional `game_version` (default **4.10.0**),
  `screenshot` PNG/JPG **base64 ≤ 10 MB** — **required for new datarunners
  during the 90-day evaluation**
- Inventory status 1 (empty) … 7 (full)
- Fuel kiosks are **not** a `data_submit` type; UEX has `GET /fuel_prices`.
  Moneypenny ingest may still accept `type: fuel` locally.

Related (2026-08-10): `GET /data_info`, `POST /data_edit`, `DELETE /data_remove`.

---

## Other tools (short)

| Name | Notes |
|------|-------|
| **SC Haulers / RL-Tools / Griffen / DataHub** | UEX-powered web calculators. Cite; do not scrape. |
| **SCMINER / MineCalc / MFA / NexusApp** | Mining loadouts. Cite. MFA/Nexus have OCR of a **different** HUD. |
| **sc-db.fr** | Public no-auth game-file API. Ingest static/mining geology. |
| **SC Trade Tools mining API** | Removed in a 10.x/11 breaking change. |

---

## Linux / LUG screenshot paths

Print Screen writes **into the game tree**, not `~/Pictures`. Casing varies
(`ScreenShots` vs `Screenshots`) — watch **both**.

LUG Helper default prefix (`$XDG_CONFIG_HOME/starcitizen-lug/winedir.conf`,
wiki 2026-08): `~/Games/star-citizen`

```
$WINEPREFIX/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE/ScreenShots
$WINEPREFIX/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE/Screenshots
$WINEPREFIX/drive_c/Program Files/Roberts Space Industries/StarCitizen/PTU/ScreenShots
```

Proton/umu example:

```
~/Games/umu/umu-starcitizen/drive_c/Program Files/Roberts Space Industries/StarCitizen/LIVE/ScreenShots
```

**Never hardcode `C:\…`.** Resolve prefix from LUG config or `--dir`.
Never read SC process memory.

This host’s LUG config (example): `winedir.conf` →
`/media/Blackup/Games/star-citizen/star-citizen`.

---

## Data policy for Moneypenny

1. **Live NPC kiosk prices we consume:** UEX GET (own Bearer, `.uk`) + optional
   sc-trade token. Fail-open, long L2 TTL, attribution.
2. **Snapshots we produce:** Print Screen → local OCR/review → destination
   toggle `uex | moneypenny | both`. UEX submit is independent of Moneypenny
   success.
3. **P2P marketplace:** do not mix into NPC bid/ask without `source=marketplace`.
4. **Never:** scrape uexcorp.space, sc-trade.tools, erkul.games, or RSI hangar.

Implementation plan: [linux-datarunner-plan.md](./linux-datarunner-plan.md).
Audit of what we already ship: [economy-audit.md](./economy-audit.md).
