/**
 * Org-local terminal snapshots from the Linux datarunner.
 * Trusted ingest writes SQLite rows and feeds L2 cache source `local`.
 * !econ prices prefers local rows when captured_at is newer than UEX cache.
 */
import type Database from "better-sqlite3";
import { type EconomyDiskCache, getEconomyDiskCache } from "./cache/store.js";
import { fuzzyBestMatch, fuzzyScore } from "./fuzzy.js";

export const SNAPSHOT_TYPES = ["commodity", "item", "vehicle_buy", "vehicle_rent", "fuel"] as const;
export type SnapshotType = (typeof SNAPSHOT_TYPES)[number];

export const SNAPSHOT_ENVIRONMENTS = ["LIVE", "PTU"] as const;
export type SnapshotEnvironment = (typeof SNAPSHOT_ENVIRONMENTS)[number];

export const SNAPSHOT_STATUSES = ["pending", "accepted", "rejected"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export interface SnapshotPrice {
  id_commodity?: number | null;
  id_item?: number | null;
  id_vehicle?: number | null;
  name?: string | null;
  price_buy?: number | null;
  price_sell?: number | null;
  price_rent?: number | null;
  scu_buy?: number | null;
  scu_sell?: number | null;
  status_buy?: number | null;
  status_sell?: number | null;
  is_missing?: number | null;
  quality?: number | null;
}

export interface TerminalSnapshotInput {
  source?: string;
  game_version?: string;
  environment?: string;
  id_terminal?: number;
  terminal_name?: string | null;
  type?: string;
  prices?: SnapshotPrice[];
  screenshot_sha256?: string | null;
  captured_at?: number;
}

export interface StoredSnapshot {
  id: number;
  source: string;
  gameVersion: string;
  environment: SnapshotEnvironment;
  idTerminal: number;
  terminalName: string | null;
  type: SnapshotType;
  prices: SnapshotPrice[];
  screenshotSha256: string | null;
  capturedAt: number;
  receivedAt: number;
  status: SnapshotStatus;
  createdBy: string | null;
}

export interface LocalPriceOverlay {
  name: string;
  code: string;
  commodityId: number | null;
  sell: number | null;
  buy: number | null;
  capturedAt: number;
  terminalName: string | null;
  gameVersion: string;
  rows: Array<{
    id_commodity?: number;
    id_terminal?: number;
    commodity_name?: string;
    terminal_name?: string;
    price_buy?: number;
    price_sell?: number;
    scu_buy?: number;
    scu_sell?: number;
    status_buy?: number;
    status_sell?: number;
  }>;
  attribution: string;
}

export const LOCAL_SNAPSHOT_ATTRIBUTION =
  "Local terminal snapshot (org datarunner) — preferred over UEX when fresher.";

const MAX_PRICES = 200;
const SHA256_RE = /^[a-f0-9]{64}$/i;

export class IngestValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "IngestValidationError";
  }
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < min || i > max) return null;
  return i;
}

function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeCapturedAt(raw: unknown): number {
  const n = numOrNull(raw);
  if (n == null || n <= 0) return Date.now();
  // Seconds vs ms
  if (n < 1e12) return Math.round(n * 1000);
  return Math.round(n);
}

