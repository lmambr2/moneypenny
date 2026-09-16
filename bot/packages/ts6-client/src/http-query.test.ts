import { describe, expect, it } from "vitest";
import { TS6HttpQuery } from "./http-query.js";

describe("TS6HttpQuery cooldown", () => {
  it("does not wait the full timeout on the second call after a connection failure", async () => {
    const q = new TS6HttpQuery({ host: "127.0.0.1", port: 1, timeoutMs: 5000 });
    await expect(q.request("GET", "/")).rejects.toThrow();
    const t0 = Date.now();
    await expect(q.request("GET", "/")).rejects.toThrow(/cooldown/i);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(q.isCoolingDown()).toBe(true);
  });
});
