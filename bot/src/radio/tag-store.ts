/**
 * TagStore — the non-destructive tag overlay for local tracks (docs/radio.md §9.1).
 * A SQLite table keyed by LocalProvider's stable opaque id (`sha1(realpath)`),
 * holding selection tags (genre/subgenre/mood/key/BPM/energy), the
 * bumper-eligible flag (§9.2), and denormalized rating aggregates (populated in
 * R-R3). It is an overlay, not a file rewrite: it survives re-index and never
 * corrupts the audio files.
 *
 * Precedence (§9.1): manual > analyzer/api > embedded. A lower-precedence writer
 * (a re-index reading embedded ID3, say) fills only empty fields and never
 * clobbers values a higher-precedence writer set; an equal-or-higher writer
 * overwrites. The bumper flag is managed separately (setBumper) so flagging an
 * asset never freezes its analyzer tags.
 */
import type Database from "better-sqlite3";

export type TagSource = "embedded" | "analyzer" | "api" | "manual";

const RANK: Record<TagSource, number> = { embedded: 1, api: 2, analyzer: 2, manual: 3 };

export interface TrackTags {
  genre?: string;
  subgenre?: string;
  mood?: string;
  musicalKey?: string;
  keyScale?: string;
  bpm?: number;
  energy?: number;
  danceability?: number;
  bumper?: boolean;
  bumperKind?: string;
  opsScope?: string;
  ratingAvg?: number;
  ratingCount?: number;
  source?: TagSource;
}

/** Columns that follow the source-precedence rules (not bumper/rating/meta). */
const TAG_FIELDS: (keyof TrackTags)[] = [
  "genre",
  "subgenre",
  "mood",
  "musicalKey",
  "keyScale",
  "bpm",
  "energy",
  "danceability",
];

interface Row {
  track_key: string;
  genre: string | null;
  subgenre: string | null;
  mood: string | null;
  musical_key: string | null;
  key_scale: string | null;
  bpm: number | null;
  energy: number | null;
  danceability: number | null;
  bumper: number;
  bumper_kind: string | null;
  ops_scope: string | null;
  rating_avg: number | null;
  rating_count: number | null;
  source: string | null;
  updated_at: number;
}

export interface TagStoreOptions {
  db: Database.Database;
  now?: () => number;
}

export class TagStore {
  private db: Database.Database;
  private nowFn: () => number;
  private rateUpsertStmt: Database.Statement;
  private unrateStmt: Database.Statement;
  private selectRowStmt: Database.Statement;
  private globalMeanStmt: Database.Statement;
  private ratingAggStmt: Database.Statement;
  private updateRatingStmt: Database.Statement;
  private insertRatingOnlyStmt: Database.Statement;