export function parseTerminalSnapshot(
  body: unknown,
): Omit<StoredSnapshot, "id" | "receivedAt" | "status" | "createdBy"> {
  if (!body || typeof body !== "object") {
    throw new IngestValidationError("JSON object required");
  }
  const b = body as TerminalSnapshotInput;
  const source = str(b.source, 64) || "datarunner";
  const gameVersion = str(b.game_version, 40) || "4.10.0";
  const envRaw = str(b.environment, 8).toUpperCase() || "LIVE";
  if (!SNAPSHOT_ENVIRONMENTS.includes(envRaw as SnapshotEnvironment)) {
    throw new IngestValidationError("environment must be LIVE or PTU");
  }
  const idTerminal = clampInt(b.id_terminal, 1, 1_000_000_000);
  if (!idTerminal) throw new IngestValidationError("id_terminal required (positive int)");
  const typeRaw = str(b.type, 32);
  if (!SNAPSHOT_TYPES.includes(typeRaw as SnapshotType)) {
    throw new IngestValidationError(`type must be one of ${SNAPSHOT_TYPES.join(", ")}`);
  }
  if (!Array.isArray(b.prices) || b.prices.length === 0) {
    throw new IngestValidationError("prices[] required (1–200 rows)");
  }
  if (b.prices.length > MAX_PRICES) {
    throw new IngestValidationError(`prices[] max ${MAX_PRICES}`);
  }
  const prices: SnapshotPrice[] = [];
  for (const row of b.prices) {
    if (!row || typeof row !== "object") continue;
    const name = str(row.name, 120) || null;
    const idCommodity = clampInt(row.id_commodity ?? undefined, 1, 1_000_000_000);
    const idItem = clampInt(row.id_item ?? undefined, 1, 1_000_000_000);
    const idVehicle = clampInt(row.id_vehicle ?? undefined, 1, 1_000_000_000);
    if (!name && !idCommodity && !idItem && !idVehicle) {
      throw new IngestValidationError("each price needs name or id_commodity/id_item/id_vehicle");
    }
    const statusBuy = clampInt(row.status_buy ?? undefined, 1, 7);
    const statusSell = clampInt(row.status_sell ?? undefined, 1, 7);
    prices.push({
      id_commodity: idCommodity,
      id_item: idItem,
      id_vehicle: idVehicle,
      name,
      price_buy: numOrNull(row.price_buy),
      price_sell: numOrNull(row.price_sell),
      price_rent: numOrNull(row.price_rent),
      scu_buy: numOrNull(row.scu_buy),
      scu_sell: numOrNull(row.scu_sell),
      status_buy: statusBuy,
      status_sell: statusSell,
      is_missing: clampInt(row.is_missing ?? undefined, 0, 1),
      quality: clampInt(row.quality ?? undefined, 0, 1000),
    });
  }
  if (prices.length === 0) {
    throw new IngestValidationError("no valid price rows");
  }
  let sha = str(b.screenshot_sha256, 64) || null;
  if (sha && !SHA256_RE.test(sha)) {
    throw new IngestValidationError("screenshot_sha256 must be 64 hex chars");
  }
  if (sha) sha = sha.toLowerCase();
  return {
    source,
    gameVersion,
    environment: envRaw as SnapshotEnvironment,
    idTerminal,
    terminalName: str(b.terminal_name, 160) || null,
    type: typeRaw as SnapshotType,
    prices,
    screenshotSha256: sha,
    capturedAt: normalizeCapturedAt(b.captured_at),
  };
}

export class IngestStore {
  private insertStmt: Database.Statement;
  private getStmt: Database.Statement;
  private listStmt: Database.Statement;
  private listAllAcceptedStmt: Database.Statement;
  private setStatusStmt: Database.Statement;
  private countAcceptedStmt: Database.Statement;
  private disk: EconomyDiskCache;

  constructor(db: Database.Database, disk?: EconomyDiskCache) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS economy_terminal_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        game_version TEXT NOT NULL,
        environment TEXT NOT NULL,
        id_terminal INTEGER NOT NULL,
        terminal_name TEXT,
        type TEXT NOT NULL,
        prices_json TEXT NOT NULL,
        screenshot_sha256 TEXT,
        captured_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_econ_snap_status ON economy_terminal_snapshots(status, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_econ_snap_term ON economy_terminal_snapshots(id_terminal, captured_at DESC);
    `);
    this.insertStmt = db.prepare(
      `INSERT INTO economy_terminal_snapshots (
         source, game_version, environment, id_terminal, terminal_name, type,
         prices_json, screenshot_sha256, captured_at, received_at, status, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM economy_terminal_snapshots WHERE id = ?`);
    this.listStmt = db.prepare(
      `SELECT * FROM economy_terminal_snapshots
       WHERE (? IS NULL OR status = ?)
       ORDER BY captured_at DESC, id DESC
       LIMIT ?`,
    );
    this.listAllAcceptedStmt = db.prepare(
      `SELECT * FROM economy_terminal_snapshots WHERE status = 'accepted' ORDER BY captured_at ASC`,
    );
    this.setStatusStmt = db.prepare(
      `UPDATE economy_terminal_snapshots SET status = ? WHERE id = ?`,
    );
    this.countAcceptedStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM economy_terminal_snapshots WHERE status = 'accepted'`,
    );
    this.disk = disk ?? getEconomyDiskCache();
  }

