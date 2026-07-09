import axios from "axios";
import type { Logger } from "../logger.js";

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
      const { data } = await axios.get(`${this.base}/health`, { timeout: 5000 });
      return !!data?.ok;
    } catch {
      return false;
    }
  }

  async remember(userId: string, fact: string): Promise<boolean> {
    try {
      const { data } = await axios.post(
        `${this.base}/v1/remember`,
        { userId, fact },
        { timeout: this.timeoutMs },
      );
      return !!data?.ok;
    } catch (err) {
      this.opts.logger?.warn({ err, userId }, "MemPalace remember failed");
      return false;
    }
  }

  async recall(userId: string, limit = 15): Promise<MemPalaceFact[]> {
    try {
      const { data } = await axios.get(`${this.base}/v1/recall`, {
        timeout: this.timeoutMs,
        params: { userId, limit },
      });
      if (!data?.ok || !Array.isArray(data.facts)) return [];
      return data.facts.map((row: { drawerId?: string; fact: string; filedAt?: string }) => ({
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
      const { data } = await axios.post(
        `${this.base}/v1/search`,
        { userId, query, limit },
        { timeout: this.timeoutMs },
      );
      if (!data?.ok || !Array.isArray(data.results)) return [];
      return data.results.map((row: { drawerId?: string; fact: string; score?: number }) => ({
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
      const { data } = await axios.post(
        `${this.base}/v1/kg/remember`,
        {
          fact,
          subject: meta.subject ?? "",
          validFrom: meta.validFrom ?? "",
          validUntil: meta.validUntil ?? "",
          diary: meta.diary ?? "",
        },
        { timeout: this.timeoutMs },
      );
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
      const { data } = await axios.post(
        `${this.base}/v1/kg/search`,
        { query, asOf: opts.asOf ?? "", limit: opts.limit ?? 8 },
        { timeout: this.timeoutMs },
      );
      if (!data?.ok || !Array.isArray(data.results)) return [];
      return data.results.map(
        (row: {
          drawerId?: string;
          fact: string;
          score?: number;
          diary?: string;
          subject?: string;
        }) => ({
          drawerId: row.drawerId,
          fact: row.fact,
          score: row.score,
          diary: row.diary,
          subject: row.subject,
        }),
      );
    } catch (err) {
      this.opts.logger?.warn({ err }, "MemPalace KG search failed");
      return [];
    }
  }

  async forget(userId: string, opts: { index?: number; all?: boolean }): Promise<boolean> {
    try {
      const { data } = await axios.post(
        `${this.base}/v1/forget`,
        { userId, index: opts.index, all: opts.all ?? false },
        { timeout: this.timeoutMs },
      );
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
