/**
 * Org work orders — shopping-list accumulator (Chase mockup).
 *
 * !workorder <item> xN  → resolve BOM, ×qty, save
 * !work-items           → sum open orders into org material totals
 */
import type Database from "better-sqlite3";
import { formatMaterialName } from "./material-flags.js";

export interface WorkOrderLine {
  material: string;
  amount: number;
  unit: string;
}

export interface WorkOrder {
  id: number;
  itemName: string;
  qty: number;
  lines: WorkOrderLine[];
  createdBy: string | null;
  createdAt: number;
}

export interface MaterialNeed {
  material: string;
  amount: number;
  unit: string;
}

/** Pure: scale BOM lines by qty. */
export function scaleBom(
  lines: WorkOrderLine[],
  qty: number,
): WorkOrderLine[] {
  const n = Math.max(1, Math.floor(qty));
  return lines.map((l) => ({
    material: l.material,
    unit: l.unit || "SCU",
    amount: Math.round(l.amount * n * 1000) / 1000,
  }));
}

/** Pure: sum open orders into material totals. */
export function aggregateWorkOrders(orders: WorkOrder[]): MaterialNeed[] {
  const map = new Map<string, MaterialNeed>();
  for (const o of orders) {
    for (const line of o.lines) {
      const key = `${line.unit}::${line.material.toLowerCase()}`;
      const prev = map.get(key);
      if (prev) {
        prev.amount = Math.round((prev.amount + line.amount) * 1000) / 1000;
      } else {
        map.set(key, {
          material: line.material,
          amount: line.amount,
          unit: line.unit || "SCU",
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.material.localeCompare(b.material));
}

/** Format "64 SCU of Ti, 26 SCU of Cu, and 13 SCU of Quantainium ⚠️" */
export function formatMaterialList(lines: WorkOrderLine[] | MaterialNeed[]): string {
  if (lines.length === 0) return "nothing";
  const parts = lines.map((l) => {
    const amt = Number.isInteger(l.amount) ? String(l.amount) : String(l.amount);
    return `${amt} SCU of ${formatMaterialName(l.material)}`;
  });
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export class WorkOrderStore {
  private addStmt: Database.Statement;
  private listStmt: Database.Statement;
  private getStmt: Database.Statement;
  private delStmt: Database.Statement;
  private clearStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        qty INTEGER NOT NULL,
        lines_json TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_orders_created ON work_orders(created_at DESC);
    `);
    this.addStmt = db.prepare(
      `INSERT INTO work_orders (item_name, qty, lines_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.listStmt = db.prepare(
      `SELECT id, item_name, qty, lines_json, created_by, created_at
       FROM work_orders ORDER BY id ASC`,
    );
    this.getStmt = db.prepare(
      `SELECT id, item_name, qty, lines_json, created_by, created_at
       FROM work_orders WHERE id = ?`,
    );
    this.delStmt = db.prepare(`DELETE FROM work_orders WHERE id = ?`);
    this.clearStmt = db.prepare(`DELETE FROM work_orders`);
  }

  add(opts: {
    itemName: string;
    qty: number;
    lines: WorkOrderLine[];
    createdBy?: string | null;
  }): WorkOrder {
    const qty = Math.max(1, Math.floor(opts.qty));
    const lines = scaleBom(opts.lines, 1); // already scaled by caller
    const now = Date.now();
    const info = this.addStmt.run(
      opts.itemName.slice(0, 200),
      qty,
      JSON.stringify(lines),
      opts.createdBy ?? null,
      now,
    );
    return {
      id: Number(info.lastInsertRowid),
      itemName: opts.itemName.slice(0, 200),
      qty,
      lines,
      createdBy: opts.createdBy ?? null,
      createdAt: now,
    };
  }

  list(): WorkOrder[] {
    const rows = this.listStmt.all() as Array<{
      id: number;
      item_name: string;
      qty: number;
      lines_json: string;
      created_by: string | null;
      created_at: number;
    }>;
    return rows.map(rowToOrder);
  }

  get(id: number): WorkOrder | null {
    const row = this.getStmt.get(id) as
      | {
          id: number;
          item_name: string;
          qty: number;
          lines_json: string;
          created_by: string | null;
          created_at: number;
        }
      | undefined;
    return row ? rowToOrder(row) : null;
  }

  remove(id: number): boolean {
    return this.delStmt.run(id).changes > 0;
  }

  clear(): number {
    return this.clearStmt.run().changes;
  }
}

function rowToOrder(row: {
  id: number;
  item_name: string;
  qty: number;
  lines_json: string;
  created_by: string | null;
  created_at: number;
}): WorkOrder {
  let lines: WorkOrderLine[] = [];
  try {
    const parsed = JSON.parse(row.lines_json) as WorkOrderLine[];
    if (Array.isArray(parsed)) lines = parsed;
  } catch {
    /* empty */
  }
  return {
    id: row.id,
    itemName: row.item_name,
    qty: row.qty,
    lines,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

let defaultStore: WorkOrderStore | null = null;

export function initWorkOrderStore(db: Database.Database): WorkOrderStore {
  defaultStore = new WorkOrderStore(db);
  return defaultStore;
}

export function getWorkOrderStore(): WorkOrderStore | null {
  return defaultStore;
}

export function setWorkOrderStoreForTests(store: WorkOrderStore | null): void {
  defaultStore = store;
}

/** Parse "!workorder NN-14 x3" / "P4-AR qty:3" / "list" / "clear" / "done 2" */
export function parseWorkOrderArgs(args: string): {
  sub: "add" | "list" | "clear" | "done" | "help";
  item: string;
  qty: number;
  id?: number;
} {
  const raw = args.trim();
  if (!raw) return { sub: "help", item: "", qty: 1 };

  const lower = raw.toLowerCase();
  if (lower === "list" || lower === "ls") return { sub: "list", item: "", qty: 1 };
  if (lower === "clear" || lower === "reset") return { sub: "clear", item: "", qty: 1 };
  if (lower === "help" || lower === "?") return { sub: "help", item: "", qty: 1 };

  const done = raw.match(/^(?:done|rm|del|delete|remove)\s+(\d+)\s*$/i);
  if (done) return { sub: "done", item: "", qty: 1, id: Number(done[1]) };

  // qty:N or xN or ×N at end
  let qty = 1;
  let item = raw;
  const qtyFlag = item.match(/\s+qty:(\d+)\s*$/i);
  if (qtyFlag) {
    qty = Math.max(1, parseInt(qtyFlag[1]!, 10) || 1);
    item = item.slice(0, qtyFlag.index).trim();
  } else {
    const xFlag = item.match(/\s+[x×](\d+)\s*$/i);
    if (xFlag) {
      qty = Math.max(1, parseInt(xFlag[1]!, 10) || 1);
      item = item.slice(0, xFlag.index).trim();
    }
  }
  if (!item) return { sub: "help", item: "", qty: 1 };
  return { sub: "add", item, qty };
}
