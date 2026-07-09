import { describe, expect, it } from "vitest";
import { ConversationStore, estimateTokens } from "./history.js";

describe("estimateTokens", () => {
  it("approximates ~4 chars/token plus framing overhead", () => {
    expect(estimateTokens("")).toBe(4);
    expect(estimateTokens("abcd")).toBe(5); // ceil(4/4)=1 + 4
    expect(estimateTokens("a".repeat(40))).toBe(14); // 10 + 4
  });
});

describe("ConversationStore", () => {
  it("returns empty history for unknown keys", () => {
    const store = new ConversationStore();
    expect(store.get("nope")).toEqual([]);
  });

  it("retains turns in order", () => {
    const store = new ConversationStore();
    store.append("c", { role: "user", content: "hi" });
    store.append("c", { role: "assistant", content: "hello" });
    expect(store.get("c")).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("isolates conversations by key", () => {
    const store = new ConversationStore();
    store.append("a", { role: "user", content: "in a" });
    store.append("b", { role: "user", content: "in b" });
    expect(store.get("a")).toHaveLength(1);
    expect(store.get("b")).toHaveLength(1);
    expect(store.get("a")[0].content).toBe("in a");
  });

  it("evicts oldest turns once the token budget is exceeded", () => {
    // Each entry: estimate = ceil(len/4)+4. Use len=16 → 8 tokens each.
    const store = new ConversationStore({ maxTokens: 20 }); // room for ~2 entries
    for (let i = 0; i < 5; i++) {
      store.append("c", { role: "user", content: "x".repeat(16) }); // 8 tokens
    }
    const kept = store.get("c");
    const total = kept.reduce((s, e) => s + estimateTokens(e.content), 0);
    expect(total).toBeLessThanOrEqual(20);
    expect(kept.length).toBeLessThan(5);
  });

  it("always keeps at least the most recent turn, even if it alone exceeds budget", () => {
    const store = new ConversationStore({ maxTokens: 5 });
    store.append("c", { role: "user", content: "x".repeat(400) }); // way over budget
    expect(store.get("c")).toHaveLength(1);
  });

  it("enforces the hard turn cap", () => {
    const store = new ConversationStore({ maxTokens: 1_000_000, maxTurns: 3 });
    for (let i = 0; i < 10; i++) {
      store.append("c", { role: "user", content: `m${i}` });
    }
    const kept = store.get("c");
    expect(kept).toHaveLength(3);
    expect(kept.map((e) => e.content)).toEqual(["m7", "m8", "m9"]);
  });

  it("clears a conversation", () => {
    const store = new ConversationStore();
    store.append("c", { role: "user", content: "hi" });
    store.clear("c");
    expect(store.get("c")).toEqual([]);
  });

  it("appendMany trims after a batch", () => {
    const store = new ConversationStore({ maxTurns: 2 });
    store.appendMany("c", [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    ]);
    expect(store.get("c").map((e) => e.content)).toEqual(["2", "3"]);
  });
});
