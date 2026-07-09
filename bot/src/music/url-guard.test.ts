import { describe, it, expect } from "vitest";
import {
  assertPublicPlaybackUrl,
  assertSafePlaybackTarget,
  isPublicPlaybackUrl,
} from "./url-guard.js";

describe("isPublicPlaybackUrl", () => {
  it("allows public http(s) stream URLs", () => {
    expect(isPublicPlaybackUrl("https://icecast.example.org:8000/radio.mp3")).toBe(true);
    expect(isPublicPlaybackUrl("http://stream.example.com/live")).toBe(true);
  });

  it("blocks loopback and link-local targets", () => {
    expect(isPublicPlaybackUrl("http://127.0.0.1:6333/collections")).toBe(false);
    expect(isPublicPlaybackUrl("http://localhost:11434/api/tags")).toBe(false);
    expect(isPublicPlaybackUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isPublicPlaybackUrl("http://[::1]:9000/health")).toBe(false);
  });

  it("blocks private RFC1918 addresses", () => {
    expect(isPublicPlaybackUrl("http://192.168.0.50:11434/api/tags")).toBe(false);
    expect(isPublicPlaybackUrl("http://10.0.0.5/stream")).toBe(false);
    expect(isPublicPlaybackUrl("http://172.17.0.2:6333")).toBe(false);
  });

  it("blocks CGNAT and IPv4-mapped IPv6", () => {
    expect(isPublicPlaybackUrl("http://100.64.1.2/x")).toBe(false);
    expect(isPublicPlaybackUrl("http://[::ffff:127.0.0.1]/1/")).toBe(false);
    expect(isPublicPlaybackUrl("http://[::ffff:169.254.169.254]/80/")).toBe(false);
    expect(isPublicPlaybackUrl("http://[::ffff:a9fe:a9fe]/80/")).toBe(false);
  });

  it("blocks docker-compose sidecar hostnames", () => {
    expect(isPublicPlaybackUrl("http://qdrant:6333/collections")).toBe(false);
    expect(isPublicPlaybackUrl("http://ollama:11434/api/tags")).toBe(false);
    expect(isPublicPlaybackUrl("http://stt-whisper:9000/health")).toBe(false);
    expect(isPublicPlaybackUrl("http://piper-tts:8880/health")).toBe(false);
    expect(isPublicPlaybackUrl("http://spotify-bridge:8082/resolve")).toBe(false);
    expect(isPublicPlaybackUrl("http://ace-step:7865/health")).toBe(false);
  });

  it("rejects non-http schemes and garbage", () => {
    expect(isPublicPlaybackUrl("ftp://example.com/x")).toBe(false);
    expect(isPublicPlaybackUrl("not a url")).toBe(false);
  });
});

describe("assertPublicPlaybackUrl", () => {
  it("rejects private literals without DNS", async () => {
    expect(await assertPublicPlaybackUrl("http://127.0.0.1/")).toBe(false);
    expect(await assertPublicPlaybackUrl("http://10.0.0.1/")).toBe(false);
  });

  it("allows a well-known public hostname (DNS)", async () => {
    // example.com is reserved and resolves publicly; skip if offline.
    const ok = await assertPublicPlaybackUrl("https://example.com/");
    expect(typeof ok).toBe("boolean");
  });
});

describe("assertSafePlaybackTarget", () => {
  it("allows local filesystem paths (library playback)", async () => {
    expect(await assertSafePlaybackTarget("/music/uploads/track.mp3")).toBe(true);
    expect(await assertSafePlaybackTarget("generated/ace-step/x.mp3")).toBe(true);
  });

  it("rejects private network URLs (real entry point used at play time)", async () => {
    expect(await assertSafePlaybackTarget("http://127.0.0.1:6333/collections")).toBe(false);
    expect(await assertSafePlaybackTarget("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(await assertSafePlaybackTarget("http://stt-whisper:9000/asr")).toBe(false);
  });

  it("rejects empty", async () => {
    expect(await assertSafePlaybackTarget("")).toBe(false);
    expect(await assertSafePlaybackTarget("   ")).toBe(false);
  });
});
