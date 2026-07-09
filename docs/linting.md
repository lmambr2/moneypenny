# Linting & formatting (Biome)

Moneypenny uses **[Biome](https://biomejs.dev/)** for lint + format on TypeScript/JavaScript
(and Vue SFCs where Biome supports them). **Typechecking stays with `tsc` / `vue-tsc`.**
**Behavior stays with Vitest.**

| Layer | Tool | Command |
|-------|------|---------|
| Format + lint | Biome 2.x | `cd bot && npm run lint` |
| Auto-fix | Biome | `cd bot && npm run lint:fix` |
| Types (bot) | `tsc` | `cd bot && npx tsc --noEmit` |
| Types (web) | `vue-tsc` | `cd bot/web && npm run build` (includes check) |
| Tests | Vitest | `cd bot && npm run test:all` |
| All local gates | — | `cd bot && npm run check` |

Config: [`bot/biome.json`](../bot/biome.json) (covers `bot/src` + `bot/web/src`).

---

## Commands

```bash
cd bot

npm run lint          # check only (CI / preflight)
npm run lint:fix      # apply safe fixes + format + organize imports
npm run format        # format only
npm run format:check  # format dry-run
npm run check         # lint + tsc + test:all
```

Web package proxies to the same config:

```bash
cd bot/web
npm run lint
npm run lint:fix
```

---

## Where it runs

| Gate | Biome? |
|------|--------|
| `scripts/deploy-preflight.sh` | Yes — after `tsc`, before critical vitest |
| `scripts/ci-validate.sh` (default full run) | Yes — exit code **5** on failure |
| Pi deploy (rsync) | Via preflight only (not inside the container) |
| Editor | VS Code/Cursor: Biome extension + [`.vscode/settings.json`](../.vscode/settings.json) |

---

## Scope & limits

**In scope:** `bot/src/**`, `bot/web/src/**` (`.ts`, `.js`, `.vue`, package JSON).

**Out of scope (ignored):** `dist/`, `node_modules/`, `data/`, SCSS/CSS assets, models,
Python sidecars (`services/*` — use `ruff` if you care later).

**Vue templates:** Biome is not a full `eslint-plugin-vue` replacement. Template/type
correctness still comes from **`vue-tsc`** on web build. Script blocks are linted/formatted.

**Style notes:**
- Bot (`src/`): double quotes, 2-space indent, trailing commas
- Web (`web/`): single quotes (override), same indent/width
- `noExplicitAny` is **off** (gradual); `noUnusedImports` is **error**

---

## First-time / new clone

```bash
cd bot && npm ci
# Optional editor: install “Biome” extension (recommended via .vscode/extensions.json)
npm run lint
```

If lint fails after a pull, prefer:

```bash
npm run lint:fix
# then review the diff; re-run tests
npm test
```

---

## Adding rules

1. Edit `bot/biome.json` `linter.rules` (prefer `warn` first on large blasts).
2. Run `npm run lint` and fix or adjust.
3. Document intentional `// biome-ignore lint/...: reason` sparingly.

Do **not** run Prettier alongside Biome on the same files.
