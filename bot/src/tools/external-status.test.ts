import { describe, expect, it, vi } from "vitest";
import {
  createHostHealthPlugin,
  createStarCitizenOrgStatusPlugin,
  ExternalStatusRegistry,
} from "./external-status.js";

describe("ExternalStatusRegistry (G2)", () => {
  it("returns success text from a plugin", async () => {
    const reg = new ExternalStatusRegistry({ cacheTtlMs: 0 });
    reg.register({
      id: "demo",
      label: "Demo",
      fetch: async () => "all green",
    });
    const r = await reg.get("demo");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("all green");
    expect(r.cached).toBe(false);
  });

  it("fail-open on throw without crashing", async () => {
    const reg = new ExternalStatusRegistry();
    reg.register({
      id: "boom",
      label: "Boom",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const r = await reg.get("boom");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/unavailable/i);
    expect(r.text).toMatch(/ECONNREFUSED/);
    expect(r.text).toMatch(/unaffected/i);
  });

  it("fail-open on timeout", async () => {
    const reg = new ExternalStatusRegistry({ timeoutMs: 30 });
    reg.register({
      id: "slow",
      label: "Slow",
      fetch: () => new Promise((r) => setTimeout(() => r("late"), 500)),
    });
    const r = await reg.get("slow");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/timeout/i);
  });

  it("caches successful results", async () => {
    const fetch = vi.fn(async () => "v1");
    let now = 1000;
    const reg = new ExternalStatusRegistry({
      cacheTtlMs: 10_000,
      now: () => now,
    });
    reg.register({ id: "c", label: "C", fetch });
    expect((await reg.get("c")).cached).toBe(false);
    now = 2000;
    expect((await reg.get("c")).cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("SC plugin fail-open when URL unset", async () => {
    const reg = new ExternalStatusRegistry();
    reg.register(createStarCitizenOrgStatusPlugin({ baseUrl: "" }));
    const r = await reg.get("sc-org");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not configured|unavailable/i);
  });

  it("host health plugin returns text", async () => {
    const reg = new ExternalStatusRegistry();
    reg.register(createHostHealthPlugin({ getSummary: async () => "pi ok" }));
    const r = await reg.get("host");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("pi ok");
  });
});
