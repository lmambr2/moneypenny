import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoastQuote } from "../../data/roast.js";
import { RoastStore } from "../../data/roast.js";
import {
  formatRoastExchange,
  formatRoastReel,
  isRoastableBotReply,
  looksLikeImageOrBinaryPayload,
  parseRoastGrade,
  RoastService,
  roastCooldownRemainingMs,
  roastQuestionFromInput,
  sanitizeRoastCapture,
  selectReelQuotes,
} from "./roast.js";

describe("parseRoastGrade", () => {
  it("parses JSON score and reason", () => {
    expect(parseRoastGrade('{"score": 8, "reason": "yikes"}')).toEqual({
      score: 8,
      reason: "yikes",
    });
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
      config: {
        roastEnabled: true,
        roastCooldownMinutes: 60,
        roastMinPresent: 2,
        roastMinScore: 4,
      } as any,
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

  it("sanitizeRoastCapture strips BBCode and URLs", () => {
    expect(sanitizeRoastCapture("[b]hello[/b] https://x.com/y world")).toBe("hello world");
  });

  it("sanitizeRoastCapture rejects image data-URLs and base64 magic", () => {
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    expect(sanitizeRoastCapture(`data:image/png;base64,${pngB64}`)).toBe("");
    expect(sanitizeRoastCapture(pngB64)).toBe("");
    expect(
      sanitizeRoastCapture(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/",
      ),
    ).toBe("");
    expect(sanitizeRoastCapture("[img]https://cdn.example/pic.png[/img]")).toBe("");
    expect(sanitizeRoastCapture("just normal chat lol")).toBe("just normal chat lol");
  });

  it("looksLikeImageOrBinaryPayload flags high-entropy base64 blobs", () => {
    const blob = `${"ABCD".repeat(20)}==`;
    expect(looksLikeImageOrBinaryPayload(blob)).toBe(true);
    expect(looksLikeImageOrBinaryPayload("hey everyone, that was wild yesterday")).toBe(false);
  });

  it("captureLine drops image pastes", () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    service.captureLine({
      targetMode: 2,
      invokerId: "7",
      invokerUid: "u-img",
      invokerName: "Paster",
      message: `data:image/png;base64,${png}`,
    } as any);
    expect(store.ungradedCount()).toBe(0);

    service.captureLine({
      targetMode: 2,
      invokerId: "7",
      invokerUid: "u-txt",
      invokerName: "Talker",
      message: "this is fine, right?",
    } as any);
    expect(store.ungradedCount()).toBe(1);
  });

  it("roastQuestionFromInput strips !ask / !analyst", () => {
    expect(roastQuestionFromInput("!ask how do I refine quantanium")).toBe(
      "how do I refine quantanium",
    );
    expect(roastQuestionFromInput("!analyst summarise the charter")).toBe("summarise the charter");
    expect(roastQuestionFromInput("what is a jump point")).toBe("what is a jump point");
  });

  it("isRoastableBotReply rejects transport and usage", () => {
    expect(isRoastableBotReply("Now playing: Africa - Toto")).toBe(false);
    expect(isRoastableBotReply("Unknown command. Try !help.")).toBe(false);
    expect(isRoastableBotReply("Analyst on it — I'll post the result here when ready.")).toBe(
      false,
    );
    expect(isRoastableBotReply("A jump point is a quantum tunnel, darling. Try not to miss.")).toBe(
      true,
    );
  });

  it("captureExchange stores the question and her reply, skips opt-out", () => {
    service.captureExchange({
      userUid: "u-ask",
      userName: "Alice",
      question: "how do I refine quantanium",
      reply: "Slowly, and preferably not next to the fuel tanks.",
    });
    expect(store.ungradedCount()).toBe(1);
    expect(store.ungraded(1)[0]!.text).toBe(
      formatRoastExchange(
        "Alice",
        "how do I refine quantanium",
        "Slowly, and preferably not next to the fuel tanks.",
      ),
    );

    service.handleOptOut("u-ask");
    expect(store.ungradedCount()).toBe(0);
    service.captureExchange({
      userUid: "u-ask",
      userName: "Alice",
      question: "again?",
      reply: "Still no, dear.",
    });
    expect(store.ungradedCount()).toBe(0);
  });

  it("captureExchange ignores Now playing replies", () => {
    service.captureExchange({
      userUid: "u2",
      userName: "Bob",
      question: "play africa",
      reply: "Now playing: Africa - Toto",
    });
    expect(store.ungradedCount()).toBe(0);
  });

  it("opt-out then opt-in resumes capture", () => {
    store.add("u1", "Alice", "line");
    expect(service.handleOptOut("u1")).toMatch(/out of the roast/);
    expect(store.isOptedOut("u1")).toBe(true);
    expect(service.handleOptIn("u1")).toMatch(/Welcome back/);
    expect(store.isOptedOut("u1")).toBe(false);
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
