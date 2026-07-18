import type Database from "better-sqlite3";

/**
 * Per-member hangar (private ownership). Owner keys:
 *  - `uid:<teamspeak-uid>` — live member hangar
 *  - `cs:<CALLSIGN>` — org code from Ship_List.md until claimed
 */

export type HangarOwnerKey = string;

export interface HangarProfile {
  ownerKey: string;
  uid: string | null;
  callsign: string | null;
  displayName: string | null;
  updatedAt: number;
}

export interface HangarShip {
  id: number;
  ownerKey: string;
  shipId: string;
  shipName: string;
  qty: number;
  notes: string | null;
  catalogMatched: boolean;
  updatedAt: number;
}

export function uidOwnerKey(uid: string): HangarOwnerKey {
  return `uid:${uid}`;
}

export function callsignOwnerKey(code: string): HangarOwnerKey {
  return `cs:${code.trim().toUpperCase()}`;
}

export function shipIdFromName(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export class UserShipsStore {
  private upsertProfileStmt: Database.Statement;
  private getProfileStmt: Database.Statement;
  private getProfileByUidStmt: Database.Statement;
  private getProfileByCallsignStmt: Database.Statement;
  private listProfilesStmt: Database.Statement;
  private upsertShipStmt: Database.Statement;
  private getShipStmt: Database.Statement;
  private listShipsStmt: Database.Statement;
  private deleteShipStmt: Database.Statement;
  private clearShipsStmt: Database.Statement;
  private rekeyShipsStmt: Database.Statement;
  private deleteProfileStmt: Database.Statement;
  private ownersWithShipStmt: Database.Statement;
  private allShipsStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hangar_profiles (
        owner_key TEXT PRIMARY KEY,
        uid TEXT,
        callsign TEXT,
        display_name TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hangar_profiles_uid ON hangar_profiles(uid);
      CREATE INDEX IF NOT EXISTS idx_hangar_profiles_cs ON hangar_profiles(callsign);

      CREATE TABLE IF NOT EXISTS user_ships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_key TEXT NOT NULL,
        ship_id TEXT NOT NULL,
        ship_name TEXT NOT NULL,
        qty INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        catalog_matched INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        UNIQUE(owner_key, ship_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_ships_owner ON user_ships(owner_key);
      CREATE INDEX IF NOT EXISTS idx_user_ships_name ON user_ships(ship_name);
    `);

    this.upsertProfileStmt = db.prepare(`
      INSERT INTO hangar_profiles (owner_key, uid, callsign, display_name, updated_at)
      VALUES (@ownerKey, @uid, @callsign, @displayName, @updatedAt)
      ON CONFLICT(owner_key) DO UPDATE SET
        uid=COALESCE(excluded.uid, hangar_profiles.uid),
        callsign=COALESCE(excluded.callsign, hangar_profiles.callsign),
        display_name=COALESCE(excluded.display_name, hangar_profiles.display_name),
        updated_at=excluded.updated_at
    `);
    this.getProfileStmt = db.prepare(`SELECT * FROM hangar_profiles WHERE owner_key = ?`);
    this.getProfileByUidStmt = db.prepare(
      `SELECT * FROM hangar_profiles WHERE uid = ? ORDER BY updated_at DESC LIMIT 1`,
    );
    this.getProfileByCallsignStmt = db.prepare(
      `SELECT * FROM hangar_profiles WHERE upper(callsign) = upper(?) LIMIT 1`,
    );
    this.listProfilesStmt = db.prepare(`SELECT * FROM hangar_profiles ORDER BY owner_key ASC`);
    this.upsertShipStmt = db.prepare(`
      INSERT INTO user_ships (owner_key, ship_id, ship_name, qty, notes, catalog_matched, updated_at)
      VALUES (@ownerKey, @shipId, @shipName, @qty, @notes, @catalogMatched, @updatedAt)
      ON CONFLICT(owner_key, ship_id) DO UPDATE SET
        ship_name=excluded.ship_name,
        qty=excluded.qty,
        notes=COALESCE(excluded.notes, user_ships.notes),
        catalog_matched=excluded.catalog_matched,
        updated_at=excluded.updated_at
    `);
    this.getShipStmt = db.prepare(
      `SELECT * FROM user_ships WHERE owner_key = ? AND ship_id = ?`,
    );
    this.listShipsStmt = db.prepare(
      `SELECT * FROM user_ships WHERE owner_key = ? ORDER BY ship_name COLLATE NOCASE ASC`,
    );
    this.deleteShipStmt = db.prepare(`DELETE FROM user_ships WHERE owner_key = ? AND ship_id = ?`);
    this.clearShipsStmt = db.prepare(`DELETE FROM user_ships WHERE owner_key = ?`);
    this.rekeyShipsStmt = db.prepare(`UPDATE user_ships SET owner_key = ? WHERE owner_key = ?`);
    this.deleteProfileStmt = db.prepare(`DELETE FROM hangar_profiles WHERE owner_key = ?`);
    this.ownersWithShipStmt = db.prepare(`
      SELECT p.*, s.qty AS ship_qty, s.ship_name AS matched_ship_name
      FROM user_ships s
      JOIN hangar_profiles p ON p.owner_key = s.owner_key
      WHERE lower(s.ship_name) LIKE ? OR lower(s.ship_id) LIKE ?
      ORDER BY p.owner_key ASC
    `);
    this.allShipsStmt = db.prepare(`
      SELECT s.*, p.uid AS profile_uid, p.callsign AS profile_callsign, p.display_name AS profile_display
      FROM user_ships s
      LEFT JOIN hangar_profiles p ON p.owner_key = s.owner_key
      ORDER BY s.owner_key ASC, s.ship_name COLLATE NOCASE ASC
    `);
  }

  ensureUidProfile(uid: string, displayName?: string | null): HangarProfile {
    const ownerKey = uidOwnerKey(uid);
    const existing = this.getProfile(ownerKey);
    if (existing) {
      if (displayName && displayName !== existing.displayName) {
        this.upsertProfile({
          ownerKey,
          uid,
          callsign: existing.callsign,
          displayName,
        });
        return this.getProfile(ownerKey)!;
      }
      return existing;
    }
    this.upsertProfile({ ownerKey, uid, callsign: null, displayName: displayName ?? null });
    return this.getProfile(ownerKey)!;
  }

  ensureCallsignProfile(callsign: string, displayName?: string | null): HangarProfile {
    const code = callsign.trim().toUpperCase();
    const ownerKey = callsignOwnerKey(code);
    const existing = this.getProfile(ownerKey) ?? this.getProfileByCallsign(code);
    if (existing) return existing;
    this.upsertProfile({
      ownerKey,
      uid: null,
      callsign: code,
      displayName: displayName ?? code,
    });
    return this.getProfile(ownerKey)!;
  }

  upsertProfile(opts: {
    ownerKey: string;
    uid?: string | null;
    callsign?: string | null;
    displayName?: string | null;
  }): void {
    this.upsertProfileStmt.run({
      ownerKey: opts.ownerKey,
      uid: opts.uid ?? null,
      callsign: opts.callsign ? opts.callsign.toUpperCase() : null,
      displayName: opts.displayName ?? null,
      updatedAt: Date.now(),
    });
  }

  getProfile(ownerKey: string): HangarProfile | null {
    const row = this.getProfileStmt.get(ownerKey) as ProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  getProfileByUid(uid: string): HangarProfile | null {
    const row = this.getProfileByUidStmt.get(uid) as ProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  getProfileByCallsign(callsign: string): HangarProfile | null {
    const row = this.getProfileByCallsignStmt.get(callsign) as ProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  listProfiles(): HangarProfile[] {
    return (this.listProfilesStmt.all() as ProfileRow[]).map(rowToProfile);
  }

  listShips(ownerKey: string): HangarShip[] {
    return (this.listShipsStmt.all(ownerKey) as ShipRow[]).map(rowToShip);
  }

  getShip(ownerKey: string, shipId: string): HangarShip | null {
    const row = this.getShipStmt.get(ownerKey, shipId) as ShipRow | undefined;
    return row ? rowToShip(row) : null;
  }

  /** Set absolute qty (min 1). */
  setShip(opts: {
    ownerKey: string;
    shipId: string;
    shipName: string;
    qty: number;
    notes?: string | null;
    catalogMatched: boolean;
  }): HangarShip {
    const qty = Math.max(1, Math.floor(opts.qty) || 1);
    this.upsertShipStmt.run({
      ownerKey: opts.ownerKey,
      shipId: opts.shipId,
      shipName: opts.shipName.slice(0, 200),
      qty,
      notes: opts.notes ?? null,
      catalogMatched: opts.catalogMatched ? 1 : 0,
      updatedAt: Date.now(),
    });
    return this.getShip(opts.ownerKey, opts.shipId)!;
  }

  /** Add qty (default 1) to existing or create. */
  addShip(opts: {
    ownerKey: string;
    shipId: string;
    shipName: string;
    qty?: number;
    notes?: string | null;
    catalogMatched: boolean;
  }): HangarShip {
    const add = Math.max(1, Math.floor(opts.qty ?? 1) || 1);
    const existing = this.getShip(opts.ownerKey, opts.shipId);
    const qty = (existing?.qty ?? 0) + add;
    return this.setShip({ ...opts, qty });
  }

  /** Remove qty (default 1); delete row when qty hits 0. */
  removeShip(ownerKey: string, shipId: string, qty = 1): "removed" | "decremented" | "missing" {
    const existing = this.getShip(ownerKey, shipId);
    if (!existing) return "missing";
    const drop = Math.max(1, Math.floor(qty) || 1);
    const next = existing.qty - drop;
    if (next <= 0) {
      this.deleteShipStmt.run(ownerKey, shipId);
      return "removed";
    }
    this.setShip({
      ownerKey,
      shipId: existing.shipId,
      shipName: existing.shipName,
      qty: next,
      notes: existing.notes,
      catalogMatched: existing.catalogMatched,
    });
    return "decremented";
  }

  clearShips(ownerKey: string): number {
    return this.clearShipsStmt.run(ownerKey).changes;
  }

  /** Move all ships from one owner key to another (claim/merge). */
  rekeyOwner(fromKey: string, toKey: string): number {
    if (fromKey === toKey) return 0;
    const fromShips = this.listShips(fromKey);
    for (const s of fromShips) {
      const existing = this.getShip(toKey, s.shipId);
      const qty = (existing?.qty ?? 0) + s.qty;
      this.setShip({
        ownerKey: toKey,
        shipId: s.shipId,
        shipName: s.shipName,
        qty,
        notes: s.notes ?? existing?.notes ?? null,
        catalogMatched: s.catalogMatched || !!existing?.catalogMatched,
      });
    }
    this.clearShips(fromKey);
    const fromProfile = this.getProfile(fromKey);
    const toProfile = this.getProfile(toKey);
    if (fromProfile) {
      this.upsertProfile({
        ownerKey: toKey,
        uid: toProfile?.uid ?? fromProfile.uid,
        callsign: toProfile?.callsign ?? fromProfile.callsign,
        displayName: toProfile?.displayName ?? fromProfile.displayName,
      });
      this.deleteProfileStmt.run(fromKey);
    }
    return fromShips.length;
  }

  /** Who has a ship matching name fragment (for org who). */
  ownersWithShip(query: string): Array<HangarProfile & { shipQty: number; matchedShipName: string }> {
    const q = `%${query.trim().toLowerCase()}%`;
    const rows = this.ownersWithShipStmt.all(q, q) as Array<
      ProfileRow & { ship_qty: number; matched_ship_name: string }
    >;
    return rows.map((r) => ({
      ...rowToProfile(r),
      shipQty: r.ship_qty,
      matchedShipName: r.matched_ship_name,
    }));
  }

  allShipsWithProfiles(): Array<
    HangarShip & {
      profileUid: string | null;
      profileCallsign: string | null;
      profileDisplay: string | null;
    }
  > {
    const rows = this.allShipsStmt.all() as Array<
      ShipRow & {
        profile_uid: string | null;
        profile_callsign: string | null;
        profile_display: string | null;
      }
    >;
    return rows.map((r) => ({
      ...rowToShip(r),
      profileUid: r.profile_uid,
      profileCallsign: r.profile_callsign,
      profileDisplay: r.profile_display,
    }));
  }

  /** Distinct catalog of ship names currently in hangars (for fuzzy). */
  knownShipNames(): string[] {
    const rows = this.allShipsStmt.all() as ShipRow[];
    const set = new Set<string>();
    for (const r of rows) set.add(r.ship_name);
    return [...set];
  }
}

interface ProfileRow {
  owner_key: string;
  uid: string | null;
  callsign: string | null;
  display_name: string | null;
  updated_at: number;
}

interface ShipRow {
  id: number;
  owner_key: string;
  ship_id: string;
  ship_name: string;
  qty: number;
  notes: string | null;
  catalog_matched: number;
  updated_at: number;
}

function rowToProfile(r: ProfileRow): HangarProfile {
  return {
    ownerKey: r.owner_key,
    uid: r.uid,
    callsign: r.callsign,
    displayName: r.display_name,
    updatedAt: r.updated_at,
  };
}

function rowToShip(r: ShipRow): HangarShip {
  return {
    id: r.id,
    ownerKey: r.owner_key,
    shipId: r.ship_id,
    shipName: r.ship_name,
    qty: r.qty,
    notes: r.notes,
    catalogMatched: !!r.catalog_matched,
    updatedAt: r.updated_at,
  };
}
