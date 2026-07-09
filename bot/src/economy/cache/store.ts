/**
 * Persistent on-disk cache for economy API payloads (UEX, sc-craft, sc-trade, sc-wiki).
 *
 * Layout: {root}/{source}/{safeKey}.json
 * Each file: { fetchedAt, expiresAt, source, key, data }
 *
 * Policy: stale-while-revalidate — callers may serve expired entries when offline.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type EconomyCacheSource = "uex" | "sc-craft" | "sc-trade" | "sc-wiki" | "meta";

export interface EconomyCacheRecord<T = unknown> {
  source: EconomyCacheSource;
  key: string;
  fetchedAt: number;
  expiresAt: number;
  data: T;
}

export interface EconomyCacheHit<T> {
  data: T;
  fetchedAt: number;
  expiresAt: number;
  /** True when past expiresAt but still on disk (usable offline). */
  stale: boolean;
}

export interface EconomyCacheStats {
  root: string;
  sources: Array<{
    source: string;
    files: number;
    bytes: number;
    fresh: number;
    stale: number;
  }>;
  totalFiles: number;
  totalBytes: number;
}

function safeKey(key: string): string {
  const cleaned = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._+=:@/-]+/g, "_")
    .replace(/[/\\]+/g, "__")
    .slice(0, 120);
  if (cleaned.length >= 8 && cleaned.length <= 80 && !cleaned.includes("..")) {
    return cleaned || "empty";
  }
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return `${cleaned.slice(0, 40)}_${hash}`;
}

export class EconomyDiskCache {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    try {
      mkdirSync(this.root, { recursive: true });
    } catch {
      // Read-only / test env: writes will fail soft; get() still works if files exist.
    }
  }

  pathFor(source: EconomyCacheSource, key: string): string {
    const dir = join(this.root, source);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    return join(dir, `${safeKey(key)}.json`);
  }

  get<T>(source: EconomyCacheSource, key: string, now = Date.now()): EconomyCacheHit<T> | null {
    const path = this.pathFor(source, key);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf-8");
      const rec = JSON.parse(raw) as EconomyCacheRecord<T>;
      if (!rec || rec.data === undefined) return null;
      return {
        data: rec.data,
        fetchedAt: rec.fetchedAt,
        expiresAt: rec.expiresAt,
        stale: now > rec.expiresAt,
      };
    } catch {
      return null;
    }
  }

  /** Fresh hit only (null if missing or expired). */
  getFresh<T>(source: EconomyCacheSource, key: string, now = Date.now()): T | null {
    const hit = this.get<T>(source, key, now);
    if (!hit || hit.stale) return null;
    return hit.data;
  }

  set<T>(source: EconomyCacheSource, key: string, data: T, ttlMs: number, now = Date.now()): void {
    try {
      const path = this.pathFor(source, key);
      const rec: EconomyCacheRecord<T> = {
        source,
        key,
        fetchedAt: now,
        expiresAt: now + Math.max(0, ttlMs),
        data,
      };
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec), "utf-8");
      renameSync(tmp, path);
    } catch {
      // Disk full / permission — memory clients still work; refresh will retry later.
    }
  }

  delete(source: EconomyCacheSource, key: string): boolean {
    const path = this.pathFor(source, key);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  clear(source?: EconomyCacheSource): number {
    let n = 0;
    const sources = source
      ? [source]
      : (["uex", "sc-craft", "sc-trade", "sc-wiki", "meta"] as EconomyCacheSource[]);
    for (const s of sources) {
      const dir = join(this.root, s);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        rmSync(join(dir, f), { force: true });
        n += 1;
      }
    }
    return n;
  }

  stats(now = Date.now()): EconomyCacheStats {
    const sources: EconomyCacheStats["sources"] = [];
    let totalFiles = 0;
    let totalBytes = 0;
    for (const source of ["uex", "sc-craft", "sc-trade", "sc-wiki", "meta"] as EconomyCacheSource[]) {
      const dir = join(this.root, source);
      let files = 0;
      let bytes = 0;
      let fresh = 0;
      let stale = 0;
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const p = join(dir, f);
          try {
            const st = statSync(p);
            files += 1;
            bytes += st.size;
            const rec = JSON.parse(readFileSync(p, "utf-8")) as EconomyCacheRecord;
            if (now > rec.expiresAt) stale += 1;
            else fresh += 1;
          } catch {
            /* skip */
          }
        }
      }
      sources.push({ source, files, bytes, fresh, stale });
      totalFiles += files;
      totalBytes += bytes;
    }
    return { root: this.root, sources, totalFiles, totalBytes };
  }
}

let defaultCache: EconomyDiskCache | null = null;
let defaultRoot: string | null = null;

/** Resolve cache root: ECONOMY_CACHE_DIR or {dataDir}/economy-cache. */
export function resolveEconomyCacheRoot(dataDir?: string): string {
  const env = (process.env.ECONOMY_CACHE_DIR || "").trim();
  if (env) return env;
  if (dataDir) return join(dataDir, "economy-cache");
  // Prefer OS temp in tests / when cwd data is not writable.
  try {
    const candidate = join(process.cwd(), "data", "economy-cache");
    mkdirSync(candidate, { recursive: true });
    return candidate;
  } catch {
    return join(tmpdir(), "moneypenny-economy-cache");
  }
}

export function initEconomyDiskCache(dataDir?: string): EconomyDiskCache {
  const root = resolveEconomyCacheRoot(dataDir);
  if (defaultCache && defaultRoot === root) return defaultCache;
  defaultCache = new EconomyDiskCache(root);
  defaultRoot = root;
  return defaultCache;
}

export function getEconomyDiskCache(): EconomyDiskCache {
  if (!defaultCache) return initEconomyDiskCache();
  return defaultCache;
}

/** Test helper. */
export function setEconomyDiskCacheForTests(cache: EconomyDiskCache | null): void {
  defaultCache = cache;
  defaultRoot = cache?.root ?? null;
}
