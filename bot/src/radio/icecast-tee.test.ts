import { describe, expect, it, vi } from "vitest";
import {
  buildIcecastFfmpegArgs,
  defaultIcecastTeeConfig,
  IcecastTee,
  isIcecastTeeReady,
  resolveIcecastTee,
} from "./icecast-tee.js";

describe("resolveIcecastTee / isIcecastTeeReady", () => {
  it("defaults off with empty mount", () => {
    const d = defaultIcecastTeeConfig();
    expect(d.enabled).toBe(false);
    expect(isIcecastTeeReady(d)).toBe(false);
  });

  it("ready only when enabled + valid mountUrl", () => {
    expect(
      isIcecastTeeReady(
        resolveIcecastTee({ enabled: true, mountUrl: "icecast://source:pw@127.0.0.1:8000/live" }),
      ),
    ).toBe(true);
    expect(
      isIcecastTeeReady(
        resolveIcecastTee({ enabled: true, mountUrl: "http://icecast.local:8000/live" }),
      ),
    ).toBe(true);
    expect(isIcecastTeeReady(resolveIcecastTee({ enabled: true, mountUrl: "" }))).toBe(false);
    expect(
      isIcecastTeeReady(
        resolveIcecastTee({ enabled: false, mountUrl: "icecast://source:pw@127.0.0.1:8000/live" }),
      ),
    ).toBe(false);
    expect(isIcecastTeeReady(resolveIcecastTee({ enabled: true, mountUrl: "not a url" }))).toBe(
      false,
    );
  });
});

describe("buildIcecastFfmpegArgs", () => {
  it("builds stdin s16le → mp3 → icecast:// argv", () => {
    const args = buildIcecastFfmpegArgs({
      enabled: true,
      mountUrl: "icecast://source:hackme@127.0.0.1:8000/live",
      format: "mp3",
      sampleRate: 48000,
      channels: 2,
    });
    expect(args).toContain("pipe:0");
    expect(args).toContain("s16le");
    expect(args).toContain("libmp3lame");
    expect(args[args.length - 1]).toBe("icecast://source:hackme@127.0.0.1:8000/live");
  });

  it("throws when not ready", () => {
    expect(() => buildIcecastFfmpegArgs(defaultIcecastTeeConfig())).toThrow(/not ready/i);
  });
});

describe("IcecastTee lifecycle", () => {
  it("does not spawn when disabled", () => {
    const spawn = vi.fn();
    const tee = new IcecastTee({ spawn });
    const r = tee.apply({ enabled: false, mountUrl: "icecast://s:p@h/m" });
    expect(r.running).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(tee.status().enabled).toBe(false);
  });

  it("spawns ffmpeg with real argv when enabled", () => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const stdin = { write: vi.fn(() => true), end: vi.fn() };
    const proc = {
      stdin,
      killed: false,
      kill: vi.fn(),
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        handlers[ev] = cb;
      },
    };
    const spawn = vi.fn(() => proc);
    const tee = new IcecastTee({ spawn });
    const r = tee.apply({
      enabled: true,
      mountUrl: "icecast://source:x@127.0.0.1:8000/live",
      format: "mp3",
    });
    expect(r.running).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    const call = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(call[0]).toBe("ffmpeg");
    expect(call[1]).toEqual(expect.arrayContaining(["-f", "s16le", "-i", "pipe:0", "libmp3lame"]));
    expect(tee.isRunning()).toBe(true);

    const pcm = Buffer.alloc(480);
    tee.writePcm(pcm);
    expect(stdin.write).toHaveBeenCalledWith(pcm);

    tee.stop();
    expect(proc.kill).toHaveBeenCalled();
    expect(tee.isRunning()).toBe(false);
  });

  it("status redacts password in mountUrl", () => {
    const tee = new IcecastTee();
    tee.apply({
      enabled: true,
      mountUrl: "icecast://source:secret@host:8000/m",
    });
    // no spawn → not running, but status still redacts
    expect(tee.status().mountUrl).toMatch(/\*\*\*/);
    expect(tee.status().mountUrl).not.toContain("secret");
  });
});
