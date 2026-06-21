import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { MemoryStore } from "../../data/memory.js";
import { MemoryService } from "./memory.js";

describe("MemoryService", () => {
  let service: MemoryService;

  beforeEach(() => {
    const db = new Database(":memory:");
    const store = new MemoryStore(db);
    service = new MemoryService({ store, config: { memoryEnabled: true } as any });
  });

  it("handleRemember requires args and uid", () => {
    expect(service.handleRemember("", "u1")).toMatch(/Usage/);
    expect(service.handleRemember("likes jazz", undefined)).toMatch(/Couldn't identify/);
  });

  it("handleRecall lists stored facts", async () => {
    service.handleRemember("likes jazz", "u1");
    const out = await service.handleRecall("u1");
    expect(out).toContain("likes jazz");
  });

  it("handleForget removes one fact by recall index (newest first)", async () => {
    service.handleRemember("alpha", "u1");
    service.handleRemember("beta", "u1");
    expect(service.handleForget("1", "u1")).toBe("Forgotten.");
    const out = await service.handleRecall("u1");
    expect(out).toContain("alpha");
    expect(out).not.toContain("beta");
  });

  it("handleForget all clears the user", async () => {
    service.handleRemember("alpha", "u1");
    expect(service.handleForget("all", "u1")).toMatch(/Forgotten 1/);
    expect(await service.handleRecall("u1")).toMatch(/nothing on you/i);
  });

  it("syncToMemPalace pushes all SQLite facts", async () => {
    const db = new Database(":memory:");
    const store = new MemoryStore(db);
    store.add("u1", "alpha");
    store.add("u2", "beta");
    const remember = vi.fn(async () => true);
    const syncService = new MemoryService({
      store,
      config: { mempalaceEnabled: true } as any,
      mempalace: { remember } as any,
    });
    const out = await syncService.syncToMemPalace();
    expect(out.synced).toBe(2);
    expect(remember).toHaveBeenCalledTimes(2);
  });
});