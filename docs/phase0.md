# Phase 0 — Validate the Base Fork + Basic Playback

**Goal (DESIGN.md §13):**  
Fork builds and runs; its TS6 client connects to a real TeamSpeak 6 server and plays audio (Local or YouTube).  
**Accept:** Bot is visible in channel and successfully plays a test track.

## Current Status
- Base fork is already integrated and heavily modified.
- De-sinicization complete.
- LocalProvider + YouTube working.
- Control router mature.
- Auto bot creation from environment supported (very useful for quick validation).

## Quick Validation Steps (Recommended)

1. **Prepare environment**
   ```bash
   cp .env.example .env
   # Edit .env with your TS6 details
   ```

   Minimal for Phase 0:
   ```
   TS6_HOST=your-ts6-server.example.com
   TS6_PORT=9987
   TS6_API_KEY=your-ts6-http-query-key   # strongly recommended for TS6
   MUSIC_DIR=/path/to/test/music
   ```

2. **Start the stack (easiest way)**
   ```bash
   ./scripts/phase0-validate.sh
   # (defaults to the built-in Moneypenny unit test / startup demo video:
   #  https://www.youtube.com/watch?v=hLOheGDwD_0 )
   #
   # or pass any other track:
   # ./scripts/phase0-validate.sh "https://youtu.be/..."
   # ./scripts/phase0-validate.sh "test-track.mp3"  # from your MUSIC_DIR
   ```

   Or manually:
   ```bash
   export PHASE0_TEST_PLAY="https://www.youtube.com/watch?v=hLOheGDwD_0"
   # (this is also the built-in default when the variable is unset)
   docker compose --profile core up --build
   ```

   The bot will:
   - Start the web UI on port 3000
   - If no bots exist, auto-create one from the TS6_* variables and auto-connect.
   - Automatically attempt to play your test track a few seconds after connecting.
   - Print very loud "PHASE 0 SUCCESS" banners in the logs when both connection and playback succeed.

3. **Verify**
   - Bot appears in your TS6 channel with the configured nickname.
   - Use the web UI (or `!play`) to play a track from your local library or YouTube.
   - Audio is heard in the channel.

4. **NPU side (if on Orange Pi)**
   ```bash
   ./host-setup/check-npu.sh
   ```

## Manual Bot Creation (if auto-create didn't trigger)

Use the web UI at http://localhost:3000 (complete first-run admin setup if prompted), then go to Settings → Bots → Add new bot with your TS6 details.

## Acceptance Criteria

- Bot successfully connects to a real TS6 server (visible in channel).
- Can play at least one track from LocalProvider **or** YouTube provider end-to-end.
- No crashes on connection or playback.
- Basic commands (`!play`, `!skip`, `!pause`) work.

Once this is solid, Phase 1a (polishing Local library experience + UI) becomes the next focus.