  constructor(opts: TagStoreOptions) {
    this.db = opts.db;
    this.nowFn = opts.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS track_tags (
        track_key TEXT PRIMARY KEY,
        genre TEXT, subgenre TEXT, mood TEXT,
        musical_key TEXT, key_scale TEXT, bpm INTEGER, energy REAL, danceability REAL,
        bumper INTEGER NOT NULL DEFAULT 0,
        bumper_kind TEXT,
        ops_scope TEXT,
        rating_avg REAL, rating_count INTEGER,
        source TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_track_tags_bumper ON track_tags(bumper);

      CREATE TABLE IF NOT EXISTS track_ratings (
        track_key TEXT NOT NULL,
        rater TEXT NOT NULL,
        stars INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (track_key, rater)
      );
    `);
    this.rateUpsertStmt = this.db.prepare(
      `INSERT INTO track_ratings (track_key, rater, stars, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(track_key, rater) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at`,
    );
    this.unrateStmt = this.db.prepare(`DELETE FROM track_ratings WHERE track_key = ? AND rater = ?`);
    this.selectRowStmt = this.db.prepare(`SELECT * FROM track_tags WHERE track_key = ?`);
    this.globalMeanStmt = this.db.prepare(`SELECT AVG(stars) avg FROM track_ratings`);
    this.ratingAggStmt = this.db.prepare(
      `SELECT COUNT(*) n, AVG(stars) avg FROM track_ratings WHERE track_key = ?`,
    );
    this.updateRatingStmt = this.db.prepare(
      `UPDATE track_tags SET rating_avg = ?, rating_count = ?, updated_at = ? WHERE track_key = ?`,
    );
    this.insertRatingOnlyStmt = this.db.prepare(
      `INSERT INTO track_tags (track_key, rating_avg, rating_count, updated_at) VALUES (?, ?, ?, ?)`,
    );
  }

  // --- ratings (§9.7): per-rater rows + a smoothed aggregate on track_tags ---

  /** Set a rater's 1–5 stars for a track (upsert) and refresh the aggregate.
   *  `rater` is namespaced (`ts:<uid>` | `web:<userId>`). */
  rate(trackKey: string, rater: string, stars: number): void {
    const s = Math.round(stars);
    if (s < 1 || s > 5) throw new Error("rating must be 1..5"); // trust boundary
    const now = this.nowFn();
    this.rateUpsertStmt.run(trackKey, rater, s, now);
    this.recomputeRating(trackKey, now);
  }

  /** Remove a rater's rating. Returns whether a rating existed. */
  unrate(trackKey: string, rater: string): boolean {
    const info = this.unrateStmt.run(trackKey, rater);
    this.recomputeRating(trackKey, this.nowFn());
    return info.changes > 0;
  }

  /** Raw average + count for a track (what the UI shows). */
  getRating(trackKey: string): { avg: number; count: number } {
    const row = this.selectRow(trackKey);
    return { avg: row?.rating_avg ?? 0, count: row?.rating_count ?? 0 };
  }

  /** IMDB-style Bayesian mean (§9.7): (C*m + Σstars) / (C + n), so a lone 5-star
   *  doesn't outrank a well-rated track. Thresholds (select_tracks ratingMin)
   *  use this, not the raw average. */
  smoothedScore(trackKey: string): number {
    const { avg, count } = this.getRating(trackKey);
    const m = this.globalMean();
    if (count === 0) return m;
    const C = 5;
    return (C * m + avg * count) / (C + count);
  }

  private globalMean(): number {
    const r = this.globalMeanStmt.get() as { avg: number | null };
    return r.avg ?? 3; // ponytail: mid-scale prior when nothing's rated yet
  }

  private recomputeRating(trackKey: string, now: number): void {
    const r = this.ratingAggStmt.get(trackKey) as { n: number; avg: number | null };
    if (this.selectRow(trackKey)) {
      this.updateRatingStmt.run(r.avg, r.n, now, trackKey);
    } else if (r.n > 0) {
      this.insertRatingOnlyStmt.run(trackKey, r.avg, r.n, now);
    }
  }

  get(trackKey: string): TrackTags | null {
    const row = this.selectRow(trackKey);
    return row ? this.toTags(row) : null;
  }

  /** Merge tags in with source-precedence (see class doc). Ignores undefined
   *  fields and the bumper flag (use setBumper for that). */
  upsert(trackKey: string, tags: Partial<TrackTags>, source: TagSource): void {
    const existing = this.selectRow(trackKey);
    const now = this.nowFn();
    const incomingRank = RANK[source];

    if (!existing) {
      const t: TrackTags = {};
      for (const f of TAG_FIELDS) if (tags[f] !== undefined) (t as Record<string, unknown>)[f] = tags[f];
      this.insertRow(trackKey, t, source, now);
      return;
    }

    const existingRank = RANK[(existing.source as TagSource) ?? "embedded"];
    const cur = this.toTags(existing);
    let changed = false;
    for (const f of TAG_FIELDS) {
      const val = tags[f];
      if (val === undefined) continue;
      const present = cur[f] !== undefined && cur[f] !== null && cur[f] !== "";
      if (!present || incomingRank >= existingRank) {
        (cur as Record<string, unknown>)[f] = val;
        changed = true;
      }
    }
    if (!changed) return;
    const nextSource: TagSource = incomingRank >= existingRank ? source : ((existing.source as TagSource) ?? source);
    this.writeTagFields(trackKey, cur, nextSource, now);
  }

  /** Set (or clear) the bumper-eligible flag (§9.2). Orthogonal to tag
   *  precedence — never touches `source`, so it can't freeze analyzer tags. */
  setBumper(trackKey: string, opts: { bumper: boolean; bumperKind?: string; opsScope?: string }): void {
    const now = this.nowFn();
    const exists = this.selectRow(trackKey);
    if (exists) {
      this.db
        .prepare(
          `UPDATE track_tags SET bumper = ?, bumper_kind = ?, ops_scope = ?, updated_at = ? WHERE track_key = ?`,
        )
        .run(opts.bumper ? 1 : 0, opts.bumperKind ?? null, opts.opsScope ?? null, now, trackKey);
    } else {
      this.db
        .prepare(
          `INSERT INTO track_tags (track_key, bumper, bumper_kind, ops_scope, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(trackKey, opts.bumper ? 1 : 0, opts.bumperKind ?? null, opts.opsScope ?? null, now);
    }
  }

  isBumper(trackKey: string): boolean {
    const row = this.db.prepare(`SELECT bumper FROM track_tags WHERE track_key = ?`).get(trackKey) as
      | { bumper: number }
      | undefined;
    return row?.bumper === 1;
  }

  /** All track keys flagged as bumper-eligible, optionally scoped to an ops
   *  profile (opsScope is a CSV; a null scope matches every profile). */
  bumperKeys(opsScope?: string): string[] {
    const rows = this.db.prepare(`SELECT track_key, ops_scope FROM track_tags WHERE bumper = 1`).all() as {
      track_key: string;
      ops_scope: string | null;
    }[];
    return rows
      .filter((r) => !opsScope || !r.ops_scope || r.ops_scope.split(",").map((s) => s.trim()).includes(opsScope))
      .map((r) => r.track_key);
  }

  /** The set of bumper-flagged keys, for fast exclusion from music search. */
  bumperKeySet(): Set<string> {
    return new Set(this.bumperKeys());
  }

  /** Tag-driven selection (§9.4): trackKeys matching the filters, bumper-flagged
   *  assets always excluded. String filters are case-insensitive; `ratingMin`
   *  thresholds the smoothed Bayesian score (§9.7), not the raw average. */
  selectTracks(f: {
    mood?: string[];
    genreAny?: string[];
    subgenreAny?: string[];
    bpmMin?: number;
    bpmMax?: number;
    musicalKey?: string;
    energyMin?: number;
    energyMax?: number;
    ratingMin?: number;
    limit?: number;
  }): string[] {
    const where: string[] = ["bumper = 0"];
    const params: unknown[] = [];
    const anyOf = (col: string, vals?: string[]) => {
      if (!vals || vals.length === 0) return;
      where.push(`LOWER(${col}) IN (${vals.map(() => "?").join(",")})`);
      params.push(...vals.map((v) => v.toLowerCase()));
    };
    anyOf("mood", f.mood);
    anyOf("genre", f.genreAny);
    anyOf("subgenre", f.subgenreAny);
    if (f.bpmMin != null) { where.push("bpm >= ?"); params.push(f.bpmMin); }
    if (f.bpmMax != null) { where.push("bpm <= ?"); params.push(f.bpmMax); }
    if (f.musicalKey) { where.push("LOWER(musical_key) = ?"); params.push(f.musicalKey.toLowerCase()); }
    if (f.energyMin != null) { where.push("energy >= ?"); params.push(f.energyMin); }
    if (f.energyMax != null) { where.push("energy <= ?"); params.push(f.energyMax); }

    const rows = this.db
      .prepare(`SELECT track_key FROM track_tags WHERE ${where.join(" AND ")}`)
      .all(...params) as { track_key: string }[];
    let keys = rows.map((r) => r.track_key);
    if (f.ratingMin != null) keys = keys.filter((k) => this.smoothedScore(k) >= f.ratingMin!);
    return keys.slice(0, Math.max(1, Math.min(f.limit ?? 25, 100)));
  }

  // --- internals ---

  private selectRow(trackKey: string): Row | null {
    return (this.selectRowStmt.get(trackKey) as Row | undefined) ?? null;
  }

  private toTags(row: Row): TrackTags {
    return {
      genre: row.genre ?? undefined,
      subgenre: row.subgenre ?? undefined,
      mood: row.mood ?? undefined,
      musicalKey: row.musical_key ?? undefined,
      keyScale: row.key_scale ?? undefined,
      bpm: row.bpm ?? undefined,
      energy: row.energy ?? undefined,
      danceability: row.danceability ?? undefined,
      bumper: row.bumper === 1,
      bumperKind: row.bumper_kind ?? undefined,
      opsScope: row.ops_scope ?? undefined,
      ratingAvg: row.rating_avg ?? undefined,
      ratingCount: row.rating_count ?? undefined,
      source: (row.source as TagSource) ?? undefined,
    };
  }

  private insertRow(trackKey: string, t: TrackTags, source: TagSource, now: number): void {
    this.db
      .prepare(
        `INSERT INTO track_tags
           (track_key, genre, subgenre, mood, musical_key, key_scale, bpm, energy, danceability, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trackKey,
        t.genre ?? null,
        t.subgenre ?? null,
        t.mood ?? null,
        t.musicalKey ?? null,
        t.keyScale ?? null,
        t.bpm ?? null,
        t.energy ?? null,
        t.danceability ?? null,
        source,
        now,
      );
  }

  private writeTagFields(trackKey: string, t: TrackTags, source: TagSource, now: number): void {
    this.db
      .prepare(
        `UPDATE track_tags SET
           genre = ?, subgenre = ?, mood = ?, musical_key = ?, key_scale = ?,
           bpm = ?, energy = ?, danceability = ?, source = ?, updated_at = ?
         WHERE track_key = ?`,
      )
      .run(
        t.genre ?? null,
        t.subgenre ?? null,
        t.mood ?? null,
        t.musicalKey ?? null,
        t.keyScale ?? null,
        t.bpm ?? null,
        t.energy ?? null,
        t.danceability ?? null,
        source,
        now,
        trackKey,
      );
  }
}
