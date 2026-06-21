import type { Logger } from "../../logger.js";
import { DEFAULT_DEMO_VIDEO_ID, DEFAULT_DEMO_VIDEO_URL } from "../../music/youtube.js";
import type { ParsedCommand } from "../commands.js";

export interface Phase0ConnectDeps {
  logger: Logger;
  executeCommand: (cmd: ParsedCommand) => Promise<string | null>;
}

/**
 * Phase 0 validation auto-play: fires once after connect when TS6_* / TS_HOST /
 * PHASE0_TEST_PLAY env vars indicate a test/validation context.
 */
export function schedulePhase0AutoPlay(deps: Phase0ConnectDeps): void {
  const envTrack = process.env.PHASE0_TEST_PLAY;
  const isPhase0 = !!envTrack || !!process.env.TS6_HOST || !!process.env.TS_HOST;
  const testTrack = envTrack != null && envTrack.trim() !== "" ? envTrack : DEFAULT_DEMO_VIDEO_URL;

  if (!isPhase0) return;

  deps.logger.info("═══════════════════════════════════════════════════════════════");
  deps.logger.info("PHASE 0: Bot successfully connected to TeamSpeak server!");
  deps.logger.info(`PHASE 0: Will auto-attempt playback of: ${testTrack} (default unit test / startup track)`);
  deps.logger.info("═══════════════════════════════════════════════════════════════");

  setTimeout(async () => {
    deps.logger.info({ track: testTrack }, "Phase 0: Attempting automatic test playback");
    try {
      const isDefaultDemo =
        testTrack === DEFAULT_DEMO_VIDEO_URL || testTrack === DEFAULT_DEMO_VIDEO_ID;
      const flags = new Set<string>();
      if (!testTrack.startsWith("http")) flags.add("l");
      const result = await deps.executeCommand(
        isDefaultDemo
          ? { name: "test", args: "", rawArgs: [], flags: new Set<string>() }
          : { name: "play", args: testTrack, rawArgs: [testTrack], flags },
      );
      deps.logger.info({ track: testTrack, result }, "Phase 0: Test playback command executed");

      if (typeof result === "string" && result.toLowerCase().includes("now playing")) {
        deps.logger.info("═══════════════════════════════════════════════════════════════");
        deps.logger.info("PHASE 0 SUCCESS: Bot connected and test audio playback initiated!");
        deps.logger.info(`Test track: ${testTrack}`);
        deps.logger.info("Check your TeamSpeak channel — you should hear audio now.");
        deps.logger.info("═══════════════════════════════════════════════════════════════");
      } else {
        deps.logger.warn({ result }, "Phase 0 auto-play did not report success");
        deps.logger.error("═══════════════════════════════════════════════════════════════");
        deps.logger.error("PHASE 0 FAILURE: Connected but test playback did not start.");
        deps.logger.error(`Test track: ${testTrack}`);
        deps.logger.error(typeof result === "string" ? `Command result: ${result}` : "Command returned no success message.");
        deps.logger.error("Check MUSIC_DIR, network access (YouTube), and TS channel permissions.");
        deps.logger.error("═══════════════════════════════════════════════════════════════");
      }
    } catch (e) {
      deps.logger.error({ err: e, track: testTrack }, "Phase 0: Test playback failed");
      deps.logger.error("═══════════════════════════════════════════════════════════════");
      deps.logger.error("PHASE 0 FAILURE: Test playback threw an error.");
      deps.logger.error(`Test track: ${testTrack}`);
      deps.logger.error("═══════════════════════════════════════════════════════════════");
    }
  }, 4000);
}