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

  it("handleRemember requires args and uid", async () => {
    expect(await service.handleRemember("", "u1")).toMatch(/Usage/);
    expect(await service.handleRemember("likes jazz", undefined)).toMatch(/Couldn't identify/);
  });

  it("handleRecall lists stored facts", async () => {
    await service.handleRemember("likes jazz", "u1");
    const out = await service.handleRecall("u1");
    expect(out).toContain("likes jazz");
  });

  it("handleForget removes one fact by recall index (newest first)", async () => {
    await service.handleRemember("alpha", "u1");
    await service.handleRemember("beta", "u1");
    expect(await service.handleForget("1", "u1")).toBe("Forgotten.");
    const out = await service.handleRecall("u1");
    expect(out).toContain("alpha");
    expect(out).not.toContain("beta");
  });

  it("handleForget all clears the user", async () => {
    await service.handleRemember("alpha", "u1");
    expect(await service.handleForget("all", "u1")).toMatch(/Forgotten 1/);
    expect(await service.handleRecall("u1")).toMatch(/nothing on you/i);
  });

  it("awaits MemPalace on remember and reports sync failure", async () => {
    const db = new Database(":memory:");
    const store = new MemoryStore(db);
    const remember = vi.fn(async () => false);
    const svc = new MemoryService({
      store,
      config: { memoryEnabled: true, mempalaceEnabled: true } as any,
      mempalace: { remember, recall: vi.fn(), forget: vi.fn() } as any,
    });
    const out = await svc.handleRemember("likes tea", "u1");
    expect(remember).toHaveBeenCalledWith("u1", "likes tea");
    expect(out).toMatch(/MemPalace sync failed/);
    expect(store.recall("u1").map((f) => f.fact)).toContain("likes tea");
  });

  it("awaits MemPalace forget before confirming", async () => {
    const db = new Database(":memory:");
    const store = new MemoryStore(db);
    store.add("u1", "gone");
    const forget = vi.fn(async () => true);
    const svc = new MemoryService({
      store,
      config: { memoryEnabled: true, mempalaceEnabled: true } as any,
      mempalace: { remember: vi.fn(), recall: vi.fn(async () => []), forget } as any,
    });
    expect(await svc.handleForget("all", "u1")).toMatch(/Forgotten 1/);
    expect(forget).toHaveBeenCalledWith("u1", { all: true });
  });

  it("syncToMemPalace pushes all SQLite facts and records lastSync", async () => {
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
    expect(out.total).toBe(2);
    expect(out.skipped).toBe(false);
    expect(remember).toHaveBeenCalledTimes(2);
    expect(syncService.getLastSync()?.result.synced).toBe(2);
  });
});