  add(
    parsed: Omit<StoredSnapshot, "id" | "receivedAt" | "status" | "createdBy">,
    opts: { createdBy?: string | null; status?: SnapshotStatus } = {},
  ): StoredSnapshot {
    const receivedAt = Date.now();
    const status = opts.status ?? "accepted";
    const info = this.insertStmt.run(
      parsed.source,
      parsed.gameVersion,
      parsed.environment,
      parsed.idTerminal,
      parsed.terminalName,
      parsed.type,
      JSON.stringify(parsed.prices),
      parsed.screenshotSha256,
      parsed.capturedAt,
      receivedAt,
      status,
      opts.createdBy ?? null,
    );
    const row: StoredSnapshot = {
      id: Number(info.lastInsertRowid),
      ...parsed,
      receivedAt,
      status,
      createdBy: opts.createdBy ?? null,
    };
    if (status === "accepted") this.rebuildLocalCache();
    return row;
  }

  get(id: number): StoredSnapshot | null {
    const row = this.getStmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  list(opts: { status?: SnapshotStatus; limit?: number } = {}): StoredSnapshot[] {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const status = opts.status ?? null;
    const rows = this.listStmt.all(status, status, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToSnapshot);
  }

  setStatus(id: number, status: SnapshotStatus): StoredSnapshot | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.setStatusStmt.run(status, id);
    this.rebuildLocalCache();
    return this.get(id);
  }

  hasAccepted(): boolean {
    const row = this.countAcceptedStmt.get() as { n: number };
    return (row?.n ?? 0) > 0;
  }

  accepted(): StoredSnapshot[] {
    const rows = this.listAllAcceptedStmt.all() as Array<Record<string, unknown>>;
    return rows.map(rowToSnapshot);
  }

  /**
   * Rebuild L2 `local` keys from all accepted snapshots.
   * Keyed by commodity id when present, else normalized name.
   */
  rebuildLocalCache(now = Date.now()): void {
    const byKey = new Map<string, { capturedAt: number; rows: LocalPriceOverlay["rows"] }>();
    for (const snap of this.accepted()) {
      for (const p of snap.prices) {
        const id = p.id_commodity && p.id_commodity > 0 ? p.id_commodity : null;
        const key = id != null ? `prices:${id}` : `name:${norm(p.name || "")}`;
        if (key.endsWith(":")) continue;
        const row = {
          id_commodity: id ?? undefined,
          id_terminal: snap.idTerminal,
          commodity_name: p.name ?? undefined,
          terminal_name: snap.terminalName ?? `terminal#${snap.idTerminal}`,
          price_buy: p.price_buy ?? undefined,
          price_sell: p.price_sell ?? undefined,
          scu_buy: p.scu_buy ?? undefined,
          scu_sell: p.scu_sell ?? undefined,
          status_buy: p.status_buy ?? undefined,
          status_sell: p.status_sell ?? undefined,
        };
        const prev = byKey.get(key);
        if (!prev) {
          byKey.set(key, { capturedAt: snap.capturedAt, rows: [row] });
          continue;
        }
        // Replace same-terminal row; keep others
        const filtered = prev.rows.filter((r) => r.id_terminal !== snap.idTerminal);
        filtered.push(row);
        byKey.set(key, {
          capturedAt: Math.max(prev.capturedAt, snap.capturedAt),
          rows: filtered,
        });
      }
    }
    this.disk.clear("local");
    const ttl = 30 * 24 * 3600_000;
    for (const [key, val] of byKey) {
      this.disk.set("local", key, val, ttl, now);
    }
  }

