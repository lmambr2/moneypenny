/**
 * HTTP client for an ACE-Step music-generation sidecar (docs/ace-step.md A1).
 * Bot never embeds ACE-Step — same pattern as STT/TTS/LLM.
 */
import type { Logger } from "../logger.js";
import { fetchBuffer, fetchWithTimeout } from "../util/http.js";

export interface AceStepHealth {
  ok: boolean;
  engine?: string;
  busy?: boolean;
  error?: string;
  /** Adapter returns true when ACE_STEP_MOCK=1 (silent stubs). */
  mock?: boolean;
  /** True when ACE_STEP_WORKER_URL is set on the adapter. */
  workerConfigured?: boolean;
}

export interface AceStepGenerateRequest {
  prompt: string;
  durationSec?: number;
  seed?: number | null;
  lyrics?: string | null;
  tags?: string[];
}

export type AceStepJobStatus = "queued" | "running" | "done" | "error";

export interface AceStepJob {
  id: string;
  status: AceStepJobStatus;
  /** Relative or absolute path under MUSIC_DIR when done (shared FS preferred). */
  path?: string | null;
  error?: string | null;
  progress?: number;
}

export type AceStepFetch = typeof fetch;

export interface AceStepClientOpts {
  url: string;
  timeoutMs?: number;
  logger?: Logger;
  /** Injectable for tests (global fetch signature). */
  fetchImpl?: AceStepFetch;
}

export class AceStepClient {
  private base: string;
  private timeoutMs: number;
  private logger?: Logger;
  private fetchImpl: AceStepFetch;

  constructor(opts: AceStepClientOpts) {
    this.base = opts.url.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const { timeoutMs: _, ...rest } = init;
    // Prefer util helper when using global fetch; for injectables wire AbortSignal ourselves.
    if (this.fetchImpl === fetch) {
      return fetchWithTimeout(`${this.base}${path}`, {
        method: (rest.method as string) ?? "GET",
        headers: rest.headers as Record<string, string> | undefined,
        body: rest.body as BodyInit | null | undefined,
        timeoutMs,
        signal: rest.signal ?? undefined,
      });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        ...rest,
        signal: rest.signal ?? ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<AceStepHealth> {
    try {
      const res = await this.request("/health", { timeoutMs: 5_000 });
      if (res.ok) {
        const d = (await res.json()) as AceStepHealth & Record<string, unknown>;
        if (d && typeof d === "object") {
          return {
            ok: !!d.ok,
            engine: d.engine ?? "ace-step",
            busy: !!d.busy,
            ...(typeof d.mock === "boolean" ? { mock: d.mock } : {}),
            ...(typeof d.workerConfigured === "boolean"
              ? { workerConfigured: d.workerConfigured }
              : {}),
          };
        }
      }
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      this.logger?.debug({ err }, "ACE-Step health failed");
      return { ok: false, error: err instanceof Error ? err.message : "unreachable" };
    }
  }

  async isAvailable(): Promise<boolean> {
    const h = await this.health();
    return h.ok;
  }

  async generate(req: AceStepGenerateRequest): Promise<AceStepJob> {
    const prompt = req.prompt?.trim();
    if (!prompt) throw new Error("prompt is required");

    const body = {
      prompt,
      durationSec: req.durationSec,
      seed: req.seed ?? null,
      lyrics: req.lyrics ?? null,
      tags: req.tags ?? [],
    };
    const res = await this.request("/v1/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return normalizeJob(data);
  }

  async getJob(id: string): Promise<AceStepJob> {
    if (!id?.trim()) throw new Error("job id required");
    const res = await this.request(`/v1/jobs/${encodeURIComponent(id)}`, {
      timeoutMs: this.timeoutMs,
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return normalizeJob(data);
  }

  /**
   * Download finished audio when hosts do not share MUSIC_DIR.
   * Response body is raw audio bytes (mp3/wav).
   */
  async downloadAudio(id: string): Promise<Buffer> {
    if (!id?.trim()) throw new Error("job id required");
    if (this.fetchImpl === fetch) {
      const buf = await fetchBuffer(`${this.base}/v1/jobs/${encodeURIComponent(id)}/audio`, {
        timeoutMs: Math.max(this.timeoutMs, 120_000),
      });
      if (buf.length === 0) throw new Error("empty audio response");
      const max = 80 * 1024 * 1024;
      if (buf.length > max) throw new Error(`audio too large (${buf.length} bytes)`);
      return buf;
    }
    const res = await this.request(`/v1/jobs/${encodeURIComponent(id)}/audio`, {
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
    if (!res.ok) throw new Error(`audio download HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length === 0) throw new Error("empty audio response");
    const max = 80 * 1024 * 1024;
    if (buf.length > max) throw new Error(`audio too large (${buf.length} bytes)`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct && !/audio|octet-stream|mpeg|wav|mp3/i.test(ct)) {
      this.logger?.warn({ contentType: ct, id }, "ACE-Step audio unexpected content-type");
    }
    return buf;
  }

  /**
   * Poll until done/error or timeout. Fail-open callers should catch and continue.
   */
  async waitForJob(
    id: string,
    opts: { pollMs?: number; maxWaitMs?: number } = {},
  ): Promise<AceStepJob> {
    const pollMs = opts.pollMs ?? 2_000;
    const maxWaitMs = opts.maxWaitMs ?? 300_000;
    const deadline = Date.now() + maxWaitMs;
    let last: AceStepJob = { id, status: "queued" };
    while (Date.now() < deadline) {
      last = await this.getJob(id);
      if (last.status === "done" || last.status === "error") return last;
      await sleep(pollMs);
    }
    return {
      ...last,
      status: "error",
      error: last.error ?? `timed out after ${maxWaitMs}ms`,
    };
  }
}

function normalizeJob(raw: unknown): AceStepJob {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid job response");
  }
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? "");
  if (!id) throw new Error("job missing id");
  const statusRaw = String(o.status ?? "queued").toLowerCase();
  const status: AceStepJobStatus =
    statusRaw === "running" ||
    statusRaw === "done" ||
    statusRaw === "error" ||
    statusRaw === "queued"
      ? statusRaw
      : "queued";
  return {
    id,
    status,
    path: o.path != null ? String(o.path) : null,
    error: o.error != null ? String(o.error) : null,
    progress: typeof o.progress === "number" ? o.progress : undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function probeAceStep(url: string): Promise<boolean> {
  return new AceStepClient({ url }).isAvailable();
}
