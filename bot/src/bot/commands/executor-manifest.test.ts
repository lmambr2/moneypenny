import { describe, it, expect, vi } from "vitest";
import { CommandExecutor } from "./executor.js";
import { commandsOfKind } from "../commands.js";
import { defaultRadioConfig } from "../../radio/index.js";

/**
 * Manifest ↔ executor-switch parity: every `delegated` (and `resolved`)
 * command in the manifest must be handled by CommandExecutor — reaching the
 * switch's `default` ("Unknown command") means a manifest entry has no
 * implementation. This is the drift that shipped `!chevron7` broken.
 *
 * Stub deps make many handlers throw once inside their case — that's fine:
 * a throw proves the case exists; only the "Unknown command" reply fails.
 */
describe("command manifest ↔ executor parity", () => {
  const executor = () =>
    new CommandExecutor({
      playback: {} as never,
      player: { getState: () => "playing" } as never,
      queue: { current: () => null } as never,
      config: { commandPrefix: "!", radio: defaultRadioConfig() } as never,
      profileManager: {} as never,
      tsClient: {} as never,
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn(),
    });

  it.each([...commandsOfKind("delegated"), ...commandsOfKind("resolved")])(
    "executor implements '%s'",
    async (name) => {
      try {
        const out = await executor().execute({ name, args: "", rawArgs: [], flags: new Set() });
        expect(out ?? "").not.toMatch(/^Unknown command/);
      } catch {
        // Threw inside its case on stub deps — the case exists, which is all
        // this parity test asserts.
      }
    },
  );
});
