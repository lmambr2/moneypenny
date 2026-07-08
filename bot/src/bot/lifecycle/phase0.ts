import type { Logger } from "../../logger.js";
import { DEFAULT_DEMO_VIDEO_ID, DEFAULT_DEMO_VIDEO_URL } from "../../music/youtube.js";
import type { ParsedCommand } from "../commands.js";

export interface Phase0ConnectDeps {
  logger: Logger;
  executeCommand: (cmd: ParsedCommand) => Promise<string | null>;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Post-connect auto-play:
 *   PHASE0_AUTO_TEST=1  — run !test (local copy first, else demo YouTube URL)
 *   PHASE0_TEST_PLAY=…  — validation override (explicit URL or path; phase0-validate.sh)
 *
 * TS6_HOST alone must NOT trigger playback (production reconnects).
 */
export function schedulePhase0AutoPlay(deps: Phase0ConnectDeps): void {
  const envTrack = process.env.PHASE0_TEST_PLAY?.trim();
  const autoTest = isTruthyEnv(process.env.PHASE0_AUTO_TEST);
  if (!envTrack && !autoTest) return;

  const validationMode = !!envTrack;
  const testTrack = envTrack ?? DEFAULT_DEMO_VIDEO_URL;

  deps.logger.info("═══════════════════════════════════════════════════════════════");
  deps.logger.info(
    validationMode
      ? "PHASE 0: Bot successfully connected to TeamSpeak server!"
      : "Startup: auto !test enabled (PHASE0_AUTO_TEST)",
  );
  deps.logger.info(
    validationMode
      ? `PHASE 0: Will auto-attempt playback of: ${testTrack} (default unit test / startup track)`
      : "Startup: will run !test after connect (local library hit preferred)",
  );
  deps.logger.info("═══════════════════════════════════════════════════════════════");

  setTimeout(async () => {
    deps.logger.info(
      { track: validationMode ? testTrack : "!test", autoTest, validationMode },
      validationMode ? "Phase 0: Attempting automatic test playback" : "Startup: running auto !test",
    );
    try {
      const isDefaultDemo =
        !validationMode ||
        testTrack === DEFAULT_DEMO_VIDEO_URL ||
        testTrack === DEFAULT_DEMO_VIDEO_ID;
      const flags = new Set<string>();
      if (validationMode && !testTrack.startsWith("http")) flags.add("l");
      const result = await deps.executeCommand(
        isDefaultDemo
          ? { name: "test", args: "", rawArgs: [], flags: new Set<string>() }
          : { name: "play", args: testTrack, rawArgs: [testTrack], flags },
      );
      deps.logger.info({ track: testTrack, result }, "Startup auto-play command finished");

      if (typeof result === "string" && result.toLowerCase().includes("now playing")) {
        deps.logger.info("═══════════════════════════════════════════════════════════════");
        deps.logger.info(
          validationMode
            ? "PHASE 0 SUCCESS: Bot connected and test audio playback initiated!"
            : "Startup: auto !test playback started",
        );
        deps.logger.info(`Test track: ${validationMode ? testTrack : "!test"}`);
        deps.logger.info("Check your TeamSpeak channel — you should hear audio now.");
        deps.logger.info("═══════════════════════════════════════════════════════════════");
      } else {
        deps.logger.warn({ result }, "Startup auto-play did not report success");
        deps.logger.error("═══════════════════════════════════════════════════════════════");
        deps.logger.error(
          validationMode
            ? "PHASE 0 FAILURE: Connected but test playback did not start."
            : "Startup: auto !test did not start playback.",
        );
        deps.logger.error(`Test track: ${validationMode ? testTrack : "!test"}`);
        deps.logger.error(typeof result === "string" ? `Command result: ${result}` : "Command returned no success message.");
        deps.logger.error("Check MUSIC_DIR, network access (YouTube), and TS channel permissions.");
        deps.logger.error("═══════════════════════════════════════════════════════════════");
      }
    } catch (e) {
      deps.logger.error({ err: e, track: testTrack }, "Startup auto-play failed");
      deps.logger.error("═══════════════════════════════════════════════════════════════");
      deps.logger.error(
        validationMode ? "PHASE 0 FAILURE: Test playback threw an error." : "Startup: auto !test threw an error.",
      );
      deps.logger.error(`Test track: ${validationMode ? testTrack : "!test"}`);
      deps.logger.error("═══════════════════════════════════════════════════════════════");
    }
  }, 4000);
}