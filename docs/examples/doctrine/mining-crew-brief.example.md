---
classification: unclassified
tags: [ops, logistics, mining, crew, briefing, example]
valid_until: 2027-07-01
---

# EXAMPLE — Mining crew brief

> **Not live org doctrine.** Copy to your **private** doctrine store, rename
> without `.example`, customize loadouts/routes. Keep real ops offline from
> public git.

Short brief template for mining flights. Pair with `!mine` / `!refine` in
TeamSpeak once ingested privately.

---

## Roles

| Role | Responsibility |
|------|----------------|
| **Lead** | Route, bag call, refine method, “return to pad” timing |
| **Miner(s)** | Scan, fracture, extract; call instability / hostiles |
| **Escort** (optional) | Overwatch, interdiction, pad security |
| **Hauler** (optional) | Pod swap / multi-bag when using external cargo |

One lead posts the Moneypenny order so everyone shares numbers:

```
!mine <ore> scu:<target>
!refine <ore> scu:<target> method:<name>
```

---

## Pre-flight checklist

1. Ship: mining laser + modules per org loadout note (not in bot — see hangar wiki / voice).
2. Cargo: empty or pure single-ore bags when possible (mixed bags complicate refine).
3. Pad: know refine station **before** launch (see your economy-orders routes).
4. Comms: Moneypenny channel for orders; tactical on separate channel if needed.
5. QT clock: if target is **Quantainium**, plan pad ETA under the souring window.

---

## In the rock

1. Scan cluster; prioritize target ore % and mass the lead called.
2. Call out high instability / explosive rocks before charge.
3. Extract to bag; call **bag %** at 50 / 75 / full.
4. On **full** or **lead recall**: stop mining, secure, QT to pad — do not “one more rock” on QT.

---

## Quantainium special rules

- Treat raw QT as **time-critical cargo**.
- No sightseeing, no AFK in dark space with raw QT.
- Order of operations: extract → (optional inert) → pad → **refine immediately**.
- If the bag is mixed, still refine ASAP; pure QT bags preferred next flight.
- Chat answer if asked “store raw QT overnight?” → **Org rule: no.**

Command reminder:

```
!mine quantainium scu:32
!refine quantainium scu:32 method:dinyx
```

(Use `method:cormack` only if the lead accepts lower yield for speed.)

---

## Pad / refine

1. Land or hangar per station SOP.
2. Lead confirms method from your economy-orders refine policy.
3. Run `!refine` in chat so the aUEC/time estimate is visible (seed planning).
4. Collect refined → org stores or sell per `!econ prices` + lead call.
5. AAR optional: `!aar -s` bullets if the flight taught something durable.

---

## Abort criteria

- Loss of escort on a contested pocket (lead call).
- Ship damage / soft death risk with valuable raw.
- Souring risk: pad ETA exceeds org QT window → dump plan changes to **nearest refine**, not home.
- Server/party instability — secure cargo first, argue later.

---

## After action (60 seconds)

- What ore / SCU refined?
- Method used / any souring near-miss?
- Update private economy-orders **Routes** if the pocket or pad is the new standard.
- Do **not** put personal griefs in doctrine — use AAR bullets.

---

## Related examples

- `economy-orders.example.md` — commands, refine policy, routes, craft overrides
