import { describe, expect, it, vi } from "vitest";
import type { ParsedCommand } from "../commands.js";
import { CommandExecutor, type CommandExecutorDeps } from "./executor.js";

function cmd(name: string, args = ""): ParsedCommand {
  const trimmed = args.trim();
  return {
    name,
    args,
    rawArgs: trimmed ? trimmed.split(/\s+/) : [],
    flags: new Set<string>(),
  };
}

function executor(over: Partial<CommandExecutorDeps> = {}) {
  const setKaraokeMode = vi.fn();
  const config = { commandPrefix: "!", voice: { karaokeMode: false } };
  const exec = new CommandExecutor({
    playback: {} as never,
    player: {} as never,
    queue: {} as never,
    config,
    profileManager: {} as never,
    tsClient: {} as never,
    isConnected: () => true,
    playNext: vi.fn(),
    getProvider: vi.fn(),
    setKaraokeMode,
    ...over,
  } as unknown as CommandExecutorDeps);
  return { exec, setKaraokeMode, config };
}

describe("CommandExecutor !karaoke", () => {
  it("reports off by default", async () => {
    const { exec } = executor();
    await expect(exec.execute(cmd("karaoke"))).resolves.toMatch(/karaoke off/i);
  });

  it("turns karaoke on and off via the live hook", async () => {
    const { exec, setKaraokeMode } = executor();
    await expect(exec.execute(cmd("karaoke", "on"))).resolves.toMatch(/karaoke on/i);
    expect(setKaraokeMode).toHaveBeenCalledWith(true);
    await expect(exec.execute(cmd("karaoke", "off"))).resolves.toMatch(/karaoke off/i);
    expect(setKaraokeMode).toHaveBeenCalledWith(false);
  });

  it("rejects unknown subcommands", async () => {
    const { exec, setKaraokeMode } = executor();
    await expect(exec.execute(cmd("karaoke", "maybe"))).resolves.toMatch(/usage/i);
    expect(setKaraokeMode).not.toHaveBeenCalled();
  });
});
