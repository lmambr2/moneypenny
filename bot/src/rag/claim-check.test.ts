import { describe, expect, it, vi } from "vitest";
import { extractClaimsHeuristic, runClaimCheck, scoreSupport } from "./claim-check.js";

describe("extractClaimsHeuristic", () => {
  it("pulls factual-looking sentences", () => {
    const claims = extractClaimsHeuristic(
      "We dock at Area18. Hello. The fleet has 12 ships ready for jump.",
      5,
    );
    expect(claims.some((c) => c.includes("Area18") || c.includes("12"))).toBe(true);
  });
});

describe("scoreSupport", () => {
  it("marks supported when words overlap sources", () => {
    expect(
      scoreSupport("Dock at Area Eighteen hangar", ["Hangar notes: dock at area eighteen"]),
    ).toBe("supported");
  });

  it("marks missing when no overlap", () => {
    expect(scoreSupport("The secret code is 9999", ["Weather is fine today"])).toBe("missing");
  });
});

describe("runClaimCheck", () => {
  it("no-ops when disabled", async () => {
    const r = await runClaimCheck("Hello world is fine today enough.", [], { enabled: false }, {});
    expect(r.ran).toBe(false);
    expect(r.draft).toContain("Hello");
  });

  it("re-retrieves unsupported claims", async () => {
    const retrieve = vi.fn(async () => [{ text: "Dock at Area18 pad 4", source: "ops.md" }]);
    const revise = vi.fn(async () => "Dock at Area18 pad 4 as documented.");
    const r = await runClaimCheck(
      "You should dock at Area18 pad 4 for refuel operations today.",
      ["Unrelated doctrine about mining lasers only."],
      { enabled: true, maxClaims: 3, maxExtraRetrieves: 2, revise: true, timeoutMs: 5000 },
      { retrieve, revise },
    );
    expect(r.ran).toBe(true);
    expect(retrieve).toHaveBeenCalled();
  });

  it("fail-open on retrieve error", async () => {
    const r = await runClaimCheck(
      "The password is hunter2 for the vault system access.",
      [],
      { enabled: true, timeoutMs: 2000 },
      {
        retrieve: async () => {
          throw new Error("qdrant down");
        },
      },
    );
    expect(r.ran).toBe(true);
    expect(r.draft).toContain("hunter2");
  });
});
