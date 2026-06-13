<p align="center">
  <img src="./assets/wordmark.svg" alt="Moneypenny" width="620">
</p>

<p align="center">
  A self-hosted, NPU-accelerated <b>AI + music assistant</b> for a <b>TeamSpeak 6</b> server,<br>
  running entirely on a single <b>Orange Pi 5 Max (RK3588, 16 GB)</b>.<br>
  <br>
  <b>One repo. One <code>docker compose up</code>. No cloud.</b>
</p>

## Table of Contents

- [Quick Start](#quick-start)
- [Accessing the Web UI from Another Machine](#accessing-the-web-ui-from-another-machine)
- [Configuration Guide](#configuration-guide)
  - [Dummy-Proof Section](#dummy-proof-section-start-here)
  - [Advanced / Power-User Section](#advanced--power-user-section)
- [Troubleshooting & Common Commands](#troubleshooting--common-commands)
  - [Cache-busting stale frontend bundles (the exact steps that worked)](#cache-busting-stale-frontend-bundles-the-exact-steps-that-worked)
  - [Full clean reset / nuke (for first-run or branding issues)](#full-clean-reset--nuke-for-first-run-or-branding-issues)
  - [Inspecting current state](#inspecting-current-state)
- [Common Docker Compose Commands](#common-docker-compose-commands)

## Status

**Phases 1–3 implemented** (music, LLM Q&A + tool control, rank permissions, voice loop, watchdog, web UI); 300 unit tests passing. Voice STT/TTS sidecars are built but await on-device NPU validation. See [DESIGN.md](./DESIGN.md) for the full architecture, phased plan, hardware requirements, and security posture.

## Quick Start

One command — works on **x86-64** and the **Orange Pi (aarch64/NPU)**:

```bash
curl -fsSL https://raw.githubusercontent.com/lmambr2/moneypenny/main/install.sh | bash
```

The installer auto-detects your hardware and wires up an OpenAI-compatible LLM
backend accordingly:

| Host | LLM backend | Notes |
|------|-------------|-------|
| Orange Pi 5 Max (aarch64 + RK3588 NPU) | **rkllama**, native NPU | runs `host-setup/install-npu.sh` for you |
| x86-64 / any other Linux | **Ollama** (CPU/GPU) | pulls a small model (~2 GB) on first run |

It also installs Docker if missing (after a prompt), generates a `.env` with a
random session secret, sets up volumes, and starts the stack. Then open the
**Web UI at http://localhost:3000** and create your admin account.

Prefer to inspect first? Clone and run it locally:

```bash
git clone https://github.com/lmambr2/moneypenny.git && cd moneypenny
./install.sh --help          # see all options
./install.sh                 # auto
# ./install.sh --llm ollama --model gemma4:e4b-it-qat --with-voice
# ./install.sh --llm http://my-existing-llm:11434   # bring your own endpoint
```

<sub>The UI binds to localhost only by default. See the "Accessing the Web UI from Another Machine" section below for LAN access from your PC.</sub>

## Accessing the Web UI from Another Machine (e.g. your PC to the Pi)

### Easiest (no changes to the Pi, works right now)
Use an SSH tunnel from your PC:

```bash
ssh -L 3000:localhost:3000 youruser@<pi-ip-address>
```

Then open **http://localhost:3000** in your browser on the PC. The traffic is securely tunneled over SSH.

**Important for updates / rebuilds / branding changes:** See the detailed cache-busting steps in the troubleshooting section below. Using a different local port (e.g. 4000 instead of 3000) + fresh private window + DevTools disable cache + `?cb=` + hard reload is often required to pull in a new frontend bundle.

### Open the port on the LAN (quick & dirty)
On the Pi, edit `docker-compose.yml` and change the bot service ports line from:

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

to:

```yaml
ports:
  - "0.0.0.0:3000:3000"
```

Then apply:

```bash
docker compose up -d bot
```

On the Pi allow your LAN subnet (example for common home networks):

```bash
sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp
sudo ufw reload
```

From your PC: `http://<pi-ip-address>:3000`

**Security note**: Only do this if you trust your LAN. The recommended long-term approach is a reverse proxy (Caddy or nginx) with HTTPS in front of the UI and `trustProxy: true` in the bot config (see Advanced section).

### Recommended for anything exposed
Run a reverse proxy on the Pi (Caddy is easy) that terminates TLS and forwards to the bot on localhost:3000. Then set `trustProxy: true` and `publicUrl` in the bot Settings panel. See [docs/hardening.md](./docs/hardening.md) for the exact UFW + proxy recipe.

## Configuration Guide

Most day-to-day configuration happens in two places:

1. **.env** (or environment variables passed to Docker) — used at container startup for connections, paths, and secrets.
2. **Web UI → Settings panel** (or `bot/data/config.json`) — the source of truth for runtime behavior after first run. Changes here are hot-reloadable for many options.

### Dummy-Proof Section (Start Here)

After `docker compose up` or the installer finishes:

1. On the machine running the containers (or via SSH tunnel — see above), open **http://localhost:3000**.
2. Create your first account — it automatically becomes admin.
3. Go to **Settings** in the web UI and set these basics:

   - **Music folder**: Make sure the `MUSIC_DIR` you set in `.env` actually contains your music files and is mounted correctly (the container sees it at `/music`).
   - **TeamSpeak connection**: Fill in your TS6 server address, query port (usually 10022 for SSH query), and especially `TS6_API_KEY` if you have one (strongly recommended).
   - **LLM**: If you want `!ask` and natural-language music control, enable it and point it at your backend (the installer usually sets this up for you via `RKLLAMA_URL`).
   - **Voice (optional)**: Enable the voice loop only after you've started the `kokoro` (and optionally sherpa-onnx) sidecars.

4. Add your bot in the UI (or let the `PHASE0_*` variables in `.env` auto-create one on first start).

**If you don't see the first-time setup screen** (you get the normal "Login to Moneypenny" form instead, or the old TSMusicBot/MusicBot branding/logo appears):

The screen (and correct branding) only appears when:
- The users table is empty (`/api/session/needs-setup` returns `true` — backend/DB side), **and**
- Your browser has loaded the *current* frontend bundle (new hashed JS/CSS from the latest build — client side).

Old browser-cached `index.html` + old `index-*.js` bundle is the most common cause even after DB wipes and rebuilds (the SPA shell and its router guard live in the JS; stale assets make the app think it's already initialized and show the old logo/guard).

### Cache-busting stale frontend bundles (the exact steps that worked)

Standard "hard-refresh or incognito" is often not enough after a source change + image rebuild. The procedure below (different local tunnel port + fresh private window + DevTools disable cache + `?cb=` + hard reload + verify the JS hash) is what finally pulled in the new bundle.

**On your PC (with tunnel active):**

1. Fresh tunnel on a *different* local port (brand-new origin — zero browser cache/history):
   ```bash
   ssh -L 4000:localhost:3000 dietpi@opi5
   ```

2. Close **every** tab that has ever touched `localhost:3000` (or 4000).

3. Open a **brand new private/incognito window**.

4. In that window, open DevTools **first** (F12) → **Network** tab → tick **"Disable cache"**.

5. Go to `http://localhost:4000/?cb=1725123456789012345` (use a completely fresh number you've never used before — this forces re-fetch of the current index.html).

6. Hard reload: **Ctrl+Shift+R** (or Cmd+Shift+R).

7. In the Network tab, confirm the main JS file loaded has the *new* hash (different from any previous `index-*.js`). The logo should now say Moneypenny.

Then in the console of that same tab:
```js
fetch('/api/session/needs-setup').then(r => r.json()).then(console.log)
```

It should return `{ needsSetup: true }`. The guard will send you to the first-time setup form.

If it still looks wrong, also try manually:
```
http://localhost:4000/first-run?cb=1725123456789012345
```
(hard reload with disable cache). `/first-run` is a public route.

**Verify what the server is actually advertising (from your laptop, tunnel up):**
```bash
curl -s "http://localhost:4000/?cb=$(date +%s)" | grep -o 'src="[^"]*index[^"]*\.js"'
```

This should match the new hash you saw on the Pi. If it still shows an old hash, the running container's static files are stale — re-run the build + up sequence.

### Full clean reset / nuke (for first-run or branding issues)

**On the Pi (in the project dir):**

```bash
# Stop and remove containers
docker compose -f docker-compose.yml -f docker-compose.npu.yml --profile core --profile npu down --remove-orphans

# Remove the old image so the next build is truly fresh
docker rmi moneypenny-bot:latest || true

# Nuke all local state (DB, config, avatars, logs — this forces users=0 and a fresh Phase-0 bot)
rm -rf bot/data/*

# Pull latest source (Moneypenny branding + first-run guard fixes)
git pull

# Full clean build (no cache — this regenerates web/dist with the current logo + guard)
docker compose -f docker-compose.yml -f docker-compose.npu.yml --profile core --profile npu build --no-cache bot

# Start fresh
docker compose -f docker-compose.yml -f docker-compose.npu.yml --profile core --profile npu up -d --force-recreate bot
```

Wait 10-15 s, then verify:
```bash
docker compose -f docker-compose.yml -f docker-compose.npu.yml --profile core --profile npu logs --tail=30 bot
```
Look for the new `"using SQLite database"` line with `moneypenny.db` and the web server starting.

### Inspecting current state

**From your laptop (tunnel up) — what bundle the server is currently advertising:**
```bash
curl -s "http://localhost:4000/?cb=$(date +%s)" | grep -o 'src="[^"]*index[^"]*\.js"'
```

**On the Pi — users / bots count (and confirm which DB is live):**
```bash
docker compose -f docker-compose.yml -f docker-compose.npu.yml --profile core --profile npu exec bot node -e '
  const db = require("better-sqlite3")("/app/data/moneypenny.db");
  console.log("users:", db.prepare("SELECT COUNT(*) as n FROM users").get().n);
  console.log("bots:", db.prepare("SELECT COUNT(*) as n FROM bot_instances").get().n);
  db.close();
'
```

**Logs (the one the installer prints):**
```bash
docker compose -f docker-compose.yml -f docker-compose.npu.yml --profile core --profile npu logs -f bot
```

### Common Docker Compose Commands

For convenience on the Pi, you can set these once (in your current shell or `~/.bashrc`):

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.npu.yml
export COMPOSE_PROFILES=core,npu
```

Then the short forms work:

```bash
# Start / restart
docker compose up -d --force-recreate bot

# Logs
docker compose logs -f bot

# Stop just the bot
docker compose stop bot

# Full down
docker compose down --remove-orphans
```

With the long flags (if you don't want the exports):

```bash
docker compose -f docker-compose.yml -f docker-compose.npu.yml --profile core --profile npu up -d --force-recreate bot
docker compose -f docker-compose.yml -f docker-compose.npu.yml --profile core --profile npu logs -f bot
```

If you also want the bundled TeamSpeak server or voice sidecars, add `--profile server` or `--profile voice`.

### After first-run
Once you create the admin account, the DB will have a user, `needsSetup` becomes false, the session cookie is set, and the main app (with correct branding) will load. The WS connection and authenticated calls will start working.

If the container cannot create `bot/data/moneypenny.db` you will see crashes on startup. Make sure the host directory is writable by uid 1000:

```bash
mkdir -p bot/data && sudo chown -R 1000:1000 bot/data
```

Check logs with `docker compose logs -f bot` for messages about the DB path or any "Migrated legacy..." line. See also the "Accessing the Web UI..." section above for the SSH tunnel and the compose port publishing notes.

### Why the extra cache-busting steps are sometimes required
Standard "hard-refresh or incognito" is often not enough for a Vite-built SPA after an image rebuild/rename. The old `index.html` (which embeds the old hashed JS filename) can be cached even with `max-age=0` + ETags, and the specific JS file URL stays in the browser's cache. Using a different local tunnel port (fresh origin) + `?cb=` (fresh document URL) + DevTools "Disable cache" + hard reload forces the browser to actually request the current `index.html` from the server, which then loads the current JS bundle.

This procedure (new tunnel port + fresh private window + DevTools disable cache + `?cb=` + hard reload + verify the JS hash in Network tab) is what finally got the new Moneypenny branding + first-run screen after a full nuke + rebuild.

5. Test basic playback with `!play <song or youtube url>` in your TS channel.

That's it for 90% of users. Everything else has sane defaults.

**Common .env tweaks for normal use** (copy from `.env.example`):

```env
MUSIC_DIR=/path/to/your/music/on/the/pi          # Must exist and be readable
TS6_HOST=your-ts6-server-or-docker-service
TS6_QUERY_HOST=...
TS6_API_KEY=your-ts6-http-query-key               # Highly recommended
BOT_SESSION_SECRET=make-this-a-long-random-string # Already generated by installer
```

### Advanced / Power-User Section

#### .env Variables (Docker / Startup)

See the full `.env.example` in the repo. Important ones:

**TeamSpeak**
- `TS6_HOST`, `TS6_PORT`, `TS6_QUERY_HOST`, `TS6_QUERY_PORT`
- `TS6_SERVER_PASSWORD`, `TS6_API_KEY` (use the API key whenever possible)

**Auto bot creation** (only on first startup when DB is empty)
- `PHASE0_TEST_PLAY` (defaults to the canonical unit test/startup video https://www.youtube.com/watch?v=hLOheGDwD_0 ), `BOT_NAME`, `BOT_NICKNAME`, `DEFAULT_CHANNEL`

**Web / Auth**
- `BOT_WEB_PORT`
- `BOT_SESSION_SECRET` (critical — use a strong random value)
- `BIND_ADDRESS` (inside container usually `0.0.0.0`; the publish line in compose controls host exposure)

**LLM**
- `RKLLAMA_URL` / `RKLLAMA_MODEL` (fallbacks; the web Settings panel is preferred)
- `STREAM_BRIDGE_URL` (for Spotify/Tidal via external librespot etc.)

**Voice (Phase 2)**
- `KOKORO_URL`

**Hardening / Ops**
- `WATCHDOG_MEMORY_MB` (kills the process if it exceeds this; Docker restarts it)
- `MUSIC_DIR`

#### In-App Settings (web UI / config.json)

These live in `bot/data/config.json` and are managed through the web UI (GET/POST `/api/bot/settings`).

Key options:

**Basic**
- `commandPrefix` (default `!`)
- `commandAliases` (e.g. `{ "p": "play", "s": "skip" }`)
- `idleTimeoutMinutes` (auto-disconnect bot if channel empties)
- `autoPauseOnEmpty`, `autoReturnDelay`

**LLM**
- `llmEnabled`
- `llmUrl`, `llmModel` (OpenAI-compatible endpoint)

**Permissions (Rank Gating)**
- `rightsEnabled` (default true — safe)
- `adminGroups` (array of TS server-group IDs that get admin commands)
- `rights` (full custom rules JSON — see DESIGN.md §8 and the RightsEngine)

**Voice**
- `voice.enabled`
- `voice.respondWithVoice`
- `voice.sttUrl` (sherpa-onnx)
- `voice.ttsUrl` (Kokoro)
- `voice.ttsVoice`

**Advanced / Hardening**
- `bindAddress`
- `publicUrl` + `trustProxy` (required when behind Caddy/nginx)
- `streamBridgeUrl`

**Full example of a custom rights config** (advanced):

```json
{
  "rightsEnabled": true,
  "adminGroups": [6, 7],
  "rights": {
    "defaultAllow": ["play", "skip", "pause", "ask"],
    "superAdminUids": ["your-uid-here"],
    "rules": [
      { "match": { "serverGroups": ["6"] }, "allow": ["stop", "clear", "vol"] }
    ]
  }
}
```

See `DESIGN.md` §8–11 and `docs/hardening.md` for security implications and the full list of options.

## Phases

See DESIGN.md §13 for the detailed phased plan with acceptance criteria:

- **Phase 0**: Validate base fork + TS6 client playback
- **Phase 1a**: Local-first music (LocalProvider + YouTube)
- **Phase 1b**: LLM Q&A + natural language tool control
- **Phase 1c**: Rank-based permissions
- **Phase 2**: Voice loop (VAD/STT → router → TTS)
- **Phase 3**: Polish (Spotify bridge, watchdog, UI panels)

## License & Credits

Moneypenny is released under the [MIT License](./LICENSE).

It is derived from [ZHANGTIANYAO1/teamspeak-music-bot](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot) (MIT) — reworked and extended. Some subsystems reimplement patterns from OSL-3.0 / GPL-3.0 projects in spirit, without copying their source (see DESIGN.md §5).

## Hardware Target

- Orange Pi 5 Max (RK3588, 16 GB LPDDR4X)
- Active cooling mandatory for Phase 2
- NVMe for models + music library
- Ubuntu 24.04 arm64 or Armbian (vendor 6.1 kernel)
- RKNPU 0.9.8 + RKLLM 1.2.3
