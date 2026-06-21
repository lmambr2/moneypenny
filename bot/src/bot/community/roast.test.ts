import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { RoastStore } from "../../data/roast.js";
import {
  RoastService,
  parseRoastGrade,
  selectReelQuotes,
  formatRoastReel,
  roastCooldownRemainingMs,
} from "./roast.js";
import type { RoastQuote } from "../../data/roast.js";

describe("parseRoastGrade", () => {
  it("parses JSON score and reason", () => {
    expect(parseRoastGrade('{"score": 8, "reason": "yikes"}')).toEqual({ score: 8, reason: "yikes" });
  });

  it("returns null for garbage", () => {
    expect(parseRoastGrade("not json")).toBeNull();
  });
});

describe("selectReelQuotes", () => {
  const quotes: RoastQuote[] = [
    { id: 1, userUid: "a", userName: "A", text: "one", createdAt: 1, score: 9, reason: null },
    { id: 2, userUid: "a", userName: "A", text: "two", createdAt: 2, score: 8, reason: null },
    { id: 3, userUid: "b", userName: "B", text: "three", createdAt: 3, score: 7, reason: null },
    { id: 4, userUid: "c", userName: "C", text: "low", createdAt: 4, score: 2, reason: null },
  ];

  it("filters by min score and caps per user", () => {
    const picks = selectReelQuotes(quotes, { limit: 5, minScore: 6, maxPerUser: 1 });
    expect(picks.map((q) => q.id)).toEqual([1, 3]);
  });
});

describe("RoastService", () => {
  let store: RoastStore;
  let service: RoastService;
  const sendTextMessage = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    store = new RoastStore(new Database(":memory:"));
    service = new RoastService({
      store,
      config: {
        roastEnabled: true,
        roastMinPresent: 2,
        roastCooldownMinutes: 60,
        roastMinScore: 4,
      } as any,
      llm: () => null,
      tsClient: { sendTextMessage, getClientId: () => 42 } as any,
      logger: console as any,
    });
  });

  it("persists cooldown across service restarts", () => {
    const ts = Date.now() - 1000;
    store.setLastRoastAt(ts);
    const restarted = new RoastService({
      store,
      config: { roastEnabled: true, roastCooldownMinutes: 60, roastMinPresent: 2, roastMinScore: 4 } as any,
      llm: () => null,
      tsClient: { sendTextMessage, getClientId: () => 42 } as any,
      logger: console as any,
    });
    expect(roastCooldownRemainingMs((restarted as any).lastRoastAt, 60)).toBeGreaterThan(0);
  });

  it("auto-post consumes reel quotes so the next reel is fresh", async () => {
    store.add("u1", "Alice", "cringe line");
    store.setGrade(1, 9, "wow");
    store.add("u2", "Bob", "another");
    store.setGrade(2, 8, "yikes");
    store.add("u3", "Carol", "third");
    store.setGrade(3, 7, "oof");

    await service.runTick(3);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(formatRoastReel(store.top(10))).toBeNull();
    expect(store.gradedCount(4)).toBe(0);
  });

  it("skips auto-post during cooldown", async () => {
    const coolStore = new RoastStore(new Database(":memory:"));
    coolStore.setLastRoastAt(Date.now());
    const coolService = new RoastService({
      store: coolStore,
      config: {
        roastEnabled: true,
        roastMinPresent: 2,
        roastCooldownMinutes: 60,
        roastMinScore: 4,
      } as any,
      llm: () => null,
      tsClient: { sendTextMessage, getClientId: () => 42 } as any,
      logger: console as any,
    });
    coolStore.add("u1", "Alice", "line");
    coolStore.setGrade(1, 9, "wow");
    coolStore.add("u2", "Bob", "line2");
    coolStore.setGrade(2, 8, "yikes");
    coolStore.add("u3", "Carol", "line3");
    coolStore.setGrade(3, 7, "oof");

    await coolService.runTick(3);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});