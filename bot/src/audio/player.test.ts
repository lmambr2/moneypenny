import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFfmpegArgs, shouldUsePowerShellDownload, cleanupTempDir } from "./player.js";

function getHeadersArg(args: string[]): string {
  const idx = args.indexOf("-headers");
  if (idx === -1) return "";
  return args[idx + 1] ?? "";
}

describe("buildFfmpegArgs", () => {
  it("includes browser User-Agent and Referer for Netease CDN URLs", () => {
    const url = "http://m701.music.126.net/some/path/song.mp3?vuutv=abc";
    const args = buildFfmpegArgs(url, 0);
    const headers = getHeadersArg(args);
    expect(headers).toContain("User-Agent:");
    expect(headers).toContain("Mozilla/5.0");
    expect(headers).toContain("Referer: https://music.163.com/");
  });

  it("keeps Bilibili Referer + UA for bilibili URLs", () => {
    const url = "https://upos-sz-mirrorcoso1.bilivideo.com/foo/bar.mp3";
    const args = buildFfmpegArgs(url, 0);
    const headers = getHeadersArg(args);
    expect(headers).toContain("Referer: https://www.bilibili.com");
    expect(headers).toContain("User-Agent: Mozilla/5.0");
  });

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
});

describe("shouldUsePowerShellDownload", () => {
  const jdymusicUrl =
    "http://m801.music.126.net/20260507/abc/jdymusic/obj/xyz/song.mp3?vuutv=tok";
  const newCdnUrl =
    "http://m801.music.126.net/20260507/abc/jd-musicrep-ts/obj/xyz/song.mp3?vuutv=tok";
  const ymusicUrl =
    "http://m801.music.126.net/20260507/abc/ymusic/obj/xyz/song.mp3?vuutv=tok";

  it("returns true for /jdymusic/ URL on win32", () => {
    expect(shouldUsePowerShellDownload(jdymusicUrl, "win32")).toBe(true);
  });

  it("returns false for /jdymusic/ URL on linux", () => {
    expect(shouldUsePowerShellDownload(jdymusicUrl, "linux")).toBe(false);
  });

  it("returns false for /jdymusic/ URL on darwin", () => {
    expect(shouldUsePowerShellDownload(jdymusicUrl, "darwin")).toBe(false);
  });

  it("returns false for new-format /jd-musicrep-ts/ URL on win32", () => {
    expect(shouldUsePowerShellDownload(newCdnUrl, "win32")).toBe(false);
  });

  it("returns false for /ymusic/ URL on win32", () => {
    expect(shouldUsePowerShellDownload(ymusicUrl, "win32")).toBe(false);
  });

  it("returns false for unrelated URLs", () => {
    expect(shouldUsePowerShellDownload("https://example.com/x.mp3", "win32")).toBe(false);
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
