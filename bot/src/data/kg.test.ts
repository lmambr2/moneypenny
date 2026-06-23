import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { KgStore } from "./kg.js";

describe("KgStore", () => {
  let store: KgStore;

  beforeEach(() => {
    store = new KgStore(new Database(":memory:"));
  });

  it("records and queries subject facts with temporal windows", () => {
    store.add({
      fact: "Graf Cyril was Fleet Commander",
      subject: "Graf Cyril",
      validFrom: "2024-01-01",
      validUntil: "2025-06-30",
    });
    store.add({
      fact: "Graf Cyril was Logistics Lead",
      subject: "Graf Cyril",
      validFrom: "2025-07-01",
      validUntil: null,
    });

    const mid = store.querySubject("Graf Cyril", "2025-01-15");
    expect(mid).toHaveLength(1);
    expect(mid[0].fact).toContain("Fleet Commander");

    const later = store.querySubject("Graf Cyril", "2025-08-01");
    expect(later).toHaveLength(1);
    expect(later[0].fact).toContain("Logistics Lead");
  });

  it("searchText returns active facts matching question tokens", () => {
    store.add({ fact: "TF18 roster lead was Morgan", subject: "Morgan" });
    const hits = store.searchText("who led TF18 roster");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].fact).toContain("Morgan");
  });
});