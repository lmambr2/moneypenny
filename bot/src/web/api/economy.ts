/**
 * Dashboard economy API — structured JSON over the same data as TS chat commands.
 * Auth required (global /api gate). Work-order mutations for all members.
 *
 * Security notes (see docs/security-audit-economy-2026-07-09.md):
 *  - Rate-limit network-proxy routes (external APIs / paid trade token).
 *  - Cap open work orders + location filter arrays.
 *  - Never return absolute cache filesystem paths.
 *  - Cache refresh is single-flight process-wide.
 */
import { Router } from "express";
import type { AuditStore } from "../../data/audit.js";
import { boxSummary, largestCrateThatFits } from "../../economy/boxes.js";
import { type RefreshReport, runEconomyCacheRefresh } from "../../economy/cache/refresh.js";
import { cacheRootLabel, getEconomyDiskCache } from "../../economy/cache/store.js";
import {
  CATALOG_AS_OF,
  CATALOG_DISCLAIMER,
  CATALOG_SOURCES,
  ORES,
  REFINE_METHODS,
} from "../../economy/catalog.js";
import { fuzzyRank } from "../../economy/fuzzy.js";
import { isUnstableMaterial } from "../../economy/material-flags.js";
import { buildMineOrder, buildRefineOrder, isOrderError } from "../../economy/orders.js";
import { blueprintToBom, getScCraftClient, type ScCraftClient } from "../../economy/sc-craft.js";
import { getScTradeClient, type ScTradeClient } from "../../economy/sc-trade.js";
import { getUexClient, type UexClient } from "../../economy/uex.js";
import {
  aggregateWorkOrders,
  getWorkOrderStore,
  materialWithBoxes,
  scaleBom,
  type WorkOrderStore,
} from "../../economy/work-orders.js";
import type { Logger } from "../../logger.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

/** Max simultaneous open work orders (DoS / SQLite growth bound). */
export const MAX_OPEN_WORK_ORDERS = 100;
/** Max location filter strings per trade request. */
const MAX_LOC_FILTERS = 8;

export interface EconomyApiDeps {
  store?: WorkOrderStore | null;
  scCraft?: ScCraftClient;
  scTrade?: ScTradeClient;
  uex?: UexClient;
  logger?: Logger;
  /** Audit trail for destructive/expensive ops (clear-all, cache refresh). */
  audit?: AuditStore;
  /** Inject refresh for tests (avoids network). */
  refresh?: () => Promise<RefreshReport>;
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : Number.NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function str(v: unknown, max = 200): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

/** Cap + sanitize location filter list from body/query. */
function parseLocFilters(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const out = raw
      .slice(0, MAX_LOC_FILTERS)
      .map((x) => str(x, 80))
      .filter(Boolean);
    return out.length ? out : undefined;
  }
  const s = str(raw, 80);
  return s ? [s] : undefined;
}

function storeOrNull(deps: EconomyApiDeps): WorkOrderStore | null {
  if (deps.store !== undefined) return deps.store;
  return getWorkOrderStore();
}

function serializeOrder(o: {
  id: number;
  itemName: string;
  qty: number;
  lines: Array<{ material: string; amount: number; unit: string }>;
  createdBy: string | null;
  createdAt: number;
}) {
  return {
    id: o.id,
    itemName: o.itemName,
    qty: o.qty,
    lines: o.lines.map((l) => {
      const boxes = materialWithBoxes(l);
      return {
        material: l.material,
        amount: l.amount,
        unit: l.unit || "SCU",
        unstable: isUnstableMaterial(l.material),
        boxes: boxes.boxes,
        totalBoxes: boxes.totalBoxes,
        largestCrate: boxes.largestCrate,
      };
    }),
    createdBy: o.createdBy,
    createdAt: o.createdAt,
  };
}

