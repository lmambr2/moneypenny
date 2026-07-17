import { createHttpBrain } from "./http-brain.js";
import { createInProcessBrain, type InProcessBrainDeps } from "./in-process.js";
import type { BrainTransport } from "./types.js";

export interface ResolveBrainOptions {
  /** Remote brain base URL; empty → in-process. */
  brainUrl?: string;
  inProcess: InProcessBrainDeps;
  httpTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Prefer remote brain when BRAIN_URL / brainUrl is set; else in-process LLM+RAG.
 */
export function resolveBrainTransport(opts: ResolveBrainOptions): BrainTransport {
  const url = (opts.brainUrl ?? process.env.BRAIN_URL ?? "").trim();
  if (url) {
    return createHttpBrain({
      baseUrl: url,
      timeoutMs: opts.httpTimeoutMs,
      fetchImpl: opts.fetchImpl,
    });
  }
  return createInProcessBrain(opts.inProcess);
}
