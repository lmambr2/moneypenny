# Phase 0 — Validate the Base Fork + Basic Playback

**Goal (DESIGN.md §13):**  
Fork builds and runs; its TS6 client connects to a real TeamSpeak 6 server and plays audio (Local or YouTube).  
**Accept:** Bot is visible in channel and successfully plays a test track.

## Current Status

- Base fork integrated and modified; LocalProvider + YouTube working.
- Auto bot creation from `TS6_*` / `TS_HOST` env vars.
- Auto-play on connect when `PHASE0_AUTO_TEST=1` (runs `!test`) or `PHASE0_TEST_PLAY` is set (validation URL). `TS6_HOST` alone does not trigger playback.
- Logs print loud `PHASE 0 SUCCESS` or `PHASE 0 FAILURE` banners for scripted validation.

## Quick Validation

### 1. Prepare environment

```bash
cp .env.example .env
# Edit .env — at minimum set a real TS6_HOST (not the placeholder "teamspeak")
```

Minimal `.env`:

```
TS6_HOST=your-ts6-server.example.com
TS6_PORT=9987
TS6_API_KEY=your-ts6-http-query-key
MUSIC_DIR=/path/to/test/music
```

### 2. Run the helper script

```bash
# Pre-flight only (docker + .env checks, no containers)
./scripts/phase0-validate.sh --check-only

# Foreground (watch logs interactively)
./scripts/phase0-validate.sh

# Detached — start bot, poll logs, exit 0/1 when SUCCESS/FAILURE seen
./scripts/phase0-validate.sh --detach --timeout 180 --yes

# Custom track
./scripts/phase0-validate.sh "https://youtu.be/..."
./scripts/phase0-validate.sh "test-track.mp3"   # file in MUSIC_DIR
```

**Flags:**

| Flag | Purpose |
|------|---------|
| `--check-only` | Verify docker + `.env` + `TS6_HOST`; exit without starting bot |
| `--detach` | `docker compose up -d`, poll logs for result banner |
| `--timeout SEC` | Max wait in detached mode (default 300) |
| `--yes` / `-y` | Skip interactive ".env edited?" prompt |
| `--no-build` | Skip image rebuild |

Default test track (when none passed): `https://www.youtube.com/watch?v=hLOheGDwD_0`

### 3. Manual alternative

```bash
export PHASE0_TEST_PLAY="https://www.youtube.com/watch?v=hLOheGDwD_0"
docker compose --profile core up --build bot
```

### 4. Verify

- Bot appears in your TS6 channel.
- Logs show `PHASE 0 SUCCESS` (or `PHASE 0 FAILURE` with a reason).
- Audio is heard in the channel.
- Basic commands (`!play`, `!skip`, `!pause`) work via chat or web UI.

### 5. NPU side (Orange Pi)

```bash
./host-setup/check-npu.sh
```

## Manual Bot Creation

If auto-create did not trigger, use the web UI at http://localhost:3000 → Settings → Bots → Add new bot.

## Acceptance Criteria

- Bot connects to a real TS6 server (visible in channel).
- Plays at least one track from Local or YouTube end-to-end.
- No crashes on connection or playback.
- Basic commands work.

Once solid, Phase 1a (library polish + UI) is next.