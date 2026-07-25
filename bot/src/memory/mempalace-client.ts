import type { Logger } from "../logger.js";
import { fetchJson } from "../util/http.js";

export interface MemPalaceFact {
  drawerId?: string;
  fact: string;
  filedAt?: string;
  score?: number;
  diary?: string;
  subject?: string;
}

export interface KgRememberMeta {
  subject?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  diary?: string | null;
}

export interface MemPalaceClientOpts {
  url: string;
  logger?: Logger;
  timeoutMs?: number;
}

/** HTTP client for the Moneypenny MemPalace bridge (Phase 7). */
export class MemPalaceClient {
  private base: string;
  private timeoutMs: number;

  constructor(private opts: MemPalaceClientOpts) {
    this.base = opts.url.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const data = await fetchJson<{ ok?: boolean }>(`${this.base}/health`, { timeoutMs: 5000 });
      return !!data?.ok;
    } catch {
      return false;
    }
  }

  async remember(userId: string, fact: string): Promise<boolean> {
    try {
      const data = await fetchJson<{ ok?: boolean }>(`${this.base}/v1/remember`, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, fact }),
      });
      return !!data?.ok;
    } catch (err) {
      this.opts.logger?.warn({ err, userId }, "MemPalace remember failed");
      return false;
    }
  }

  async recall(userId: string, limit = 15): Promise<MemPalaceFact[]> {
    try {
      const q = new URLSearchParams({ userId, limit: String(limit) });
      const data = await fetchJson<{
        ok?: boolean;
        facts?: Array<{ drawerId?: string; fact: string; filedAt?: string }>;
      }>(`${this.base}/v1/recall?${q}`, { timeoutMs: this.timeoutMs });
      if (!data?.ok || !Array.isArray(data.facts)) return [];
      return data.facts.map((row) => ({
        drawerId: row.drawerId,
        fact: row.fact,
        filedAt: row.filedAt,
      }));
    } catch (err) {
      this.opts.logger?.warn({ err, userId }, "MemPalace recall failed");
      return [];
    }
  }

  async search(userId: string, query: string, limit = 5): Promise<MemPalaceFact[]> {
    try {
      const data = await fetchJson<{
        ok?: boolean;
        results?: Array<{ drawerId?: string; fact: string; score?: number }>;
      }>(`${this.base}/v1/search`, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, query, limit }),
      });
      if (!data?.ok || !Array.isArray(data.results)) return [];
      return data.results.map((row) => ({
        drawerId: row.drawerId,
        fact: row.fact,
        score: row.score,
      }));
    } catch (err) {
      this.opts.logger?.warn({ err, userId }, "MemPalace search failed");
      return [];
    }
  }

  async kgRemember(fact: string, meta: KgRememberMeta = {}): Promise<boolean> {
    try {
      const data = await fetchJson<{ ok?: boolean }>(`${this.base}/v1/kg/remember`, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fact,
          subject: meta.subject ?? "",
          validFrom: meta.validFrom ?? "",
          validUntil: meta.validUntil ?? "",
          diary: meta.diary ?? "",
        }),
      });
      return !!data?.ok;
    } catch (err) {
      this.opts.logger?.warn({ err }, "MemPalace KG remember failed");
      return false;
    }
  }

  async kgSearch(
    query: string,
    opts: { asOf?: string; limit?: number } = {},
  ): Promise<MemPalaceFact[]> {
    try {
      const data = await fetchJson<{
        ok?: boolean;
        results?: Array<{
          drawerId?: string;
          fact: string;
          score?: number;
          diary?: string;
          subject?: string;
        }>;
      }>(`${this.base}/v1/kg/search`, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, asOf: opts.asOf ?? "", limit: opts.limit ?? 8 }),
      });
      if (!data?.ok || !Array.isArray(data.results)) return [];
      return data.results.map((row) => ({
        drawerId: row.drawerId,
        fact: row.fact,
        score: row.score,
        diary: row.diary,
        subject: row.subject,
      }));
    } catch (err) {
      this.opts.logger?.warn({ err }, "MemPalace KG search failed");
      return [];
    }
  }

  async forget(userId: string, opts: { index?: number; all?: boolean }): Promise<boolean> {
    try {
      const data = await fetchJson<{ ok?: boolean }>(`${this.base}/v1/forget`, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, index: opts.index, all: opts.all ?? false }),
      });
      return !!data?.ok;
    } catch (err) {
      this.opts.logger?.warn({ err, userId }, "MemPalace forget failed");
      return false;
    }
  }
}

export async function probeMemPalace(url: string): Promise<boolean> {
  const client = new MemPalaceClient({ url });
  return client.isAvailable();
}
