/**
 * !workorder / !work-items handlers — org shopping-list work orders.
 */
import { blueprintToBom, getScCraftClient, type ScCraftClient } from "./sc-craft.js";
import {
  aggregateWorkOrders,
  formatMaterialList,
  getWorkOrderStore,
  parseWorkOrderArgs,
  scaleBom,
  type WorkOrderStore,
} from "./work-orders.js";

export async function handleWorkOrderCommand(
  args: string,
  prefix = "!",
  deps: {
    store?: WorkOrderStore | null;
    scCraft?: ScCraftClient;
    invokerUid?: string | null;
    /**
     * When set, clear-all requires this to return true (rights token
     * `workorder.clear` / admin). Matches dashboard admin-only clear.
     * Omit or always-true when rights are off (fail-open).
     */
    canClear?: () => boolean;
  } = {},
): Promise<string> {
  const store = deps.store ?? getWorkOrderStore();
  if (!store) {
    return "Work orders unavailable (bot DB not ready).";
  }
  const scCraft = deps.scCraft ?? getScCraftClient();
  const parsed = parseWorkOrderArgs(args);

  if (parsed.sub === "help") {
    return [
      `${prefix}workorder <item> xN — save a craft shopping list (e.g. ${prefix}workorder P4-AR x3)`,
      `${prefix}work-items — org totals from open work orders`,
      `${prefix}workorder list · ${prefix}workorder done <id>`,
      `${prefix}workorder clear — wipe board (admin / workorder.clear)`,
    ].join("\n");
  }

  if (parsed.sub === "list") {
    const orders = store.list();
    if (orders.length === 0) return "No open work orders.";
    const lines = orders.map(
      (o) => `#${o.id} ${o.qty}× ${o.itemName} — ${formatMaterialList(o.lines)}`,
    );
    return ["Open work orders:", ...lines, "", `Totals: ${prefix}work-items`].join("\n");
  }

  if (parsed.sub === "clear") {
    if (deps.canClear && !deps.canClear()) {
      return "Clear all work orders requires admin (rights: workorder.clear). Use done <id> for one.";
    }
    const n = store.clear();
    return n === 0 ? "No work orders to clear." : `Cleared ${n} work order(s).`;
  }

  if (parsed.sub === "done") {
    const id = parsed.id!;
    if (!store.remove(id)) return `No work order #${id}.`;
    return `Removed work order #${id}.`;
  }

  // add
  if (!scCraft.isEnabled()) {
    return "Craft lookup disabled (ECONOMY_SCCRAFT=0) — can't resolve work orders.";
  }
  const bp = await scCraft.resolveBlueprint(parsed.item);
  if (!bp) {
    return `No blueprint match for "${parsed.item}". Try ${prefix}econ blueprints <name>.`;
  }
  const unitLines = blueprintToBom(bp, 1).map((l) => ({
    material: l.label,
    amount: l.amount,
    unit: "SCU",
  }));
  if (unitLines.length === 0) {
    return `Blueprint "${bp.name}" has no materials listed.`;
  }
  const scaled = scaleBom(unitLines, parsed.qty);
  const order = store.add({
    itemName: bp.name,
    qty: parsed.qty,
    lines: scaled,
    createdBy: deps.invokerUid ?? null,
  });

  // Mockup tone: short shopping list + saved
  return [
    `Okay — ${parsed.qty}× ${bp.name} takes ${formatMaterialList(scaled)}. Saved as work order #${order.id}.`,
    `Org totals: ${prefix}work-items`,
  ].join("\n");
}

export function handleWorkItemsCommand(prefix = "!", store?: WorkOrderStore | null): string {
  const s = store ?? getWorkOrderStore();
  if (!s) return "Work orders unavailable (bot DB not ready).";
  const orders = s.list();
  if (orders.length === 0) {
    return `Nothing on the board. Add with ${prefix}workorder <item> xN.`;
  }
  const needs = aggregateWorkOrders(orders);
  const n = orders.length;
  return [
    `The org needs ${formatMaterialList(needs)}.`,
    `(${n} open work order${n === 1 ? "" : "s"} — ${prefix}workorder list)`,
  ].join("\n");
}
