import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DurableHarnessStore, HARNESS_TURN_RETENTION_MS } from "./durable.js";

describe("DurableHarnessStore", () => {
  it("inserts user text and prunes rows older than 30 days", () => {
    const db = new Database(":memory:");
    const store = new DurableHarnessStore(db);
    const now = 1_700_000_000_000;
    store.insert(
      {
        id: "old",
        at: now - HARNESS_TURN_RETENTION_MS - 1,
        channel: "dashboard",
        mode: "ask",
        userText: "stale",
        replyText: "gone",
        toolsJson: "[]",
        sourcesJson: "[]",
        steps: 1,
      },
      now,
    );
    store.insert(
      {
        id: "new",
        at: now,
        channel: "voice",
        conversationId: "voice:uid",
        userUid: "uid",
        mode: "intent",
        userText: "play ambient",
        replyText: "queued",
        toolsJson: "[]",
        sourcesJson: "[]",
        steps: 2,
      },
      now,
    );
    const rows = store.list();
    expect(rows.map((r) => r.id)).toEqual(["new"]);
    expect(rows[0].userText).toBe("play ambient");
    expect(rows[0].userUid).toBe("uid");
    expect(rows[0].steps).toBe(2);
  });
});
