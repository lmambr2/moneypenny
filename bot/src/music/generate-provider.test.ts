import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GenerateProvider } from "./generate-provider.js";
import type { AceStepClient } from "./ace-step-client.js";
import type { LocalProvider } from "./local.js";
import type { Song } from "./provider.js";

describe("GenerateProvider", () => {
  let tmp: string;
  let musicDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ace-gen-"));
    musicDir = path.join(tmp, "music");
    await fs.mkdir(musicDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function harness(overrides: {
    client?: Partial<AceStepClient>;
    resolveSong?: Song | null;
    enabled?: boolean;
  } = {}) {
    const song: Song = {
      id: "song1",
      name: "Generated Track",
      artist: "ACE-Step",
      album: "generated",
      duration: 120,
      coverUrl: "",
      platform: "local",
    };
    const local = {
      getMusicDir: () => musicDir,
      refresh: vi.fn(async () => 1),
      resolve: vi.fn(async () =>
        overrides.resolveSong === null
          ? null
          : { type: "song" as const, item: overrides.resolveSong ?? song },
      ),
    } as unknown as LocalProvider;

    const client = {
      isAvailable: vi.fn(async () => true),
      generate: vi.fn(async () => ({ id: "j1", status: "queued" as const })),
      waitForJob: vi.fn(async () => ({
        id: "j1",
        status: "done" as const,
        path: null,
        error: null,
      })),
      downloadAudio: vi.fn(async () => Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00])),
      ...overrides.client,
    } as unknown as AceStepClient;

    const provider = new GenerateProvider({
      getConfig: () =>
        ({
          aceStepEnabled: overrides.enabled !== false,
          aceStepUrl: "http://192.168.1.89:7865",
          aceStepTimeoutMs: 60_000,
          aceStepOutputDir: "generated/ace-step",
        }) as any,
      getClient: () => client,
      localProvider: local,
      logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
    });

    return { provider, client, local, song };
  }

  it("handleGenerate requires a prompt", async () => {
    const { provider } = harness();
    expect(await provider.handleGenerate("")).toMatch(/Usage/);
  });

  it("handleGenerate when disabled", async () => {
    const { provider } = harness({ enabled: false });
    expect(await provider.handleGenerate("focus")).toMatch(/off/i);
  });

  it("downloads audio, writes under output dir, returns song", async () => {
    const { provider, client, local, song } = harness();
    const result = await provider.generateAndIngest("late night focus ambient");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.song.id).toBe(song.id);
    expect(client.downloadAudio).toHaveBeenCalledWith("j1");
    expect(local.refresh).toHaveBeenCalled();
    const written = await fs.readdir(path.join(musicDir, "generated/ace-step"));
    expect(written.some((f) => f.endsWith(".mp3"))).toBe(true);
  });

  it("uses shared path when job.path is under music dir", async () => {
    const shared = path.join(musicDir, "generated/ace-step", "shared.mp3");
    await fs.mkdir(path.dirname(shared), { recursive: true });
    await fs.writeFile(shared, Buffer.from("x"));
    const { provider, client } = harness({
      client: {
        waitForJob: vi.fn(async () => ({
          id: "j1",
          status: "done" as const,
          path: "generated/ace-step/shared.mp3",
          error: null,
        })),
      },
    });
    const result = await provider.generateAndIngest("x");
    expect(result.ok).toBe(true);
    expect(client.downloadAudio).not.toHaveBeenCalled();
  });

  it("rate limits per invoker", async () => {
    const { provider } = harness();
    // Force fast success
    for (let i = 0; i < 3; i++) {
      const r = await provider.handleGenerate("prompt " + i, "user-a");
      expect(r).toMatch(/Generated|queued|failed|indexed/i);
    }
    const limited = await provider.handleGenerate("prompt 4", "user-a");
    expect(limited).toMatch(/rate limit/i);
  });
});
