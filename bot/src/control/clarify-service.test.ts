import { describe, expect, it } from "vitest";
import { clarifyPendingKey, MemoryClarifyService } from "./clarify-service.js";

describe("MemoryClarifyService", () => {
  it("is off by default — always proceed", () => {
    const s = new MemoryClarifyService();
    const d = s.evaluate("c::u", [{ name: "play_music", arguments: {} }]);
    expect(d).toEqual({ action: "proceed" });
  });

  it("when enabled, clarifies play without query then proceeds once pending", () => {
    const s = new MemoryClarifyService();
    s.setEnabled(true);
    const key = clarifyPendingKey("chan", "uid1", "Bob");
    const first = s.evaluate(key, [{ name: "play_music", arguments: {} }]);
    expect(first.action).toBe("clarify");
    const second = s.evaluate(key, [{ name: "play_music", arguments: {} }]);
    expect(second).toEqual({ action: "proceed" });
  });

  it("proceeds when query present", () => {
    const s = new MemoryClarifyService();
    s.setEnabled(true);
    const d = s.evaluate("k", [{ name: "play_music", arguments: { query: "jazz" } }]);
    expect(d).toEqual({ action: "proceed" });
  });
});
