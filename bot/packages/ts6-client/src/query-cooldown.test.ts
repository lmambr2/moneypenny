import { afterEach, describe, expect, it, vi } from "vitest";
import { isQueryTransientFailure, QueryCooldown } from "./query-cooldown.js";

describe("isQueryTransientFailure", () => {
  it("matches HTTP Query timeouts and auth failures", () => {
    expect(isQueryTransientFailure(new Error("TS6 HTTP Query timeout"))).toBe(true);
    expect(isQueryTransientFailure(new Error("401 unauthorized"))).toBe(true);
    expect(isQueryTransientFailure(new Error("ECONNREFUSED"))).toBe(true);
    expect(isQueryTransientFailure(new Error("empty dir"))).toBe(false);
  });
});

describe("QueryCooldown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays inactive until a matching failure", () => {
    const c = new QueryCooldown(60_000);
    expect(c.active).toBe(false);
    c.noteFailure(new Error("empty dir"));
    expect(c.active).toBe(false);
    c.noteFailure(new Error("TS6 HTTP Query timeout"));
    expect(c.active).toBe(true);
  });

  it("expires after ttl", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const c = new QueryCooldown(5_000);
    c.noteFailure(new Error("timeout"));
    expect(c.active).toBe(true);
    vi.setSystemTime(1_000_000 + 5_001);
    expect(c.active).toBe(false);
  });
});