  lookupOverlay(query: string): LocalPriceOverlay | null {
    const q = query.trim();
    if (!q) return null;
    const accepted = this.accepted();
    if (accepted.length === 0) return null;

    type Cand = { snap: StoredSnapshot; price: SnapshotPrice; score: number };
    const cands: Cand[] = [];
    for (const snap of accepted) {
      for (const price of snap.prices) {
        const labels = [price.name || "", String(price.id_commodity ?? "")];
        const score = Math.max(
          fuzzyScore(q, price.name || "", labels, { minQueryLen: 2 }),
          norm(price.name || "") === norm(q) ? 100 : 0,
          (price.name || "").toLowerCase().includes(q.toLowerCase()) ? 80 : 0,
        );
        if (score >= 50) cands.push({ snap, price, score });
      }
    }
    if (cands.length === 0) {
      const names = accepted.flatMap((s) => s.prices.map((p) => p.name || "")).filter(Boolean);
      const hit = fuzzyBestMatch(q, names, (n) => [n], { minScore: 50, minQueryLen: 3 });
      if (!hit) return null;
      for (const snap of accepted) {
        for (const price of snap.prices) {
          if (norm(price.name || "") === norm(hit)) cands.push({ snap, price, score: 60 });
        }
      }
    }
    if (cands.length === 0) return null;
    cands.sort((a, b) => b.score - a.score || b.snap.capturedAt - a.snap.capturedAt);
    const best = cands[0]!;
    const id = best.price.id_commodity ?? null;
    const matching = cands.filter((c) =>
      id != null
        ? c.price.id_commodity === id
        : norm(c.price.name || "") === norm(best.price.name || ""),
    );
    const rows: LocalPriceOverlay["rows"] = matching.map((c) => ({
      id_commodity: c.price.id_commodity ?? undefined,
      id_terminal: c.snap.idTerminal,
      commodity_name: c.price.name ?? undefined,
      terminal_name: c.snap.terminalName ?? `terminal#${c.snap.idTerminal}`,
      price_buy: c.price.price_buy ?? undefined,
      price_sell: c.price.price_sell ?? undefined,
      scu_buy: c.price.scu_buy ?? undefined,
      scu_sell: c.price.scu_sell ?? undefined,
      status_buy: c.price.status_buy ?? undefined,
      status_sell: c.price.status_sell ?? undefined,
    }));
    const sells = rows.map((r) => r.price_sell ?? 0).filter((n) => n > 0);
    const buys = rows.map((r) => r.price_buy ?? 0).filter((n) => n > 0);
    const capturedAt = Math.max(...matching.map((c) => c.snap.capturedAt));
    const latest = matching.reduce((a, b) => (a.snap.capturedAt >= b.snap.capturedAt ? a : b));
    return {
      name: best.price.name || `commodity#${id ?? "?"}`,
      code: id != null ? String(id) : "",
      commodityId: id,
      sell: sells.length ? Math.max(...sells) : null,
      buy: buys.length ? Math.min(...buys) : null,
      capturedAt,
      terminalName: latest.snap.terminalName,
      gameVersion: latest.snap.gameVersion,
      rows,
      attribution: LOCAL_SNAPSHOT_ATTRIBUTION,
    };
  }
}

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function rowToSnapshot(row: Record<string, unknown>): StoredSnapshot {
  let prices: SnapshotPrice[] = [];
  try {
    const parsed = JSON.parse(String(row.prices_json ?? "[]")) as SnapshotPrice[];
    if (Array.isArray(parsed)) prices = parsed;
  } catch {
    prices = [];
  }
  return {
    id: Number(row.id),
    source: String(row.source),
    gameVersion: String(row.game_version),
    environment: row.environment as SnapshotEnvironment,
    idTerminal: Number(row.id_terminal),
    terminalName: (row.terminal_name as string | null) ?? null,
    type: row.type as SnapshotType,
    prices,
    screenshotSha256: (row.screenshot_sha256 as string | null) ?? null,
    capturedAt: Number(row.captured_at),
    receivedAt: Number(row.received_at),
    status: row.status as SnapshotStatus,
    createdBy: (row.created_by as string | null) ?? null,
  };
}

export function serializeSnapshot(s: StoredSnapshot) {
  return {
    id: s.id,
    source: s.source,
    game_version: s.gameVersion,
    environment: s.environment,
    id_terminal: s.idTerminal,
    terminal_name: s.terminalName,
    type: s.type,
    prices: s.prices,
    screenshot_sha256: s.screenshotSha256,
    captured_at: s.capturedAt,
    received_at: s.receivedAt,
    status: s.status,
    created_by: s.createdBy,
  };
}

let defaultStore: IngestStore | null = null;

export function initIngestStore(db: Database.Database, disk?: EconomyDiskCache): IngestStore {
  defaultStore = new IngestStore(db, disk);
  return defaultStore;
}

export function getIngestStore(): IngestStore | null {
  return defaultStore;
}

export function setIngestStoreForTests(store: IngestStore | null): void {
  defaultStore = store;
}
