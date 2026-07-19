import { describe, expect, it, vi } from "vitest";
import type { RadioProfile } from "../../radio/types.js";
import type { CommandExecutorDeps } from "./executor.js";
import { buildRadioGenPrompt, RadioCommands } from "./radio-commands.js";

describe("buildRadioGenPrompt", () => {
  it("includes profile tone topics and seeds", () => {
    const profile: RadioProfile = {
      name: "focus",
      bumper: { topics: ["deep work"], tone: "calm announcer" },
      music: { seedQueries: ["ambient", "lofi"], select: { mood: ["calm"] } },
    };
    const p = buildRadioGenPrompt(profile, "focus");
    expect(p).toMatch(/calm announcer/i);
    expect(p).toMatch(/deep work/);
    expect(p).toMatch(/ambient/);
    expect(p).toMatch(/mood: calm/);
  });

  it("falls back when profile empty", () => {
    const p = buildRadioGenPrompt(undefined, "lobby");
    expect(p).toMatch(/lobby/i);
    expect(p).toMatch(/instrumental/i);
  });
});

describe("RadioCommands autoProgram ACE-Step fill", () => {
  function harness(opts: { autoFill?: boolean; genOk?: boolean; programPool?: boolean }) {
    const song = {
      id: "g1",
      name: "Gen Track",
      artist: "ACE",
      album: "x",
      duration: 60,
      coverUrl: "",
      platform: "local" as const,
    };
    const generateAndIngest = vi.fn(async () =>
      opts.genOk === false
        ? { ok: false as const, error: "down" }
        : { ok: true as const, song, relPath: "generated/ace-step/x.mp3", jobId: "j1" },
    );
    const queue = {
      clear: vi.fn(),
      add: vi.fn(),
      play: vi.fn(() => song),
      playAt: vi.fn(),
      list: vi.fn(() => []),
      current: vi.fn(() => null),
      getCurrentIndex: vi.fn(() => -1),
      size: () => 0,
    };
    const player = { resetFailures: vi.fn(), getState: () => "idle" };
    const playback = {
      resolveAndPlay: vi.fn(async () => true),
      searchFirst: vi.fn(async () =>
        opts.programPool
          ? { song: { ...song, id: "lib1", name: "Lib" }, provider: { platform: "local" } }
          : null,
      ),
    };
    const deps = {
      config: {
        commandPrefix: "!",
        aceStepAutoFill: opts.autoFill !== false,
        aceStepEnabled: true,
        aceStepUrl: "http://x",
        radio: {
          enabled: true,
          activeProfile: "focus",
          profiles: {
            focus: {
              name: "focus",
              music: { seedQueries: opts.programPool ? ["jazz"] : [] },
              bumper: { topics: ["focus"] },
            },
          },
          sources: ["prerecorded"],
          everyNSongs: 4,
        },
      },
      queue,
      player,
      playback,
      getProvider: vi.fn(),
      generateProvider: {
        isConfigured: () => true,
        isBusy: () => false,
        generateAndIngest,
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as CommandExecutorDeps;

    const radio = new RadioCommands(deps, async () => []);
    return { radio, generateAndIngest, queue, playback };
  }

  it("uses ACE-Step when profile pool is empty and autoFill is on", async () => {
    const { radio, generateAndIngest, queue } = harness({ autoFill: true, genOk: true });
    expect(await radio.autoProgram()).toBe(true);
    expect(generateAndIngest).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalled();
  });

  it("does not call ACE-Step when autoFill is off", async () => {
    const { radio, generateAndIngest } = harness({ autoFill: false });
    expect(await radio.autoProgram()).toBe(false);
    expect(generateAndIngest).not.toHaveBeenCalled();
  });

  it("fail-open when generation fails", async () => {
    const { radio, queue } = harness({ autoFill: true, genOk: false });
    expect(await radio.autoProgram()).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
