import { describe, it, expect } from "vitest";
import { isPublicPlaybackUrl } from "./url-guard.js";

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

  it("blocks docker-compose sidecar hostnames", () => {
    expect(isPublicPlaybackUrl("http://qdrant:6333/collections")).toBe(false);
    expect(isPublicPlaybackUrl("http://ollama:11434/api/tags")).toBe(false);
  });

  it("rejects non-http schemes and garbage", () => {
    expect(isPublicPlaybackUrl("ftp://example.com/x")).toBe(false);
    expect(isPublicPlaybackUrl("not a url")).toBe(false);
  });
});