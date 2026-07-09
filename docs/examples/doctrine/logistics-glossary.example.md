---
classification: unclassified
tags: [ops, logistics, economy, glossary, example]
valid_until: 2027-07-01
---

# EXAMPLE — Logistics glossary

> **Not live org doctrine.** Copy to your **private** doctrine store if you want
> shared vocabulary in `!ask`. Safe to keep generic; strip anything org-specific
> before publishing a fork.

Shared language template for mining, refining, and crafting so `!ask` and crew
chat stay consistent once privately ingested.

---

## Materials & states

| Term | Meaning |
|------|---------|
| **Raw** | Unrefined ore/cargo as extracted |
| **Refined** | Post-refinery product (seed ids: `refined-<ore>`) |
| **SCU** | Standard cargo unit — order sizes use SCU |
| **Bag** | Bill of materials for a craft |
| **Snapshot value** | Frozen aUEC/SCU in the bot seed catalog — **not** live price |
| **UEX price** | Live-ish average from `!econ prices` (UEX API, cached) |

---

## Ore name notes

| Canonical (catalog) | Also accepted |
|---------------------|---------------|
| Quantainium | quantanium, quanta, q, qt |
| Bexalite | bex |
| Taranite | tara |
| Laranite | lara |
| Hephaestanite | heph, hepha |
| Aluminum | aluminium, al |

FPS/gem materials (Hadanite, Janalite, Aphorite, …) are in the catalog as
`mode: fps` — ship `!mine scu:` orders still work as planning text; actual loop
is ROC/hand mining.

---

## Refinery methods (org shorthand)

| Id | Shorthand | Planning bias |
|----|-----------|----------------|
| `dinyx` | high yield, slow | Premium when time allows |
| `ferron` | balanced high yield | Default valuables |
| `thermonatic` | moderate | Mid |
| `electrostarolysis` | mid/mid | Baseline |
| `cormack` | fast, low yield | Bulk / emergency speed |
| `pyrometric` | high yield, costly | When aUEC is fine |

Numeric yields in the bot are **seed estimates** for order chat, not exact
in-game tables.

---

## Stability words

| Word | Org meaning |
|------|-------------|
| **Stable** | No souring clock in catalog; still secure cargo |
| **Volatile** | Prefer same-session refine; no long raw storage |
| **Critical** | Quantainium-class — refine on a clock |

---

## Commands people mix up

| They say | Point them to |
|----------|----------------|
| “Mining order” | `!mine` |
| “Refinery job” | `!refine` |
| “What do we need to craft X” | `!craft <in-game blueprint>` (e.g. P4-AR) then doctrine craft notes |
| “Market price” | `!econ prices` (UEX), not seed snapshot |
| “Where do we mine X” | private economy-orders **Routes** (edit when changed) |
| “Write it up for the library” | `!intsum -s` / `!aar -s` / Library → Doctrine |

---

## Related examples

- `economy-orders.example.md`
- `mining-crew-brief.example.md`
