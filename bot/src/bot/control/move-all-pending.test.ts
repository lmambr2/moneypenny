import { describe, expect, it } from "vitest";
import { MoveAllPendingStore } from "./move-all-pending.js";

describe("MoveAllPendingStore", () => {
  it("stages and confirms for the same invoker", () => {
    const store = new MoveAllPendingStore(30_000);
    store.stage("Lobby", [{ clid: 2, nickname: "Bond" }], "uid-1", 0);
    expect(store.confirm("uid-2", 1)).toBeNull();
    const p = store.confirm("uid-1", 1);
    expect(p?.channel).toBe("Lobby");
    expect(store.confirm("uid-1", 2)).toBeNull();
  });

  it("expires after ttl", () => {
    const store = new MoveAllPendingStore(1000);
    store.stage("Lobby", [], "uid-1", 0);
    expect(store.confirm("uid-1", 1001)).toBeNull();
  });
});
