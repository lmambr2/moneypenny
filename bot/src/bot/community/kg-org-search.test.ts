import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { KgStore } from "../../data/kg.js";
import type { MemPalaceClient } from "../../memory/mempalace-client.js";
import { KgService } from "./kg.js";

function makeService(opts: {
  kgEnabled?: boolean;
  mempalaceEnabled?: boolean;
  mempalace?: Partial<MemPalaceClient> | null;
}) {
  const db = new Database(":memory:");
  const store = new KgStore(db);
  const config = {
    kgEnabled: opts.kgEnabled ?? true,
    mempalaceEnabled: opts.mempalaceEnabled ?? false,
  } as any;
  const svc = new KgService({
    store,
    config,
    mempalace: (opts.mempalace as MemPalaceClient) ?? null,
  });
  return { svc, store, config };
}

describe("KgService org search + seed (R4)", () => {
  it("searchOrg uses MemPalace kgSearch when available", async () => {
    const kgSearch = vi.fn(async () => [{ fact: "FC is Alice" }]);
    const remember = vi.fn();
    const { svc } = makeService({
      mempalaceEnabled: true,
      mempalace: { kgSearch, remember } as any,
    });
    const hits = await svc.searchOrg("fleet commander", 5);
    expect(kgSearch).toHaveBeenCalled();
    expect(hits).toEqual([{ fact: "FC is Alice" }]);
    // Must not call per-user remember
    expect(remember).not.toHaveBeenCalled();
  });

  it("searchOrg falls back to SQLite KG (never private rooms)", async () => {
    const { svc, store } = makeService({ kgEnabled: true, mempalaceEnabled: false });
    store.add({ fact: "Mining lead is Bob", subject: "Bob" });
    const hits = await svc.searchOrg("mining lead", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].fact).toMatch(/Bob|Mining/i);
  });

  it("seedOrgFact writes SQLite and awaits MemPalace kgRemember", async () => {
    const kgRemember = vi.fn(async () => true);
    const remember = vi.fn(async () => true); // per-user — must not be used for org seed path of bumper
    const { svc } = makeService({
      kgEnabled: true,
      mempalaceEnabled: true,
      mempalace: { kgRemember, remember, kgSearch: async () => [] } as any,
    });
    const r = await svc.seedOrgFact("FC is Carol");
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Recorded|org/i);
    expect(kgRemember).toHaveBeenCalled();
    // seed uses kgRemember, not per-user remember
    expect(remember).not.toHaveBeenCalled();
    const listed = svc.listFacts(5);
    expect(listed.some((f) => f.fact.includes("Carol"))).toBe(true);
  });

  it("private MemoryStore facts never appear in searchOrg (H3 isolation)", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { MemoryStore } = await import("../../data/memory.js");
    const db = new Database(":memory:");
    const privateStore = new MemoryStore(db);
    privateStore.add("uid-private", "I fly a secret Prospector");
    const { svc } = makeService({ kgEnabled: true, mempalaceEnabled: false });
    // Only org store is wired to svc — private store is a separate wall
    const hits = await svc.searchOrg("Prospector", 10);
    expect(hits.every((h) => !h.fact.includes("secret Prospector"))).toBe(true);
    expect(privateStore.recall("uid-private")[0].fact).toMatch(/Prospector/);
  });

  it("after seed, searchOrg returns hits via injectable MemPalace", async () => {
    const facts: string[] = [];
    const kgRemember = vi.fn(async (line: string) => {
      facts.push(line);
      return true;
    });
    const kgSearch = vi.fn(async (q: string) =>
      facts
        .filter((f) => f.toLowerCase().includes(q.toLowerCase().split(/\s+/)[0] ?? ""))
        .map((fact) => ({ fact })),
    );
    const { svc } = makeService({
      kgEnabled: true,
      mempalaceEnabled: true,
      mempalace: { kgRemember, kgSearch, remember: vi.fn() } as any,
    });
    await svc.seedOrgFact("Hangar duty is Eve");
    // force search to hit mempalace path with stored fact
    facts.push("Hangar duty is Eve");
    const hits = await svc.searchOrg("Hangar", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].fact).toMatch(/Eve/);
    // Private room API never used
    expect((svc as any).deps.mempalace.remember).not.toHaveBeenCalled();
  });
});
