import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { MemoryStore } from "./memory.js";

describe("MemoryStore", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore(new Database(":memory:"));
  });

  it("stores and recalls per-user facts, newest first", () => {
    store.add("uid-a", "flies a Gladius");
    store.add("uid-a", "prefers night ops");
    store.add("uid-b", "logistics lead");
    const a = store.recall("uid-a");
    expect(a.map((f) => f.fact)).toEqual(["prefers night ops", "flies a Gladius"]);
    expect(store.recall("uid-b").map((f) => f.fact)).toEqual(["logistics lead"]);
    expect(store.count("uid-a")).toBe(2);
  });

  it("forget clears a user's facts only", () => {
    store.add("uid-a", "x");
    store.add("uid-b", "y");
    expect(store.forget("uid-a")).toBe(1);
    expect(store.recall("uid-a")).toEqual([]);
    expect(store.count("uid-b")).toBe(1);
  });

  it("forgetOne removes a single fact scoped to its owner", () => {
    store.add("uid-a", "keep");
    store.add("uid-a", "drop");
    const [drop] = store.recall("uid-a");
    expect(store.forgetOne("uid-b", drop.id)).toBe(false); // wrong owner
    expect(store.forgetOne("uid-a", drop.id)).toBe(true);
    expect(store.recall("uid-a").map((f) => f.fact)).toEqual(["keep"]);
  });
});
