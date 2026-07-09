<p align="center">
  <img src="./assets/wordmark.svg" alt="Moneypenny" width="620">
</p>

<p align="center">
  A self-hosted <b>AI + music assistant</b> for a <b>TeamSpeak 6</b> server.<br>
  <b>Two editions, one repo:</b> <b>SBC</b> (Orange Pi / RK3588) and <b>Server</b> (x86 + GPU).<br>
  <br>
  <b>No cloud required.</b> Whisper STT · Piper British TTS · local Gemma.
</p>

## Table of Contents

- [Features](#features)
- [Commands](#commands)
- [Editions](#editions)
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

**Dual-edition product.** Music + local-AI assistant with a rank-gated knowledge
base and per-user memory; **797** backend unit tests and **11** frontend unit
tests passing (110 test files).

| Edition | Bot primary host | Chat | Voice |
|---------|------------------|------|-------|
| **SBC** | Orange Pi 5 Max (RK3588) | LAN Gemma 4 **12B** (E2B offline fallback) | Whisper **tiny** (+ RKNN later) + Piper |
| **Server** | x86_64 Linux (**AMD** first; NVIDIA untested) | **Host Ollama** Gemma 4 **12B** (+ 31B if headroom) | whisper.cpp **Vulkan** (AMD) + Piper |

**Bot runs on the machine you install** (`--edition sbc` or `server`). Embeddings +
Qdrant stay on that host. See [docs/editions.md](./docs/editions.md),
[docs/remote-llm.md](./docs/remote-llm.md), [docs/voice-backends.md](./docs/voice-backends.md),
[RELEASES.md](./RELEASES.md), [DESIGN.md](./DESIGN.md), [ROADMAP.md](./ROADMAP.md).

## Features

**Music sources**
- **Local library** (primary) — indexed `MUSIC_DIR`; search by title/artist/album, M3U playlists, web upload.
- **YouTube** — search + direct URLs (yt-dlp). Optional **save-to-library**: a played video is downloaded as a tagged MP3 into your library (deduped by video id) so replays are local.
- **X / Twitter / Bandcamp** — play their audio directly (yt-dlp).
- **Spotify / Tidal** — links resolve to the track and play from Local/YouTube (DRM-free, no credentials); or stream for real via an optional librespot/Tidal bridge (`STREAM_BRIDGE_URL`).
- **Direct streams** — any http(s)/Icecast URL.

**AI — entirely local (NPU/CPU/LAN), no cloud**
- `!ask <question>` — fast Gemma answers; fuzzy natural-language requests drive music via tool-calls.
- `!analyst <task>` / `!agent <task>` — route heavy analysis to a **second** LAN model (e.g. Gemma 4 31B on a GPU box); same doctrine grounding as `!ask`. Configure delegate URL/model in Settings or see **[docs/remote-llm.md](./docs/remote-llm.md)** (DESIGN §R1).
- **Split-brain inference** — chat/tool-calling on a LAN workstation (`llmUrl`), embeddings + Qdrant on the Pi, Pi ollama as fallback when the LAN host is down.
- **Document RAG / knowledge base** — load `.md` doctrine four ways: the web UI (Library → Doctrine), a `git push` wiki, a manual file drop, or **dragging files into a TeamSpeak `moneypenny-drop` channel** (`.md` → knowledge base, audio → music library). `!ask` and `!analyst` answers are grounded and carry a `📎 Sources:` footer. **Rank-gated**: classified docs (frontmatter `classification:`) stay hidden from members without the matching `doctrine:<level>` right. → **[docs/rag-ingestion.md](./docs/rag-ingestion.md)**
- **Per-user memory** — `!remember <fact>` / `!recall`; facts are woven into that member's `!ask`.
- **Institutional knowledge graph** — `!kg` / `!diary` for temporal org facts (roster, roles, op history); injected into `!ask` when enabled.
- **Org document workflows** — `!intsum` / `!aar` templated reports via the analyst delegate; Pandoc docx export from the Library.
- **Persona** — Miss Moneypenny: dry British MI6-secretary wit (configurable system prompt).

**Community & ops**
- **Roast** — captures chat lines, AI-grades them for cringe, auto-posts a "greatest hits" reel when enough people are present; opt out + purge with `!roastout`.
- **Rank gating** — declarative rights mapped to TS server-groups; gates typed + voice + LLM-driven commands (no escalation via natural language); rules can be **scoped to voice or chat**. Verify with `GET /api/bot/rights/debug`.
- **Radio mode (autonomous DJ)** — off by default; between songs or on dead air she drops a short bumper: a prerecorded jingle, a spoken station ID/time check, or a doctrine tip rewritten by the LLM and TTS'd in persona, gated to the **least-cleared listener present**. `!radio ops <profile>` retunes music + bumper topics in one switch. → **[docs/radio.md](./docs/radio.md)**
- Optional **voice loop** — **Whisper** STT (`tiny` on SBC → `large-v3` on Server) + **Piper** British TTS ([docs/voice-backends.md](./docs/voice-backends.md)); watchdog; localhost-bound web UI.

All AI/community features are **off by default** — toggle them in **Settings → AI & Permissions**.

## Editions

One codebase. Two install shapes ([docs/editions.md](./docs/editions.md)):

```bash
# Orange Pi / RK3588 — edge bot + embeddings + tiny Whisper
./install.sh --edition sbc --with-rag --with-voice

# x86 server — local 12B chat + server Whisper ladder
./install.sh --edition server --with-rag --with-voice

# Auto-detect (aarch64 → sbc, else server)
./install.sh --edition auto --with-rag --with-voice
./scripts/detect-edition.sh
```

**Split-brain (recommended):** install **SBC** on the Pi, run Ollama 12B on the
Server (or full Server edition), then set Settings `llmUrl` to the Server LAN IP.
**All-in-one:** Server edition only. **Offline Pi:** SBC with local E2B (slow).

Release tarballs: [RELEASES.md](./RELEASES.md) · `./scripts/package-release.sh`

## Commands

Chat commands (default prefix `!`):

| Command | What it does |
|---|---|
| `!play <query \| url>` | Play — Local first, else YouTube. Accepts YouTube / X / Twitter / Bandcamp / Spotify / Tidal / direct-stream URLs. `-y` forces YouTube, `-l` Local. |
| `!add` · `!playnext` (`!pn`) | Add to queue · play next |
| `!skip` `!next` `!prev` `!pause` `!resume` `!stop` | Transport |
| `!queue` `!now` `!clear` `!remove <n>` `!vol <0-100>` `!mode <seq\|loop\|random\|rloop>` | Queue / playback control |
| `!playlist` `!album` `!artist` `!lyrics` `!vote` | Library / misc |
| `!ask <question>` | Ask the fast AI (grounded in doctrine + your memory, if enabled) |
| `!analyst <task>` · `!agent <task>` | Heavy analysis (async ack + posted result; admin/`@analyst` by default) |
| `!remember <fact>` · `!recall` | Per-user memory |
| `!roast` · `!roastout` | Show the roast reel · opt out + purge |
| `!radio [on\|off\|status]` | Autonomous DJ — bumpers between tracks ([docs](docs/radio.md)); `on/off` admin |
| `!radio ops <profile>` · `!radio bumper [topic]` · `!radio say <text>` · `!radio skip` · `!radio pin` | Station programming (`@dj` + admin); `pin` promotes last bumper to prerecorded pool |
| `!selecttracks <json>` | Tag-driven local track selection (normally via the `select_tracks` LLM tool) |
| `!intsum [-s] [class:<level>] <points>` · `!aar [-s] …` | Templated INTSUM / AAR generation (analyst delegate; `-s` saves to doctrine) |
| `!kg remember <fact>` · `!kg who <name> [asof:date]` · `!kg list` · `!diary intel\|logistics <fact>` | Institutional knowledge graph (analyst-gated) |
| `!rate <1-5> [song]` · `!unrate` | Star-rate the current (or a searched) track |
| `!reindex` *(admin)* | Re-embed the doctrine corpus |
| `!ingeststatus` *(admin)* | Recent TeamSpeak file-drop ingests + any errors |
| `!move` `!follow` *(admin)* | Move the bot / follow invoker |
| `!moveclient <user> <channel>` *(admin)* | Move another user to a channel (TS6 HTTP Query or TS3) |
| `!moveall <channel>` · `!moveall confirm` *(admin)* | Mass-move everyone else in the channel (30s confirm, max 10) |
| *(voice/NL)* | "move Bond to briefing" — fast model calls `move_client` when invoker has move rights |

## Quick Start

One command — auto-detects **SBC** (aarch64) or **Server** (x86):

```bash
curl -fsSL https://raw.githubusercontent.com/lmambr2/moneypenny/main/install.sh | bash
```

| Host | Edition | Defaults |
|------|---------|----------|
| Orange Pi / RK3588 | **sbc** | E2B offline fallback; Whisper tiny; point `llmUrl` at LAN 12B |
| x86_64 Linux (**AMD**) | **server** | host Ollama Gemma 4 12B; whisper.cpp Vulkan; optional TS6 |
| Either | `--llm npu` | rkllama on SBC only (offline opt-in) |

Installer installs Docker if needed, writes `.env` + `COMPOSE_FILE` for the
edition overlay, and starts profiles. Then open **http://localhost:3000**.

```bash
git clone https://github.com/lmambr2/moneypenny.git && cd moneypenny
./install.sh --help
./install.sh              # text-interactive wizard (TTY)
./install.sh -y           # non-interactive auto defaults
# ./install.sh --edition sbc --llm http://192.168.x.x:11434 --with-rag --with-voice -y
# ./install.sh --edition server --with-rag --with-voice -y
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
   - **LLM**: If you want `!ask`, `!analyst`, and natural-language music control, enable it and point it at your backend (the installer usually sets this up for you via `RKLLAMA_URL`). For a faster LAN chat box + Pi embeddings, use the **Remote chat + local embeddings** preset in Settings — see [docs/remote-llm.md](./docs/remote-llm.md).
   - **Voice (optional)**: Enable after `voice-edge` (SBC) or `voice-server` (Server) is up — Whisper + Piper. Set **text wake fallback** on (no KWS). See [docs/voice-backends.md](./docs/voice-backends.md).

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
   ssh -L 4000:localhost:3000 user@your-pi-host
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

### Pi deploy (operators)

Production fork: deploy from `Projects/moneypenny` (not the slim clone). Use the guarded scripts — never bare `rsync` to the Pi:

```bash
./scripts/deploy-preflight.sh          # fingerprint + critical tests
./scripts/deploy-to-pi.sh              # preflight → rsync → rebuild → verify
./scripts/deploy-to-pi.sh --files bot/src/bot/voice/session.ts --services bot
./scripts/verify-pi-deploy.sh         # post-deploy smoke on opi5
```

See `AGENTS.md` §5 for rsync pitfalls and SSH forward conflicts.

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
- `RKLLAMA_URL` / `RKLLAMA_MODEL` (fallbacks; the web Settings panel is preferred). Default backend is Ollama + Gemma 4 E2B GGUF.
- `STREAM_BRIDGE_URL` (for Spotify/Tidal via an external librespot/Tidal bridge)

**Knowledge base / RAG (Phase 5/6)** — bring up with `--profile rag` or `install.sh --with-rag`
- `VECTOR_DB_URL` (Qdrant), `EMBEDDING_URL` (blank → reuses the LLM endpoint), `EMBEDDING_MODEL` (`embeddinggemma` — Gemma-family, all platforms)

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
- `llmUrl`, `llmModel` (primary OpenAI-compatible chat endpoint — often a LAN workstation)
- `llmFallbackUrl`, `llmFallbackModel` (Pi-local fallback when primary is unreachable)
- `llmDelegateUrl`, `llmDelegateModel` (heavy analyst for `!analyst` / `!agent` / `delegate_to_agent`)
- `embeddingUrl`, `embeddingModel` (embeddings — usually Pi ollama + `embeddinggemma`)
- `llmSystemPrompt`, `llmTemperature`

See [docs/remote-llm.md](./docs/remote-llm.md) for split-brain + analyst presets.

**Knowledge base + memory (Phase 6/7)**
- `ragEnabled`, `ragTopK` (Document RAG / doctrine grounding for `!ask` and `!analyst`)
- `memoryEnabled` (`!remember`/`!recall` injected into `!ask`)

**Community / media**
- `roastEnabled`, `roastMinPresent`, `roastCooldownMinutes`
- `youtubeSaveEnabled` (save played YouTube videos as tagged MP3s to the library)

**Permissions (Rank Gating)**
- `rightsEnabled` (default `true`)
- `adminGroups` (TS server-group IDs used as the web-admin fallback + legacy simple mode)
- `rights` (full custom rules JSON — starter template: `scripts/rights-rank-gating.json`; replace placeholder group IDs with yours)
- See **[docs/rank-gating.md](./docs/rank-gating.md)** for the military-rank tier map, doctrine levels, and TS6 group-resolution notes

**Voice**
- `voice.enabled`
- `voice.respondWithVoice`
- `voice.sttUrl` (`http://stt-whisper:9000`)
- `voice.ttsUrl` (`http://piper-tts:8880`)
- `voice.ttsVoice` (`en_GB-southern_english_female-low`)
- `voice.textWakeFallback` (**true** for Whisper — no KWS)

**Advanced / Hardening**
- `bindAddress`
- `publicUrl` + `trustProxy` (required when behind Caddy/nginx)
- `streamBridgeUrl`

**Full example of a custom rights config** (advanced):

```json
{
  "rightsEnabled": true,
  "adminGroups": [105, 106, 107, 108, 109],
  "rights": { "...": "copy scripts/rights-rank-gating.json and substitute your TS server-group IDs" }
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
- **Phase 3**: Polish (Spotify/Tidal bridge, watchdog, UI panels)
- **Phase 4**: Scalable / remote LLM (OpenAI-compatible endpoint)
- **Phase 5–6**: Vector store + **document RAG** (doctrine, rank-gated, cited)
- **Phase 7**: Long-term per-user memory
- **Phase 8**: Community layer (the roast)

See **[ROADMAP.md](./ROADMAP.md)** for the status of Phases 4–8.

## Documentation

- **[docs/editions.md](./docs/editions.md)** — SBC vs Server product matrix and topologies
- **[docs/gpu-amd.md](./docs/gpu-amd.md)** — AMD Server: host Ollama + whisper.cpp Vulkan
- **[RELEASES.md](./RELEASES.md)** — how release tarballs are built and installed
- **[DESIGN.md](./DESIGN.md)** — architecture (v3), rights (§8), hardening (§11), phased plan (§13)
- **[ROADMAP.md](./ROADMAP.md)** — phase status (4–8) and the org-AI direction
- **[docs/remote-llm.md](./docs/remote-llm.md)** — split-brain chat + embeddings; 31B opt-in
- **[docs/voice-backends.md](./docs/voice-backends.md)** — dual-track Whisper (RKNN / whisper.cpp) + Piper
- **[docs/voice.md](./docs/voice.md)** — voice loop wiring, probes, smoke tests
- **[docs/rank-gating.md](./docs/rank-gating.md)** — TS server-group → command/doctrine permissions
- **[docs/rag-ingestion.md](./docs/rag-ingestion.md)** — knowledge base ingestion paths
- **[docs/hardening.md](./docs/hardening.md)** — UFW + TLS reverse-proxy recipe
- **[docs/radio.md](./docs/radio.md)** — autonomous DJ / radio mode
- **[docs/r3-workflows.md](./docs/r3-workflows.md)** — INTSUM/AAR + Pandoc export
- **[docs/phase0.md](./docs/phase0.md)** — first-run validation against a real TS6 server
- **[docs/FORK.md](./docs/FORK.md)** — what changed from the upstream fork
- **[CHANGELOG.md](./CHANGELOG.md)** — notable changes + per-batch AI attribution

## License & Credits

Moneypenny is released under the [MIT License](./LICENSE).

It is derived from [ZHANGTIANYAO1/teamspeak-music-bot](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot) (MIT) — reworked and extended. Some subsystems reimplement patterns from OSL-3.0 / GPL-3.0 projects in spirit, without copying their source (see DESIGN.md §5).

## Hardware targets

**SBC edition**
- Orange Pi 5 Max (RK3588, 16 GB LPDDR4X), active cooling, NVMe preferred
- Ubuntu 24.04 arm64 / Armbian / DietPi (vendor 6.1 kernel)
- Optional NPU: RKNPU 0.9.8 + RKLLM 1.2–1.3 (offline chat only)

**Server edition**
- x86_64 Linux, 32 GB+ RAM recommended for Gemma 4 12B QAT
- **AMD** GPU preferred (host Ollama ROCm + whisper.cpp Vulkan); NVIDIA untested
- macOS / Apple Silicon: **out of scope** for now