export function createEconomyRouter(deps: EconomyApiDeps = {}): Router {
  const router = Router();
  const scCraft = () => deps.scCraft ?? getScCraftClient(deps.logger);
  const scTrade = () => deps.scTrade ?? getScTradeClient(deps.logger);
  const uex = () => deps.uex ?? getUexClient(deps.logger);

  // Key limits by session user, not IP — multiple users behind one LAN NAT
  // must not share buckets (audit follow-up). All routes sit behind requireAuth.
  const userKey = (req: { user?: { id: string }; ip?: string }) =>
    req.user?.id ?? req.ip ?? "unknown";

  // External / paid / multi-source network proxies — tighter than local seed calculators.
  const networkLimit = createRateLimit({
    capacity: 20,
    refillPerSec: 1,
    keyFn: userKey,
    message: (waitSec) => `Economy network lookup rate limited. Please wait ${waitSec}s.`,
  });
  // Trade tools hit paid sc-trade token quota and can run 30–45s.
  const tradeLimit = createRateLimit({
    capacity: 8,
    refillPerSec: 0.25,
    keyFn: userKey,
    message: (waitSec) => `Trade lookup rate limited (protects API token quota). Wait ${waitSec}s.`,
  });
  // Full catalog refresh is heavy; keep rare.
  const refreshLimit = createRateLimit({
    capacity: 2,
    refillPerSec: 1 / 60,
    keyFn: userKey,
    message: (waitSec) => `Cache refresh rate limited. Please wait ${waitSec}s.`,
  });
  // Work-order mutations (add / clear) — stop fill spam.
  const mutateLimit = createRateLimit({
    capacity: 30,
    refillPerSec: 2,
    keyFn: userKey,
    message: (waitSec) => `Work-order actions rate limited. Please wait ${waitSec}s.`,
  });

  // ── Overview / catalog ───────────────────────────────────────────────────
  router.get("/overview", (_req, res) => {
    const craft = scCraft();
    const trade = scTrade();
    const prices = uex();
    const disk = getEconomyDiskCache();
    const stats = disk.stats();
    const store = storeOrNull(deps);
    res.json({
      catalogAsOf: CATALOG_AS_OF,
      disclaimer: CATALOG_DISCLAIMER,
      sources: [...CATALOG_SOURCES],
      clients: {
        scCraft: craft.isEnabled(),
        scTrade: trade.isEnabled(),
        /** Whether a trade token is configured (boolean only — never the secret). */
        scTradeToken: trade.hasToken(),
        uex: prices.isEnabled(),
      },
      cache: {
        rootLabel: cacheRootLabel(stats.root),
        backend: stats.backend ?? "sqlite",
        totalFiles: stats.totalFiles,
        totalBytes: stats.totalBytes,
        sources: stats.sources,
      },
      workOrders: {
        available: !!store,
        open: store?.list().length ?? 0,
        maxOpen: MAX_OPEN_WORK_ORDERS,
      },
      oreCount: ORES.length,
      methodCount: REFINE_METHODS.length,
    });
  });

  router.get("/ores", (req, res) => {
    const q = str(req.query.q, 80);
    let list = ORES.map((o) => ({
      id: o.id,
      name: o.name,
      aliases: o.aliases,
      rarity: o.rarity,
      valueTier: o.valueTier,
      stability: o.stability,
      refineWithinMin: o.refineWithinMin,
      mode: o.mode,
      resistance: o.resistance,
      instability: o.instability,
      optimalWindow: o.optimalWindow,
      explosive: o.explosive,
      valueScuApprox: o.valueScuApprox,
      defaultMethod: o.defaultMethod,
      locationsHint: o.locationsHint,
      notes: o.notes,
      unstable: o.stability === "volatile" || o.stability === "critical",
    }));
    if (q) {
      const ql = q.toLowerCase();
      const substring = list.filter(
        (o) =>
          o.id.includes(ql) ||
          o.name.toLowerCase().includes(ql) ||
          o.aliases.some((a) => a.toLowerCase().includes(ql)),
      );
      if (substring.length > 0) {
        list = substring;
      } else {
        // E-FUZZY when substring empty
        list = fuzzyRank(q, list, (o) => [o.name, o.id, ...o.aliases], {
          minQueryLen: 3,
          limit: 40,
        }).map((r) => r.item);
      }
    }
    res.json({ ores: list, asOf: CATALOG_AS_OF });
  });

  /** E-BOX / E-FOOT pure helper for dashboard / clients. */
  router.get("/boxes", (req, res) => {
    const scuRaw = req.query.scu;
    const scu =
      typeof scuRaw === "string" || typeof scuRaw === "number" ? Number(scuRaw) : Number.NaN;
    if (!Number.isFinite(scu) || scu < 0) {
      res.status(400).json({ error: "scu required (non-negative number)" });
      return;
    }
    const maxBox = clampInt(req.query.maxBox ?? req.query.box, 0, 10_000, 0);
    const summary = boxSummary(scu);
    res.json({
      ...summary,
      maxBoxSizeInScu: maxBox || null,
      largestCrateThatFits: maxBox ? largestCrateThatFits(maxBox) : null,
      fitsShip: maxBox > 0 ? summary.largestCrate <= maxBox || summary.scu === 0 : null,
    });
  });

  router.get("/methods", (_req, res) => {
    res.json({
      methods: REFINE_METHODS.map((m) => ({
        id: m.id,
        name: m.name,
        aliases: m.aliases,
        yieldRate: m.yieldRate,
        yieldPct: Math.round(m.yieldRate * 100),
        timeMult: m.timeMult,
        costMult: m.costMult,
        notes: m.notes,
      })),
    });
  });

  // ── Mine / refine (seed calculators — local only) ────────────────────────
  router.get("/mine", (req, res) => {
    const ore = str(req.query.ore ?? req.query.q, 80);
    if (!ore) {
      res.status(400).json({ error: "ore query required (e.g. ?ore=quantainium&scu=32)" });
      return;
    }
    const scu = clampInt(req.query.scu, 1, 10_000, 32);
    const method = str(req.query.method, 80) || undefined;
    const order = buildMineOrder(ore, scu, method);
    if (isOrderError(order)) {
      res.status(404).json({ error: order.error });
      return;
    }
    res.json({
      ore: {
        id: order.ore.id,
        name: order.ore.name,
        stability: order.ore.stability,
        refineWithinMin: order.ore.refineWithinMin,
        mode: order.ore.mode,
        valueScuApprox: order.ore.valueScuApprox,
        unstable: order.ore.stability === "volatile" || order.ore.stability === "critical",
      },
      targetScu: order.targetScu,
      stabilityLine: order.stabilityLine,
      suggestedMethod: {
        id: order.suggestedMethod.id,
        name: order.suggestedMethod.name,
        yieldRate: order.suggestedMethod.yieldRate,
        yieldPct: Math.round(order.suggestedMethod.yieldRate * 100),
      },
    });
  });

  router.get("/refine", (req, res) => {
    const ore = str(req.query.ore ?? req.query.q, 80);
    if (!ore) {
      res
        .status(400)
        .json({ error: "ore query required (e.g. ?ore=quantainium&scu=32&method=dinyx)" });
      return;
    }
    const scu = clampInt(req.query.scu, 1, 10_000, 32);
    const method = str(req.query.method, 80) || undefined;
    const order = buildRefineOrder(ore, scu, method);
    if (isOrderError(order)) {
      res.status(404).json({ error: order.error });
      return;
    }
    res.json({
      ore: {
        id: order.ore.id,
        name: order.ore.name,
        stability: order.ore.stability,
        unstable: order.ore.stability === "volatile" || order.ore.stability === "critical",
      },
      method: {
        id: order.method.id,
        name: order.method.name,
        yieldRate: order.method.yieldRate,
        yieldPct: Math.round(order.method.yieldRate * 100),
      },
      inputScu: order.inputScu,
      outputScu: order.outputScu,
    });
  });

  // ── Craft / blueprints (sc-craft) ────────────────────────────────────────
  router.get("/blueprints", networkLimit, async (req, res) => {
    const q = str(req.query.q, 120);
    if (!q) {
      res.status(400).json({ error: "q required (in-game blueprint name)" });
      return;
    }
    const craft = scCraft();
    if (!craft.isEnabled()) {
      res.status(503).json({ error: "sc-craft disabled (ECONOMY_SCCRAFT=0)" });
      return;
    }
    const limit = clampInt(req.query.limit, 1, 24, 8);
    try {
      const result = await craft.search(q, limit);
      if (!result) {
        res.status(502).json({ error: "sc-craft unreachable or no results" });
        return;
      }
      res.json({
        items: result.items.map((bp) => ({
          id: bp.id,
          blueprintId: bp.blueprint_id ?? null,
          name: bp.name,
          category: bp.category ?? null,
          craftTimeSeconds: bp.craft_time_seconds ?? null,
          version: bp.version ?? null,
          ingredientCount: bp.ingredients?.length ?? 0,
        })),
        total: result.total,
        attribution: result.attribution,
      });
    } catch (err) {
      deps.logger?.warn({ err }, "economy blueprints failed");
      res.status(502).json({ error: "sc-craft lookup failed" });
    }
  });

  router.get("/craft", networkLimit, async (req, res) => {
    const q = str(req.query.q ?? req.query.item, 120);
    if (!q) {
      res.status(400).json({ error: "q required (e.g. ?q=P4-AR&qty=1)" });
      return;
    }
    const qty = clampInt(req.query.qty, 1, 999, 1);
    const craft = scCraft();
    if (!craft.isEnabled()) {
      res.status(503).json({ error: "sc-craft disabled (ECONOMY_SCCRAFT=0)" });
      return;
    }
    try {
      const bp = await craft.resolveBlueprint(q);
      if (!bp) {
        res.status(404).json({ error: "No blueprint match for that name" });
        return;
      }
      const bom = blueprintToBom(bp, qty).map((l) => ({
        material: l.label,
        materialId: l.materialId,
        amount: l.amount,
        unit: l.unit === "ea" ? "ea" : "SCU",
        unstable: isUnstableMaterial(l.label),
      }));
      res.json({
        blueprint: {
          id: bp.id,
          blueprintId: bp.blueprint_id ?? null,
          name: bp.name,
          category: bp.category ?? null,
          craftTimeSeconds: bp.craft_time_seconds ?? null,
        },
        qty,
        bom,
        attribution: "Blueprints via SC Craft Tools (sc-craft.tools) — cached. Fan data, not CIG.",
      });
    } catch (err) {
      deps.logger?.warn({ err }, "economy craft failed");
      res.status(502).json({ error: "craft lookup failed" });
    }
  });

  // ── Prices (UEX) ─────────────────────────────────────────────────────────
  /** Full commodity catalog for the Prices tab dropdown (cached UEX list). */
  router.get("/commodities", networkLimit, async (_req, res) => {
    const client = uex();
    if (!client.isEnabled()) {
      res.status(503).json({ error: "UEX disabled (ECONOMY_UEX=0)" });
      return;
    }
    try {
      const list = await client.getCommodities();
      if (!list) {
        res.status(502).json({ error: "UEX commodities unavailable" });
        return;
      }
      const commodities = list
        .map((c) => ({
          id: c.id,
          name: c.name,
          code: c.code ?? "",
          sell: c.price_sell && c.price_sell > 0 ? c.price_sell : null,
          buy: c.price_buy && c.price_buy > 0 ? c.price_buy : null,
          isRaw: !!c.is_raw,
        }))
        .filter((c) => c.name)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      res.json({
        commodities,
        count: commodities.length,
        attribution: "Prices/commodity flags via UEX Corp API (uexcorp.space) — cached.",
      });
    } catch (err) {
      deps.logger?.warn({ err }, "economy commodities list failed");
      res.status(502).json({ error: "commodities list failed" });
    }
  });

  router.get("/prices", networkLimit, async (req, res) => {
    const q = str(req.query.q ?? req.query.commodity, 120);
    if (!q) {
      res.status(400).json({ error: "q required (commodity name)" });
      return;
    }
    const client = uex();
    if (!client.isEnabled()) {
      res.status(503).json({ error: "UEX disabled (ECONOMY_UEX=0)" });
      return;
    }
    try {
      const snap = await client.lookupPrice(q);
      if (!snap) {
        res.status(404).json({ error: "No UEX price match for that commodity" });
        return;
      }
      res.json({
        commodity: {
          id: snap.commodity.id,
          name: snap.commodity.name,
          code: snap.commodity.code,
        },
        sell: snap.sell,
        buy: snap.buy,
        matchCount: snap.matches.length,
        matches: snap.matches.slice(0, 8).map((m) => ({
          name: m.name,
          code: m.code,
          sell: m.price_sell ?? null,
          buy: m.price_buy ?? null,
          isRaw: !!m.is_raw,
        })),
        supply: snap.supply
          ? {
              supplyPct: snap.supply.supplyPct,
              sampleSize: snap.supply.sampleSize,
              sellTerminals: snap.supply.sellTerminals.slice(0, 5),
              buyTerminals: snap.supply.buyTerminals.slice(0, 5),
            }
          : null,
        fetchedAt: snap.fetchedAt,
        attribution: snap.attribution,
      });
    } catch (err) {
      deps.logger?.warn({ err }, "economy prices failed");
      res.status(502).json({ error: "price lookup failed" });
    }
  });

  // ── Work orders ──────────────────────────────────────────────────────────
  router.get("/workorders", (_req, res) => {
    const store = storeOrNull(deps);
    if (!store) {
      res.status(503).json({ error: "Work orders unavailable (bot DB not ready)" });
      return;
    }
    const orders = store.list();
    const materials = aggregateWorkOrders(orders).map((m) => {
      const boxes = materialWithBoxes(m);
      return {
        material: m.material,
        amount: m.amount,
        unit: m.unit || "SCU",
        unstable: isUnstableMaterial(m.material),
        boxes: boxes.boxes,
        totalBoxes: boxes.totalBoxes,
        largestCrate: boxes.largestCrate,
      };
    });
    res.json({
      orders: orders.map(serializeOrder),
      materials,
      open: orders.length,
      maxOpen: MAX_OPEN_WORK_ORDERS,
    });
  });

  router.post("/workorders", mutateLimit, networkLimit, async (req, res) => {
    const store = storeOrNull(deps);
    if (!store) {
      res.status(503).json({ error: "Work orders unavailable (bot DB not ready)" });
      return;
    }
    const open = store.list().length;
    if (open >= MAX_OPEN_WORK_ORDERS) {
      res.status(429).json({
        error: `Too many open work orders (max ${MAX_OPEN_WORK_ORDERS}). Mark some done first.`,
        code: "WORK_ORDER_CAP",
        maxOpen: MAX_OPEN_WORK_ORDERS,
      });
      return;
    }
    const item = str(req.body?.item ?? req.body?.q ?? req.body?.name, 200);
    const qty = clampInt(req.body?.qty, 1, 999, 1);
    if (!item) {
      res.status(400).json({ error: "item required (in-game blueprint name)" });
      return;
    }
    const craft = scCraft();
    if (!craft.isEnabled()) {
      res.status(503).json({ error: "sc-craft disabled — can't resolve work orders" });
      return;
    }
    try {
      const bp = await craft.resolveBlueprint(item);
      if (!bp) {
        res.status(404).json({ error: "No blueprint match for that name" });
        return;
      }
      const unitLines = blueprintToBom(bp, 1).map((l) => ({
        material: l.label,
        amount: l.amount,
        unit: "SCU",
      }));
      if (unitLines.length === 0) {
        res.status(422).json({ error: "Blueprint has no materials listed" });
        return;
      }
      const scaled = scaleBom(unitLines, qty);
      const createdBy =
        typeof req.user?.username === "string" ? req.user.username : (req.user?.id ?? null);
      const order = store.add({
        itemName: bp.name,
        qty,
        lines: scaled,
        createdBy: createdBy != null ? String(createdBy).slice(0, 120) : null,
      });
      res.status(201).json({ order: serializeOrder(order) });
    } catch (err) {
      deps.logger?.warn({ err }, "economy workorder create failed");
      res.status(502).json({ error: "work order create failed" });
    }
  });

  router.delete("/workorders/:id", mutateLimit, (req, res) => {
    const store = storeOrNull(deps);
    if (!store) {
      res.status(503).json({ error: "Work orders unavailable (bot DB not ready)" });
      return;
    }
    const id = clampInt(req.params.id, 1, 1_000_000_000, 0);
    if (!id) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    if (!store.remove(id)) {
      res.status(404).json({ error: `No work order #${id}` });
      return;
    }
    res.json({ ok: true, removed: id });
  });

  // Clear-all is destructive — admin only (web). TS uses rights token workorder.clear.
  router.delete("/workorders", requireAdmin, mutateLimit, (req, res) => {
    const store = storeOrNull(deps);
    if (!store) {
      res.status(503).json({ error: "Work orders unavailable (bot DB not ready)" });
      return;
    }
    const n = store.clear();
    deps.audit?.record({
      actorId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      targetUserId: null,
      targetUsername: `${n} orders`,
      action: "economy.workorders_clear",
    });
    res.json({ ok: true, cleared: n });
  });

  // ── Trade ────────────────────────────────────────────────────────────────
  router.get("/trade/ships", networkLimit, async (req, res) => {
    const trade = scTrade();
    if (!trade.isEnabled()) {
      res.status(503).json({ error: "sc-trade disabled (ECONOMY_SCTRADE=0)" });
      return;
    }
    try {
      const ships = await trade.getShips();
      if (!ships) {
        res.status(502).json({ error: "Could not load ships from sc-trade" });
        return;
      }
      const q = str(req.query.q, 80).toLowerCase();
      const filtered = q ? ships.filter((s) => (s.name || "").toLowerCase().includes(q)) : ships;
      res.json({
        ships: filtered.slice(0, 100).map((s) => ({
          name: s.name,
          maxBoxSizeInScu: s.maxBoxSizeInScu ?? null,
        })),
        total: filtered.length,
        attribution:
          "Trade data via SC Trade Tools (sc-trade.tools) — community reports, cached. Not CIG.",
      });
    } catch (err) {
      deps.logger?.warn({ err }, "economy trade ships failed");
      res.status(502).json({ error: "ship catalog lookup failed" });
    }
  });

  router.post("/trade/routes", tradeLimit, async (req, res) => {
    const trade = scTrade();
    if (!trade.isEnabled()) {
      res.status(503).json({ error: "sc-trade disabled (ECONOMY_SCTRADE=0)" });
      return;
    }
    const body = req.body ?? {};
    const ship = str(body.ship, 80) || "Freelancer";
    const investment = clampInt(body.invest ?? body.investment, 1_000, 500_000_000, 100_000);
    const maxStops = clampInt(body.stops ?? body.maxStops, 1, 8, 2);
    const profitType = body.profit === "pure" || body.profitType === "pure" ? "pure" : "time";
    const locationInclude = parseLocFilters(body.loc ?? body.location);
    const box = body.box != null ? clampInt(body.box, 1, 1000, 0) || undefined : undefined;

    try {
      let shipName = ship;
      let shipBox = box;
      const resolved = await trade.resolveShip(ship);
      if (resolved) {
        shipName = resolved.name;
        if (shipBox == null && resolved.maxBoxSizeInScu) {
          shipBox = resolved.maxBoxSizeInScu;
        }
      }

      const result = await trade.findTrades({
        ship: shipName,
        investment,
        maxStops,
        profitType,
        supportedBoxSizeInScu: shipBox,
        locationInclude,
        maxResults: clampInt(body.limit, 1, 15, 5),
      });
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }
      res.json({
        ship: shipName,
        invest: investment,
        profitType,
        routes: result.routes,
        attribution: result.attribution,
      });
    } catch (err) {
      deps.logger?.warn({ err }, "economy trade routes failed");
      res.status(502).json({ error: "trade route lookup failed" });
    }
  });

  router.post("/trade/buyers", tradeLimit, async (req, res) => {
    const trade = scTrade();
    if (!trade.isEnabled()) {
      res.status(503).json({ error: "sc-trade disabled (ECONOMY_SCTRADE=0)" });
      return;
    }
    const body = req.body ?? {};
    const commodity = str(body.commodity ?? body.q ?? body.item, 120);
    if (!commodity) {
      res.status(400).json({ error: "commodity required" });
      return;
    }
    const scu = clampInt(body.scu, 1, 10_000, 32);
    const locationInclude = parseLocFilters(body.loc ?? body.location);
    try {
      const result = await trade.findBuyers({
        commodityName: commodity,
        commodityQuantityInScu: scu,
        supportedBoxSizeInScu:
          body.box != null ? clampInt(body.box, 1, 1000, 0) || undefined : undefined,
        locationInclude,
        maxResults: clampInt(body.limit, 1, 20, 8),
      });
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }
      res.json({
        commodity,
        scu,
        buyers: result.buyers,
        attribution: result.attribution,
      });
    } catch (err) {
      deps.logger?.warn({ err }, "economy trade buyers failed");
      res.status(502).json({ error: "buyer lookup failed" });
    }
  });

  router.post("/trade/itinerary", tradeLimit, async (req, res) => {
    const trade = scTrade();
    if (!trade.isEnabled()) {
      res.status(503).json({ error: "sc-trade disabled (ECONOMY_SCTRADE=0)" });
      return;
    }
    const body = req.body ?? {};
    const from = str(body.from ?? body.origin, 300);
    const to = str(body.to ?? body.destination, 300);
    if (!from || !to) {
      res.status(400).json({
        error: "from and to shop paths required (sc-trade names; use > separators)",
      });
      return;
    }
    const ship = str(body.ship, 80) || "Freelancer";
    const investment = clampInt(body.invest ?? body.investment, 1_000, 500_000_000, 100_000);
    const maxStops = clampInt(body.stops ?? body.maxStops, 1, 8, 3);
    const profitType = body.profit === "pure" || body.profitType === "pure" ? "pure" : "time";
    const locationInclude = parseLocFilters(body.loc ?? body.location);
    const detour = body.detour != null ? clampInt(body.detour, 0, 100, 0) || undefined : undefined;
    try {
      let shipName = ship;
      let shipBox = body.box != null ? clampInt(body.box, 1, 1000, 0) || undefined : undefined;
      const resolved = await trade.resolveShip(ship);
      if (resolved) {
        shipName = resolved.name;
        if (shipBox == null && resolved.maxBoxSizeInScu) shipBox = resolved.maxBoxSizeInScu;
      }
      const result = await trade.findItinerary({
        ship: shipName,
        investment,
        origin: from,
        destination: to,
        maxStops,
        profitType,
        supportedBoxSizeInScu: shipBox,
        locationInclude,
        allowableDetour: detour,
        maxResults: clampInt(body.limit, 1, 15, 5),
      });
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }
      res.json({
        ship: shipName,
        invest: investment,
        from,
        to,
        profitType,
        routes: result.routes,
        attribution: result.attribution,
      });
    } catch (err) {
      deps.logger?.warn({ err }, "economy trade itinerary failed");
      res.status(502).json({ error: "itinerary lookup failed" });
    }
  });

  router.post("/trade/circuit", tradeLimit, async (req, res) => {
    const trade = scTrade();
    if (!trade.isEnabled()) {
      res.status(503).json({ error: "sc-trade disabled (ECONOMY_SCTRADE=0)" });
      return;
    }
    const body = req.body ?? {};
    const tradeId = clampInt(body.id ?? body.tradeId, 1, 1_000_000_000, 0);
    if (!tradeId) {
      res.status(400).json({ error: "id required (trade route id from routes results)" });
      return;
    }
    const ship = str(body.ship, 80) || "Freelancer";
    const investment = clampInt(body.invest ?? body.investment, 1_000, 500_000_000, 100_000);
    const maxStops = clampInt(body.stops ?? body.maxStops, 1, 8, 2);
    const profitType = body.profit === "pure" || body.profitType === "pure" ? "pure" : "time";
    const locationInclude = parseLocFilters(body.loc ?? body.location);
    try {
      let shipName = ship;
      let shipBox = body.box != null ? clampInt(body.box, 1, 1000, 0) || undefined : undefined;
      const resolved = await trade.resolveShip(ship);
      if (resolved) {
        shipName = resolved.name;
        if (shipBox == null && resolved.maxBoxSizeInScu) shipBox = resolved.maxBoxSizeInScu;
      }
      const result = await trade.findCircuit(tradeId, {
        ship: shipName,
        investment,
        maxStops,
        profitType,
        supportedBoxSizeInScu: shipBox,
        locationInclude,
        maxResults: clampInt(body.limit, 1, 15, 5),
      });
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }
      res.json({
        tradeId,
        ship: shipName,
        invest: investment,
        profitType,
        routes: result.routes,
        attribution: result.attribution,
      });
    } catch (err) {
      deps.logger?.warn({ err }, "economy trade circuit failed");
      res.status(502).json({ error: "circuit lookup failed" });
    }
  });

  // ── Cache ────────────────────────────────────────────────────────────────
  router.get("/cache", (_req, res) => {
    const disk = getEconomyDiskCache();
    const stats = disk.stats();
    const last = disk.get<{ at: number; results: RefreshReport["results"] }>(
      "meta",
      "last-refresh",
    );
    res.json({
      rootLabel: cacheRootLabel(stats.root),
      backend: stats.backend ?? "sqlite",
      totalFiles: stats.totalFiles,
      totalBytes: stats.totalBytes,
      sources: stats.sources,
      lastRefresh: last?.data?.at
        ? {
            at: last.data.at,
            ageMin: Math.round((Date.now() - last.data.at) / 60_000),
            results: (last.data.results ?? []).slice(0, 20),
          }
        : null,
    });
  });

  // Refresh burns multi-source network; admin-only on web (TS !econ refresh still public).
  router.post("/cache/refresh", requireAdmin, refreshLimit, async (req, res) => {
    deps.audit?.record({
      actorId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      targetUserId: null,
      targetUsername: null,
      action: "economy.cache_refresh",
    });
    try {
      const report = deps.refresh
        ? await deps.refresh()
        : await runEconomyCacheRefresh({ logger: deps.logger });
      res.json({ ok: report.ok, at: report.at, results: report.results.slice(0, 30) });
    } catch (err) {
      deps.logger?.warn({ err }, "economy cache refresh via API failed");
      res.status(500).json({ error: "refresh failed" });
    }
  });

  return router;
}
