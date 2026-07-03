import { describe, it, expect } from "vitest";
import { floorFromMembers } from "./floor.js";

// levelsFor keyed by uid — mimics allowedClassificationsFor per member.
const levels = (map: Record<string, string[]>) => (s: { uid: string }) => map[s.uid];

describe("floorFromMembers (§6.3 adversarial)", () => {
  it("one uncleared listener floors the whole window", () => {
    const f = floorFromMembers(
      [{ uid: "officer" }, { uid: "guest" }],
      levels({ officer: ["unclassified", "restricted", "secret"], guest: ["unclassified"] }),
    );
    expect(f).toEqual(["unclassified"]);
  });

  it("a fully-cleared room keeps the intersection", () => {
    const f = floorFromMembers(
      [{ uid: "a" }, { uid: "b" }],
      levels({ a: ["unclassified", "restricted", "secret"], b: ["unclassified", "restricted"] }),
    );
    expect(f.sort()).toEqual(["restricted", "unclassified"]);
  });

  it("skips the bot itself (type 1) and unknowns default to unclassified", () => {
    const f = floorFromMembers(
      [{ uid: "bot", type: 1 }, { uid: "stranger" }],
      levels({ bot: ["unclassified", "secret"] }), // stranger resolves undefined
    );
    expect(f).toEqual(["unclassified"]);
  });

  it("an empty channel defaults to unclassified", () => {
    expect(floorFromMembers([], () => ["secret"])).toEqual(["unclassified"]);
  });

  it("disjoint clearances (empty intersection) fail closed to unclassified", () => {
    const f = floorFromMembers(
      [{ uid: "a" }, { uid: "b" }],
      levels({ a: ["restricted"], b: ["secret"] }),
    );
    expect(f).toEqual(["unclassified"]);
  });
});
