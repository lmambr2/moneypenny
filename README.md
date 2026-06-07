<p align="center">
  <img src="./assets/wordmark.svg" alt="Moneypenny" width="620">
</p>

<p align="center">
  A self-hosted, NPU-accelerated <b>AI + music assistant</b> for a <b>TeamSpeak 6</b> server,<br>
  running entirely on a single <b>Orange Pi 5 Max (RK3588, 16 GB)</b>.<br>
  <br>
  <b>One repo. One <code>docker compose up</code>. No cloud.</b>
</p>

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
# ./install.sh --llm ollama --model qwen2.5:3b --with-voice
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
- `PHASE0_TEST_PLAY`, `BOT_NAME`, `BOT_NICKNAME`, `DEFAULT_CHANNEL`

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
