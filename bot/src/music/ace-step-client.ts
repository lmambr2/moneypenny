/**
 * HTTP client for an ACE-Step music-generation sidecar (docs/ace-step.md A1).
 * Bot never embeds ACE-Step — same pattern as STT/TTS/LLM.
 */
import axios, { type AxiosInstance } from "axios";
import type { Logger } from "../logger.js";

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

export interface AceStepClientOpts {
  url: string;
  timeoutMs?: number;
  logger?: Logger;
  /** Injectable for tests. */
  http?: AxiosInstance;
}

export class AceStepClient {
  private base: string;
  private timeoutMs: number;
  private http: AxiosInstance;
  private logger?: Logger;

  constructor(opts: AceStepClientOpts) {
    this.base = opts.url.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.logger = opts.logger;
    this.http =
      opts.http ??
      axios.create({
        baseURL: this.base,
        timeout: this.timeoutMs,
        validateStatus: () => true,
      });
  }

  async health(): Promise<AceStepHealth> {
    try {
      const { data, status } = await this.http.get("/health", { timeout: 5_000 });
      if (status >= 200 && status < 300 && data && typeof data === "object") {
        const d = data as AceStepHealth & Record<string, unknown>;
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
      return { ok: false, error: `HTTP ${status}` };
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
    const { data, status } = await this.http.post("/v1/generate", body, {
      timeout: this.timeoutMs,
    });
    if (status < 200 || status >= 300) {
      const msg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `HTTP ${status}`;
      throw new Error(msg);
    }
    return normalizeJob(data);
  }

  async getJob(id: string): Promise<AceStepJob> {
    if (!id?.trim()) throw new Error("job id required");
    const { data, status } = await this.http.get(`/v1/jobs/${encodeURIComponent(id)}`, {
      timeout: this.timeoutMs,
    });
    if (status < 200 || status >= 300) {
      const msg =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `HTTP ${status}`;
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
    const { data, status, headers } = await this.http.get(
      `/v1/jobs/${encodeURIComponent(id)}/audio`,
      {
        timeout: Math.max(this.timeoutMs, 120_000),
        responseType: "arraybuffer",
      },
    );
    if (status < 200 || status >= 300) {
      throw new Error(`audio download HTTP ${status}`);
    }
    const buf = Buffer.from(data as ArrayBuffer);
    if (buf.length === 0) throw new Error("empty audio response");
    const max = 80 * 1024 * 1024; // 80 MiB hard cap
    if (buf.length > max) throw new Error(`audio too large (${buf.length} bytes)`);
    const ct = String(headers?.["content-type"] ?? "");
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
