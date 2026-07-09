import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { PCM_FRAME_BYTES } from "./encoder.js";
import { AudioPlayer, buildFfmpegArgs, cleanupTempDir } from "./player.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function getHeadersArg(args: string[]): string {
  const idx = args.indexOf("-headers");
  if (idx === -1) return "";
  return args[idx + 1] ?? "";
}

describe("buildFfmpegArgs", () => {
  it("does not set custom headers for unknown URLs", () => {
    const url = "https://example.com/song.mp3";
    const args = buildFfmpegArgs(url, 0);
    expect(args).not.toContain("-headers");
  });

  it("includes resilient reconnect flags for all URLs", () => {
    const args = buildFfmpegArgs("https://example.com/song.mp3", 0);
    expect(args).toContain("-reconnect");
    expect(args).toContain("-reconnect_streamed");
    expect(args).toContain("-reconnect_delay_max");
    expect(args).toContain("-reconnect_on_network_error");
    expect(args).toContain("-reconnect_on_http_error");
    const idx = args.indexOf("-reconnect_delay_max");
    expect(Number(args[idx + 1])).toBeGreaterThanOrEqual(30);
  });

  it("inserts -ss before -i when seekSeconds > 0", () => {
    const args = buildFfmpegArgs("https://example.com/song.mp3", 42);
    const ssIdx = args.indexOf("-ss");
    const iIdx = args.indexOf("-i");
    expect(ssIdx).toBeGreaterThan(-1);
    expect(args[ssIdx + 1]).toBe("42");
    expect(ssIdx).toBeLessThan(iIdx);
  });

  it("does not insert -ss when seekSeconds is 0", () => {
    const args = buildFfmpegArgs("https://example.com/song.mp3", 0);
    expect(args).not.toContain("-ss");
  });

  it("omits HTTP-only flags when input is a local file path", () => {
    const args = buildFfmpegArgs("C:/temp/song.mp3", 0);
    expect(args).not.toContain("-reconnect");
    expect(args).not.toContain("-reconnect_on_network_error");
    expect(args).not.toContain("-reconnect_on_http_error");
    expect(args).not.toContain("-headers");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("C:/temp/song.mp3");
  });

  it("ends args with the input URL and PCM output spec", () => {
    const url = "https://example.com/song.mp3";
    const args = buildFfmpegArgs(url, 0);
    const iIdx = args.indexOf("-i");
    expect(args[iIdx + 1]).toBe(url);
    expect(args).toContain("-f");
    expect(args).toContain("s16le");
    expect(args[args.length - 1]).toBe("-");
  });

  it("inserts -af after -i when audioFilter is set", () => {
    const af = "highpass=f=200,lowpass=f=4500";
    const args = buildFfmpegArgs("https://example.com/x.mp3", 0, { audioFilter: af });
    const iIdx = args.indexOf("-i");
    const afIdx = args.indexOf("-af");
    expect(afIdx).toBeGreaterThan(iIdx);
    expect(args[afIdx + 1]).toBe(af);
    expect(args).toContain("s16le");
  });

  it("omits -af when filter is empty", () => {
    expect(buildFfmpegArgs("/tmp/a.mp3", 0, { audioFilter: "  " })).not.toContain("-af");
    expect(buildFfmpegArgs("/tmp/a.mp3", 0)).not.toContain("-af");
  });
});

describe("AudioPlayer music audio filter", () => {
  it("stores filter and applies only when not speech-floored", () => {
    const player = new AudioPlayer(silentLogger);
    player.setMusicAudioFilter("highpass=f=200,lowpass=f=4500");
    expect(player.getMusicAudioFilter()).toContain("highpass");
    player.setMusicAudioFilter(null);
    expect(player.getMusicAudioFilter()).toBeNull();
  });
});

describe("AudioPlayer STT duck", () => {
  it("attenuates without changing the volume slider", () => {
    const player = new AudioPlayer(silentLogger);
    player.setVolume(40);
    (player as unknown as { state: string }).state = "playing";

    expect(player.duckForStt(2)).toBe(true);
    expect(player.getVolume()).toBe(40);
    expect(player.isSttDucked()).toBe(true);
    // Idempotent re-apply updates duck level without touching the slider.
    expect(player.duckForStt(2)).toBe(true);
    expect(player.getVolume()).toBe(40);

    expect(player.restoreFromSttDuck()).toBe(true);
    expect(player.getVolume()).toBe(40);
    expect(player.isSttDucked()).toBe(false);
  });

  it("does not duck when idle", () => {
    const player = new AudioPlayer(silentLogger);
    player.setVolume(30);
    expect(player.duckForStt(5)).toBe(false);
    expect(player.isSttDucked()).toBe(false);
  });

  it("clears duck state on stop", () => {
    const player = new AudioPlayer(silentLogger);
    (player as unknown as { state: string }).state = "playing";
    player.duckForStt(5);
    player.stop();
    expect(player.isSttDucked()).toBe(false);
  });
});

