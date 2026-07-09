# Economy seed import snapshots

Frozen JSON from **one-shot, offline** maintainer imports. The bot does **not**
read these at runtime — `catalog.ts` is the runtime source of truth.

| File | Contents |
|------|----------|
| `seed-import-2026-07.json` | SC DataHub ores + refining cards (HTML parse once) + UEX commodities sample |

## Policy

- **Allowed:** rare, targeted, human-triggered import to refresh the seed.
- **Not allowed:** runtime scrapers, cron hammers, mirroring community UIs as a live product feature.
- **Prefer:** UEX public API for live prices; org doctrine for locations/BOMs.

## Re-import (maintainer only)

When a patch lands and numbers feel stale:

1. Fetch only the pages you need (ores + refining), once.
2. Identify as a maintainer tool (clear User-Agent).
3. Write a new `seed-import-YYYY-MM.json`.
4. Regenerate / hand-merge into `catalog.ts`.
5. Bump `CATALOG_AS_OF` and note sources in the commit message.

Do not automate against scminer / SCMDB / DataHub without the owner’s blessing.
