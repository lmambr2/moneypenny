---
classification: unclassified
tags: [ops, logistics, economy, mining, refining, crafting, trade, example]
valid_until: 2027-07-01
---

# EXAMPLE — Org economy orders (TeamSpeak)

> **Not live org doctrine.** Template only — ships in the public Moneypenny repo
> under `docs/examples/doctrine/`. Copy into your **private** doctrine store
> (Library → Doctrine, private git wiki, or `bot/data/doctrine/`), rename
> without `.example`, fill **Routes** / craft notes, then reindex.
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
| `!craft <blueprint> [qty:N]` | Staging fabricator BOM for an **in-game** blueprint (sc-craft.tools) |
| `!trade routes …` | Community trade routes (sc-trade.tools; needs `SC_TRADE_API_TOKEN`) |
| `!econ ores` / `methods` | Browse seed ore / refine catalog |
| `!econ blueprints <name>` | Search live blueprints |
| `!econ prices <commodity>` | Live averages via **UEX** (cached; optional) |
| `!econ search <q>` | Find an ore or refine method id |

Examples (in-game names only):

```
!mine quantainium scu:32
!refine bexalite scu:32 method:dinyx
!craft P4-AR qty:1
!craft Coda qty:2
!econ blueprints Coda
!econ prices quantainium
!trade routes ship:Freelancer+MAX invest:200000 loc:Stanton
!trade buyers Agricium scu:32
```

**Spelling:** game form is **Quantainium**; `quantanium` / `qt` also work.

Flags: `scu:N`, `qty:N`, `method:name` (or `m:name`). Trade: `ship:`, `invest:`, `loc:` (spaces → `+`).

---

## What is authoritative

| Question | Source of truth |
|----------|-----------------|
| Order steps / SCU math (mine/refine) | `!mine` / `!refine` (seed catalog) |
| Craft BOM for a game item | `!craft` / `!econ blueprints` → sc-craft.tools |
| Live commodity averages | `!econ prices` → UEX |
| Trade routes / best buyers | `!trade` → sc-trade.tools (token) |
| **Where we mine this week** | This file § Routes + Library updates |
| **Org craft notes / preferred BPs** | This file § Craft notes |
| Patch rock stats snapshot | Seed catalog (frozen; re-import is rare) |

Seed yields and aUEC snapshots are **planning aids**, not cockpit law. Prefer
this doctrine when the org has a written SOP.

Community UIs (scminer, star-crafting.com, SCMDB web) are **bookmarks for
pilots** — Moneypenny does not scrape them at runtime.

---

## Decision tree

1. **Need raw cargo?** → `!mine <ore> scu:<bag>` then fly the route in § Routes.
2. **Raw on pad / in hangar?** → Check stability (Quantainium: refine ASAP).
   `!refine <ore> scu:<n> method:<choice>` from § Refine policy.
3. **Crafting a game item?** → `!craft <blueprint name>` (e.g. P4-AR, Coda).
4. **Hauling for aUEC?** → `!trade routes ship:… invest:…` (token required).
5. **“What’s it worth?”** → `!econ prices <commodity>` (UEX).

---

## Refine policy (org default)

| Situation | Method preference | Notes |
|-----------|-------------------|--------|
| Quantainium / volatile | Fast methods (e.g. dinyx if listed) | Do not store raw overnight |
| Bulk common ore | Economy method (cormack / ferron per seed) | Fill hangar before refine |
| Org override | _fill in_ | _fill in_ |

---

## Routes (fill privately)

| Ore / loop | System / pads | Notes |
|------------|---------------|--------|
| _example_ | Stanton / … | _do not put real opsec in public forks_ |

---

## Craft notes (fill privately)

Prefer in-game blueprint names that match sc-craft.tools (e.g. **P4-AR**, **Coda**).
Org “always stock X mats for Y BP” notes go here — not invented component kits.

| Blueprint | Preferred mats / notes |
|-----------|------------------------|
| _e.g. Coda_ | _fill in_ |

---

## Related templates

- `mining-crew-brief.example.md` — flight checklist
- `logistics-glossary.example.md` — shared vocabulary
