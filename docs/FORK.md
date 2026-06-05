# Fork Base

**Upstream:** ZHANGTIANYAO1/teamspeak-music-bot (MIT)

**Imported commit (Phase 0 baseline):**
`a861b41809e0ebe0902d0ed4b462377b76ddd44e`

Date imported: 2026-05-30

This is the exact starting point for Moneypenny.

All subsequent changes under `bot/` are first-party Moneypenny work on top of this commit.

## Rationale for choice (from DESIGN.md §5)

- Native TS3/TS6 dual-protocol client via `@honeybbq/teamspeak-client`
- Security-reviewed auth stack (bcrypt, hashed tokens, CSRF, rate limiting, WS auth)
- Clean `MusicProvider` interface
- Vue web UI
- TypeScript + easy in-process LLM module addition

## Post-import mandatory work

1. Full de-sinicization (§6.1): remove NetEase / QQ / Bilibili providers + their API proxy + all references.
2. Replace provider lineup with Local (new) + YouTube (keep) + Stream (new).
3. Pin `@honeybbq/teamspeak-client` + review for telemetry.
4. Later: vendor the teamspeak client if practical.

See DESIGN.md §6.1 and §6.2 for the complete strip list and the one dependency we must keep.
