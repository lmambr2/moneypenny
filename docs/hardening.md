# Production Hardening (DESIGN §11)

Latest application audit: [security-audit-2026-07-09.md](./security-audit-2026-07-09.md)
(prior: [security-audit-2026-07-08.md](./security-audit-2026-07-08.md)).

Moneypenny's application code is already conservative (no shell-exec injection;
`/api` behind auth + CSRF-origin + rate-limit; WS upgrade auth; bcrypt-12;
session tokens stored only as SHA-256; parameterized SQL; session cookie
`httpOnly` + `SameSite=Lax` + `Secure`-under-HTTPS). The remaining risk is in
**deployment defaults**. This is the checklist and what's wired.

## Done / built-in

- **Non-root container.** `bot/Dockerfile` is a multi-stage build that ships a
  slim runtime running as the unprivileged `moneypenny` user (uid 1000).
- **Read-only root filesystem.** In `docker-compose.yml` the bot runs with
  `read_only: true`, `cap_drop: [ALL]`, and `security_opt: [no-new-privileges]`.
  All mutable state (SQLite DB, logs, avatars, **and `config.json`**) lives under
  the single writable `/app/data` volume; scratch goes to `tmpfs` (`/tmp`,
  `~/.cache`).
- **Localhost-only by default.**
  - The app binds `BIND_ADDRESS` (default `127.0.0.1` for bare-metal).
  - In Docker the app binds `0.0.0.0` *inside* the container, but the port is
    published as `127.0.0.1:3000:3000`, so it is **not** LAN-reachable by default.
  - Binding `0.0.0.0` logs a warning.
- **HTTPS-aware cookies.** The session cookie sets `Secure` only when the request
  is HTTPS; set `trustProxy: true` (config) behind a TLS-terminating reverse
  proxy so `X-Forwarded-Proto` is honored.
- **Watchdog.** Reconnects dropped bots and, with `WATCHDOG_MEMORY_MB`, exits on
  an RSS ceiling so the container's `restart: unless-stopped` policy recovers it.
- **Healthcheck.** The image probes `/api/health`.

## Compose profiles (optional sidecars)

The bot core runs under `--profile core`. Add profiles as needed — each is a separate container the bot reaches via config/env URLs:

| Profile | Services | When |
|---------|----------|------|
| `core` | `bot` | Always |
| `npu` / `ollama` | `rkllama` / `ollama` | On-device LLM |
| `rag` | `qdrant` | Document RAG / doctrine |
| `voice-edge` / `voice-server` | `stt-whisper`, `piper-tts` | Dual-track Whisper + Piper |
| `voice-dev` | `stt-mock` | CI / fast dev |
| `stream` | `tidal-bridge` | Real Tidal playback (`STREAM_BRIDGE_URL`) |
| `server` | `teamspeak` | Bundled TS6 server |
| `memory` | MemPalace sidecar | Institutional KG semantic recall |

See `docker-compose.yml` and `install.sh --help` for the full matrix.

## Operator steps (not automatable)

1. **Data volume ownership.** The host `bot/data` dir must be writable by uid 1000:
   ```bash
   mkdir -p bot/data && sudo chown -R 1000:1000 bot/data && chmod 700 bot/data
   ```
   It holds secrets at rest (TS server password, config). Protect it and its
   backups; do not commit it.
2. **First-run on a trusted binding.** The first account created becomes admin.
   Do initial setup over localhost (or an SSH tunnel) *before* exposing the port.
3. **LAN / remote access.** To reach the UI beyond localhost, either:
   - front it with a TLS reverse proxy (Caddy/nginx) and set `trustProxy: true`,
     **or**
   - change the publish to `0.0.0.0:3000:3000` and firewall `:3000` to the LAN:
     ```bash
     sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp
     sudo ufw deny 3000/tcp
     ```
   Never expose plaintext HTTP to the internet — the session cookie won't carry
   `Secure` and credentials would transit in the clear.
4. **Session tokens** are random (`crypto.randomBytes`) and stored as SHA-256 hashes
   in SQLite — not JWT. `BOT_SESSION_SECRET` in `.env` is reserved/unused today
   (installer still generates one for forward compatibility).
5. **Dependency advisories.** Run `npm audit` periodically; watch the
   `@discordjs/opus → node-pre-gyp → tar` install-time chain.

Only the TeamSpeak ports (9987/udp, 30033/tcp, query) face the network. The bot
UI (`3000`), RKLLama (`8080`), STT (`9000`), and Piper (`8880`) are localhost-bound in compose.
