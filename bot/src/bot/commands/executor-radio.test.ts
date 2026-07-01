import { describe, it, expect, vi } from "vitest";
import { CommandExecutor } from "./executor.js";
import { defaultRadioConfig, type RadioConfig } from "../../radio/index.js";

function executor(radio: RadioConfig = defaultRadioConfig()) {
  const config = { commandPrefix: "!", radio } as never;
  const ex = new CommandExecutor({
    playback: {} as never,
    player: {} as never,
    queue: {} as never,
    config,
    profileManager: {} as never,
    tsClient: {} as never,
    isConnected: () => true,
    playNext: vi.fn(),
    getProvider: vi.fn(),
  });
  return { ex, radio };
}

const run = (ex: CommandExecutor, args: string[]) =>
  ex.execute({ name: "radio", args: args.join(" "), rawArgs: args, flags: new Set() });

describe("cmdRadio", () => {
  it("on enables radio and reports the cadence", async () => {
    const { ex, radio } = executor();
    const out = await run(ex, ["on"]);
    expect(radio.enabled).toBe(true);
    expect(out).toMatch(/ON/);
    expect(out).toContain("every 4 songs");
  });

  it("off disables radio", async () => {
    const r = defaultRadioConfig();
    r.enabled = true;
    const { ex, radio } = executor(r);
    const out = await run(ex, ["off"]);
    expect(radio.enabled).toBe(false);
    expect(out).toMatch(/OFF/);
  });

  it("bare !radio reports status (off, with a hint)", async () => {
    const out = await run(executor().ex, []);
    expect(out).toMatch(/OFF/);
    expect(out).toContain("!radio on");
  });

  it("reports clock-only when everyNSongs is 0", async () => {
    const r = defaultRadioConfig();
    r.everyNSongs = 0;
    const out = await run(executor(r).ex, ["on"]);
    expect(out).toContain("Clock-only");
  });

  it("shows usage for an unknown subcommand", async () => {
    const out = await run(executor().ex, ["frobnicate"]);
    expect(out).toContain("Usage:");
  });
});
