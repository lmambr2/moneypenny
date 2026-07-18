import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  callsignOwnerKey,
  shipIdFromName,
  uidOwnerKey,
  UserShipsStore,
} from "./user-ships.js";

describe("UserShipsStore", () => {
  it("adds qty and removes", () => {
    const store = new UserShipsStore(new Database(":memory:"));
    const key = uidOwnerKey("u1");
    store.ensureUidProfile("u1", "Alice");
    store.addShip({
      ownerKey: key,
      shipId: shipIdFromName("Prospector"),
      shipName: "Prospector",
      qty: 2,
      catalogMatched: true,
    });
    expect(store.listShips(key)[0]?.qty).toBe(2);
    store.addShip({
      ownerKey: key,
      shipId: shipIdFromName("Prospector"),
      shipName: "Prospector",
      qty: 1,
      catalogMatched: true,
    });
    expect(store.listShips(key)[0]?.qty).toBe(3);
    store.removeShip(key, shipIdFromName("Prospector"), 1);
    expect(store.listShips(key)[0]?.qty).toBe(2);
    store.removeShip(key, shipIdFromName("Prospector"), 99);
    expect(store.listShips(key)).toEqual([]);
  });

  it("rekeys callsign hangar onto uid", () => {
    const store = new UserShipsStore(new Database(":memory:"));
    const cs = store.ensureCallsignProfile("GCV");
    store.addShip({
      ownerKey: cs.ownerKey,
      shipId: "polaris",
      shipName: "Polaris",
      qty: 1,
      catalogMatched: false,
    });
    const uid = store.ensureUidProfile("uid-alice", "Alice");
    store.rekeyOwner(callsignOwnerKey("GCV"), uid.ownerKey);
    expect(store.listShips(uid.ownerKey)).toHaveLength(1);
    expect(store.listShips(callsignOwnerKey("GCV"))).toHaveLength(0);
  });

  it("ownersWithShip finds hulls", () => {
    const store = new UserShipsStore(new Database(":memory:"));
    const a = store.ensureUidProfile("a", "A");
    store.addShip({
      ownerKey: a.ownerKey,
      shipId: "carrack",
      shipName: "Carrack",
      qty: 1,
      catalogMatched: true,
    });
    const hits = store.ownersWithShip("carr");
    expect(hits.some((h) => h.matchedShipName === "Carrack")).toBe(true);
  });
});
