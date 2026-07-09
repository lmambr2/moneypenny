---
classification: unclassified
tags: [ops, logistics, economy, mining, refining, crafting, example]
valid_until: 2027-07-01
---

# EXAMPLE — Org economy orders (TeamSpeak)

> **Not live org doctrine.** Template only — ships in the public Moneypenny repo
> under `docs/examples/doctrine/`. Copy into your **private** doctrine store
> (Library → Doctrine, private git wiki, or `bot/data/doctrine/`), rename
> without `.example`, fill **Routes** / **Craft overrides**, then reindex.
> Do **not** commit real pad codes, schedules, or opsec into a public fork.

How *an* org might run industrial pull orders through Moneypenny. Deterministic
commands do the math; private doctrine is the **SOP and vocabulary** for `!ask`
and voice/chat ops.

---

## Commands (public)

| Command | Use when |
|---------|----------|
| `!mine <ore> [scu:N] [method:name]` | Opening a mining pull (target SCU + stability clock) |
| `!refine <ore> [scu:N] [method:name]` | Queueing a refinery job (seed yield/time/cost) |
| `!craft <recipe> [qty:N]` | Staging a fabricator BOM (illustrative unless overridden below) |
| `!econ ores` / `methods` / `recipes` | Browse the seed catalog |
| `!econ prices <ore>` | Live sell/buy averages via **UEX** (cached; optional) |
| `!econ search <q>` | Find an ore, method, or recipe id |

Examples:

```
!mine quantainium scu:32
!refine bexalite scu:32 method:dinyx
!craft quantum-core qty:2
!econ prices stileron
```

**Spelling:** game form is **Quantainium**; `quantanium` / `qt` also work.

Flags: `scu:N`, `qty:N`, `method:name` (or `m:name`).

---

## What is authoritative

| Question | Source of truth |
|----------|-----------------|
| Order steps / SCU math | `!mine` / `!refine` / `!craft` (seed catalog) |
| Live terminal sell prices | `!econ prices` → UEX API (not doctrine) |
| **Where we mine this week** | This file § Routes + Library updates |
| **Real craft recipes / BPs** | This file § Craft overrides + fabricator notes |
| Patch rock stats snapshot | Seed catalog (frozen; re-import is rare) |

Seed yields and aUEC snapshots are **planning aids**, not cockpit law. Prefer
this doctrine when the org has a written SOP.

Community tools (scminer, SC DataHub, SCMDB, UEX web) are **bookmarks for
pilots** — Moneypenny does not scrape them at runtime.

---

## Decision tree

1. **Need raw cargo?** → `!mine <ore> scu:<bag>` then fly the route in § Routes.
2. **Raw on pad / in hangar?** → Check stability (Quantainium: refine ASAP).
   `!refine <ore> scu:<n> method:<choice>` from § Refine policy.
3. **Building a component?** → `!craft <recipe>` then replace BOM lines with
   § Craft overrides if listed.
4. **“What’s it worth?”** → `!econ prices <ore>` (UEX). Do not treat seed
   snapshot aUEC as live.

---

## Refine policy (org default)

| Situation | Method preference | Notes |
|-----------|-------------------|--------|
| Premium ore, time OK | **Dinyx** or **Ferron** | Higher seed yield |
| Premium ore, clock tight (QT) | **Cormack** if you must move product fast | Lower yield — call it out in chat |
| Bulk low-tier (Al, Fe, Cu, …) | **Cormack** | Speed over yield |
| High aUEC budget, max refined | **Pyrometric** or **Ferron** | Costlier |

Always pass the method on the command when it matters:
`!refine quantainium scu:32 method:dinyx`.

---

## Stability / souring

| Material | Org rule |
|----------|----------|
| **Quantainium (raw)** | **Critical.** Mine → land → refine. Do not park raw in a remote pad “for later.” Target refine within ~20 minutes of extraction unless inert storage is confirmed in-patch. |
| High-instability ship ores (seed: high Inst + Expl) | Prefer same-session refine; no overnight raw in unsecured hangars. |
| Stable ores | Bag full → refine wave or store refined only when space is tight. |

If someone asks in chat “can I store raw quantainium?” → **No** (org rule).

---

## Routes (edit me)

> Replace placeholders with current org preferred systems/stations. After a
> patch, update this section and reindex doctrine.

| Ore / focus | Preferred location | Refine / sell pad | Notes |
|-------------|-------------------|-------------------|--------|
| Quantainium | _TBD — e.g. Aaron Halo sector_ | _TBD station_ | Short hop; inert cargo if available |
| Bexalite / Taranite | _TBD_ | _TBD_ | Often paired runs |
| Stileron / Riccite / Savrilium | _TBD (often specialist)_ | _TBD_ | Secure hauling |
| FPS gems (Hadanite, …) | _TBD moon / ROC site_ | _TBD_ | Hand/ROC loop — not ship bag SCU |

**Haul discipline:** full bag → QT to pad → refine before the next pocket unless
lead calls a multi-bag secure cache.

---

## Craft overrides (edit me)

Seed `!craft` recipes are **illustrative**. When the org locks a real BOM,
document it here so `!ask` and analysts cite doctrine instead of the seed.

### Example template

```
### <Component name>
- Blueprint source: <mission / shop / org locker>
- Station / fabricator: <where>
- Per unit:
  - N SCU refined <ore>
  - …
- Implied raw (via org refine method): …
- Last verified patch: <version>
```

_(No locked org BOMs yet — use `!craft` seed until filled in.)_

---

## Chat / voice etiquette

- Lead posts `!mine …` then `!refine …` so the channel shares one order.
- Use `!econ prices` before “we should sell raw” arguments.
- For long logistics writeups: `!analyst` or `!intsum -s` with bullet facts;
  save with `-s` when it should enter the library.
- Rank-gating: this doc is **unclassified**. Put sensitive pad codes / opsec
  routes in a **restricted** doctrine file instead.

---

## Related (examples)

- Product reference: `docs/economy.md`
- `mining-crew-brief.example.md` · `logistics-glossary.example.md`
- Commands: `!help` (Org economy section)
- Seed catalog: `bot/src/economy/catalog.ts` (not doctrine)
