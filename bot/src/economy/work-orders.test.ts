import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  aggregateWorkOrders,
  formatMaterialList,
  parseWorkOrderArgs,
  scaleBom,
  WorkOrderStore,
} from "./work-orders.js";

describe("work order pure helpers", () => {
  it("scales BOM by qty", () => {
    const lines = scaleBom(
      [
        { material: "Ti", amount: 64, unit: "SCU" },
        { material: "Cu", amount: 26, unit: "SCU" },
      ],
      3,
    );
    expect(lines[0]!.amount).toBe(192);
    expect(lines[1]!.amount).toBe(78);
  });

  it("aggregates multiple orders (Chase mockup)", () => {
    const orders = [
      {
        id: 1,
        itemName: "NN-14",
        qty: 3,
        lines: [
          { material: "Ti", amount: 192, unit: "SCU" },
          { material: "Cu", amount: 78, unit: "SCU" },
          { material: "Lindinium", amount: 39, unit: "SCU" },
        ],
        createdBy: null,
        createdAt: 1,
      },
    ];
    const needs = aggregateWorkOrders(orders);
    expect(formatMaterialList(needs)).toMatch(/192 SCU of Ti/);
    expect(formatMaterialList(needs)).toMatch(/78 SCU of Cu/);
    expect(formatMaterialList(needs)).toMatch(/39 SCU of Lindinium/);
  });

  it("parses workorder args", () => {
    expect(parseWorkOrderArgs("NN-14 x3")).toEqual({
      sub: "add",
      item: "NN-14",
      qty: 3,
    });
    expect(parseWorkOrderArgs("P4-AR qty:2").qty).toBe(2);
    expect(parseWorkOrderArgs("list").sub).toBe("list");
    expect(parseWorkOrderArgs("done 4")).toEqual({
      sub: "done",
      item: "",
      qty: 1,
      id: 4,
    });
  });
});

describe("WorkOrderStore", () => {
  it("add list aggregate clear", () => {
    const db = new Database(":memory:");
    const store = new WorkOrderStore(db);
    store.add({
      itemName: "NN-14",
      qty: 3,
      lines: [
        { material: "Ti", amount: 192, unit: "SCU" },
        { material: "Cu", amount: 78, unit: "SCU" },
      ],
      createdBy: "uid1",
    });
    expect(store.list()).toHaveLength(1);
    const needs = aggregateWorkOrders(store.list());
    expect(needs.find((n) => n.material === "Ti")?.amount).toBe(192);
    store.clear();
    expect(store.list()).toHaveLength(0);
    db.close();
  });
});
