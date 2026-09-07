# Rust bot workspace (WIP)

Strangler rewrite of the Node bot process (`bot/src/index.ts`). Vue and HTTP
sidecars stay. Full plan and live/stub table: **[docs/rust-rewrite.md](../docs/rust-rewrite.md)**.

**This branch:** Phases **0–5 live** (health, first-run, `!play`/`!skip`/`!queue`,
Vue `/api/*` parity, `POST /v1/turn`, doctrine RAG + `!remember`/`!ask`).
Voice / radio / economy / MCP are compiling stubs.

```bash
cargo test --workspace
cargo test -p mp-audio
cargo run -p moneypenny            # 127.0.0.1:3000 by default
cargo run -p mp-ts --example join --features tsclient-rs
```

| Crate | Owns now |
|-------|----------|
| `moneypenny` | binary |
| `mp-config` / `mp-db` / `mp-rights` | config, sqlite, rank gate |
| `mp-audio` / `mp-ts` / `mp-music` | Opus, TeamSpeak, local library + ffmpeg |
| `mp-control` | `COMMAND_MANIFEST`, parse, music executor, LLM tool-map, dispose |
| `mp-http` | axum: cookies, SPA, player/music APIs, `POST /v1/turn` |
| `mp-brain` | in-process OpenAI-compat or `BRAIN_URL` |
| `mp-rag` / `mp-voice` / `mp-radio` / `mp-economy` / `mp-mcp` | stubs |

Dual-run overlay: `docker-compose.rust.yml` (Rust `:3001`, Node `:3000`).