describe("cleanupTempDir", () => {
  it("removes a directory and its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsbot-test-"));
    writeFileSync(join(dir, "song.mp3"), "fake-bytes");
    expect(existsSync(dir)).toBe(true);
    cleanupTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("does not throw when directory does not exist", () => {
    const missing = join(tmpdir(), "tsbot-test-does-not-exist-xyz");
    expect(() => cleanupTempDir(missing)).not.toThrow();
  });

  it("does not throw when called twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsbot-test-"));
    cleanupTempDir(dir);
    expect(() => cleanupTempDir(dir)).not.toThrow();
  });
});

describe("AudioPlayer per-play volume floor (radio speech)", () => {
  const pcm = () => {
    const b = Buffer.alloc(8);
    for (let i = 0; i < 4; i++) b.writeInt16LE(10000, i * 2);
    return b;
  };
  const apply = (p: AudioPlayer, buf: Buffer) =>
    (p as unknown as { applyVolume(b: Buffer): Buffer }).applyVolume(buf);
  const setFloor = (p: AudioPlayer, v: number | null) =>
    ((p as unknown as { playVolumeFloor: number | null }).playVolumeFloor = v);

  it("speech floor lifts output above a low music slider", () => {
    const player = new AudioPlayer(silentLogger);
    player.setVolume(30);
    const quiet = apply(player, pcm()).readInt16LE(0); // 30 → factor 0.06
    setFloor(player, 85);
    const loud = apply(player, pcm()).readInt16LE(0); // max(30,85) → factor 0.17
    expect(loud).toBeGreaterThan(quiet * 2);
  });

  it("floor never lowers a higher slider, and stop() clears it", () => {
    const player = new AudioPlayer(silentLogger);
    player.setVolume(90);
    const before = apply(player, pcm()).readInt16LE(0);
    setFloor(player, 85);
    expect(apply(player, pcm()).readInt16LE(0)).toBe(before); // max(90,85)=90
    player.stop();
    expect((player as unknown as { playVolumeFloor: number | null }).playVolumeFloor).toBeNull();
  });
});

describe("speech floor vs STT courtesy duck", () => {
  it("a floored playback (radio speech) is not buried by the speech duck", () => {
    const player = new AudioPlayer(silentLogger);
    player.setVolume(30);
    (player as unknown as { state: string }).state = "playing";
    player.duckForStt(2); // someone is talking in channel → duck to 2

    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(10000, 0);
    const apply = (b: Buffer) =>
      (player as unknown as { applyVolume(x: Buffer): Buffer }).applyVolume(b);

    const ducked = apply(pcm).readInt16LE(0); // music under duck: factor 0.004
    (player as unknown as { playVolumeFloor: number | null }).playVolumeFloor = 85;
    const bumper = apply(pcm).readInt16LE(0); // bumper: floor beats duck
    expect(bumper).toBeGreaterThan(ducked * 10);
  });
});

describe("AudioPlayer Icecast tee PCM emit (R-R6)", () => {
  it("sendNextFrame emits volume-adjusted pcm then frame (real encode path)", () => {
    const player = new AudioPlayer(silentLogger);
    player.setVolume(50);
    const onPcm = vi.fn();
    const onFrame = vi.fn();
    player.on("pcm", onPcm);
    player.on("frame", onFrame);

    // Stuff one Opus-period of s16le PCM into the internal buffer and drain.
    const raw = Buffer.alloc(PCM_FRAME_BYTES);
    raw.writeInt16LE(10000, 0);
    const internal = player as unknown as {
      pcmChunks: Buffer[];
      pcmBuffered: number;
      sendNextFrame: () => void;
    };
    internal.pcmChunks = [raw];
    internal.pcmBuffered = PCM_FRAME_BYTES;
    internal.sendNextFrame();

    expect(onPcm).toHaveBeenCalledOnce();
    const pcmOut = onPcm.mock.calls[0]![0] as Buffer;
    expect(pcmOut).toBeInstanceOf(Buffer);
    expect(pcmOut.length).toBe(PCM_FRAME_BYTES);
    // Volume 50 → factor 0.1; first sample attenuated from 10000
    expect(Math.abs(pcmOut.readInt16LE(0))).toBeLessThan(10000);
    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame.mock.calls[0]![0]).toBeInstanceOf(Buffer);
  });
});
