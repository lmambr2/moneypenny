/**
 * Fail-open external status plugins (feature-roadmap G2).
 * Never sits on the music/transport critical path — callers await with timeout
 * and always get a string reply (success or clear unavailable message).
 */

export interface ExternalStatusPlugin {
  id: string;
  label: string;
  /** Fetch status text. May throw — wrapper converts to fail-open message. */
  fetch(): Promise<string>;
}

export interface ExternalStatusResult {
  id: string;
  label: string;
  ok: boolean;
  text: string;
  cached: boolean;
  ageMs?: number;
}

interface CacheEntry {
  at: number;
  result: ExternalStatusResult;
}

export interface ExternalStatusRegistryOpts {
  /** Default TTL for successful results (ms). */
  cacheTtlMs?: number;
  /** Per-fetch timeout (ms). */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Registry of external status plugins with timeout + short cache.
 * Unavailable/offline/timeout → clear non-crash response (`ok: false`).
 */
export class ExternalStatusRegistry {
  private plugins = new Map<string, ExternalStatusPlugin>();
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;
  private timeoutMs: number;
  private now: () => number;

  constructor(opts: ExternalStatusRegistryOpts = {}) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? 4_000;
    this.now = opts.now ?? (() => Date.now());
  }

  register(plugin: ExternalStatusPlugin): void {
    this.plugins.set(plugin.id, plugin);
  }

  list(): Array<{ id: string; label: string }> {
    return [...this.plugins.values()].map((p) => ({ id: p.id, label: p.label }));
  }

  async get(id: string, opts?: { bypassCache?: boolean }): Promise<ExternalStatusResult> {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      return {
        id,
        label: id,
        ok: false,
        text: `Unknown status source "${id}". Try: ${this.list()
          .map((p) => p.id)
          .join(", ") || "(none registered)"}`,
        cached: false,
      };
    }

    const cached = this.cache.get(id);
    const now = this.now();
    if (!opts?.bypassCache && cached && now - cached.at < this.cacheTtlMs) {
      return { ...cached.result, cached: true, ageMs: now - cached.at };
    }

    try {
      const text = await withTimeout(plugin.fetch(), this.timeoutMs);
      const result: ExternalStatusResult = {
        id: plugin.id,
        label: plugin.label,
        ok: true,
        text: text.trim() || "(empty status)",
        cached: false,
      };
      this.cache.set(id, { at: now, result });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        id: plugin.id,
        label: plugin.label,
        ok: false,
        text: `${plugin.label} unavailable (${msg}). Music and transport are unaffected.`,
        cached: false,
      };
    }
  }

  async getAll(): Promise<ExternalStatusResult[]> {
    const ids = [...this.plugins.keys()];
    return Promise.all(ids.map((id) => this.get(id)));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Built-in Star Citizen org status stub — fail-open when no live API configured. */
export function createStarCitizenOrgStatusPlugin(opts: {
  /** Optional HTTP base for a future SC/org bridge. Empty = always fail-open. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  orgName?: string;
}): ExternalStatusPlugin {
  const base = (opts.baseUrl ?? process.env.SC_ORG_STATUS_URL ?? "").replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const org = opts.orgName ?? process.env.SC_ORG_NAME ?? "org";

  return {
    id: "sc-org",
    label: "Star Citizen org status",
    async fetch() {
      if (!base || !fetchImpl) {
        throw new Error("SC org status URL not configured (set SC_ORG_STATUS_URL)");
      }
      const res = await fetchImpl(`${base}/status`, {
        signal: AbortSignal.timeout(3_500),
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        summary?: string;
        membersOnline?: number;
        status?: string;
      };
      const parts = [
        `${org}: ${data.status ?? "ok"}`,
        data.membersOnline != null ? `${data.membersOnline} online` : null,
        data.summary ?? null,
      ].filter(Boolean);
      return parts.join(" · ");
    },
  };
}

/** Simple local “host health” plugin — always works offline for smoke. */
export function createHostHealthPlugin(opts?: {
  getSummary?: () => string | Promise<string>;
}): ExternalStatusPlugin {
  return {
    id: "host",
    label: "Host health",
    async fetch() {
      if (opts?.getSummary) return opts.getSummary();
      return `Host ok · uptime ${Math.floor(process.uptime())}s · node ${process.version}`;
    },
  };
}
