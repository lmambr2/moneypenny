import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ScCraftBlueprint, ScCraftClient } from "./sc-craft.js";
import { handleWorkItemsCommand, handleWorkOrderCommand } from "./work-order-service.js";
import { WorkOrderStore } from "./work-orders.js";

const bp: ScCraftBlueprint = {
  id: 1,
  name: "P4-AR",
  blueprint_id: "p4-ar",
  ingredients: [
    { name: "Titanium", quantity_scu: 4 },
    { name: "Quantainium", quantity_scu: 1 },
  ],
};

function mockCraft(enabled = true): ScCraftClient {
  return {
    isEnabled: () => enabled,
    clearCache: () => {},
    search: async () => ({
      items: [bp],
      total: 1,
      fetchedAt: Date.now(),
      attribution: "test",
    }),
    getById: async () => bp,
    resolveBlueprint: async (q: string) => (/p4/i.test(q) || /ar/i.test(q) ? bp : null),
  } as unknown as ScCraftClient;
}

describe("handleWorkOrderCommand / work-items", () => {
  let db: Database.Database;
  let store: WorkOrderStore;

  afterEach(() => {
    db?.close();
  });

  function freshStore() {
    db = new Database(":memory:");
    store = new WorkOrderStore(db);
    return store;
  }

  it("help / empty board / add / list / done / clear", async () => {
    const s = freshStore();
    const craft = mockCraft();

    const help = await handleWorkOrderCommand("", "!", { store: s, scCraft: craft });
    expect(help).toMatch(/workorder/);

    expect(handleWorkItemsCommand("!", s)).toMatch(/Nothing on the board/i);

    const add = await handleWorkOrderCommand("P4-AR x2", "!", {
      store: s,
      scCraft: craft,
      invokerUid: "uid-1",
    });
    expect(add).toMatch(/work order #/);
    expect(add).toMatch(/P4-AR/);
    expect(add).toMatch(/⚠️|Quantainium/i);

    const list = await handleWorkOrderCommand("list", "!", { store: s, scCraft: craft });
    expect(list).toMatch(/#1/);
    expect(list).toMatch(/2× P4-AR/);

    const items = handleWorkItemsCommand("!", s);
    expect(items).toMatch(/org needs/i);
    expect(items).toMatch(/Titanium|Quantainium/i);

    const done = await handleWorkOrderCommand("done 1", "!", { store: s, scCraft: craft });
    expect(done).toMatch(/Removed work order #1/);

    await handleWorkOrderCommand("P4-AR x1", "!", { store: s, scCraft: craft });
    const clear = await handleWorkOrderCommand("clear", "!", { store: s, scCraft: craft });
    expect(clear).toMatch(/Cleared 1/);
    expect(s.list()).toHaveLength(0);
  });

  it("fails soft when craft disabled or no match", async () => {
    const s = freshStore();
    const off = await handleWorkOrderCommand("P4-AR x1", "!", {
      store: s,
      scCraft: mockCraft(false),
    });
    expect(off).toMatch(/disabled/i);

    const miss = await handleWorkOrderCommand("zzzz-nope x1", "!", {
      store: s,
      scCraft: mockCraft(true),
    });
    expect(miss).toMatch(/No blueprint match/i);
  });

  it("reports unavailable store", async () => {
    const out = await handleWorkOrderCommand("list", "!", {
      store: null,
      scCraft: mockCraft(),
    });
    expect(out).toMatch(/unavailable/i);
  });

  it("denies clear when canClear returns false", async () => {
    const s = freshStore();
    await handleWorkOrderCommand("P4-AR x1", "!", { store: s, scCraft: mockCraft() });
    const denied = await handleWorkOrderCommand("clear", "!", {
      store: s,
      scCraft: mockCraft(),
      canClear: () => false,
    });
    expect(denied).toMatch(/requires admin|workorder\.clear/i);
    expect(s.list()).toHaveLength(1);

    const ok = await handleWorkOrderCommand("clear", "!", {
      store: s,
      scCraft: mockCraft(),
      canClear: () => true,
    });
    expect(ok).toMatch(/Cleared/);
    expect(s.list()).toHaveLength(0);
  });
});
