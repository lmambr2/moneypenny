import {
  type BrainTransport,
  BrainUnavailableError,
  type TurnRequest,
  type TurnResult,
} from "./types.js";

export interface HttpBrainOptions {
  /** Base URL of remote brain (e.g. http://brain:8090) — no trailing slash. */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Remote brain over HTTP POST {baseUrl}/v1/turn.
 * On transport failure throws BrainUnavailableError (503/504) — callers fail-open.
 */
export function createHttpBrain(opts: HttpBrainOptions): BrainTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async completeTurn(req: TurnRequest): Promise<TurnResult> {
      const url = `${base}/v1/turn`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(req),
          signal: controller.signal,
        });
        if (res.status === 504) {
          throw new BrainUnavailableError("Brain timed out", 504);
        }
        if (res.status === 503 || res.status >= 500) {
          throw new BrainUnavailableError(`Brain unavailable (${res.status})`, 503);
        }
        if (res.status === 400) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return softError(req, body.error ?? "invalid turn request");
        }
        if (!res.ok) {
          throw new BrainUnavailableError(
            `Brain HTTP ${res.status}`,
            res.status >= 500 ? 503 : 503,
          );
        }
        const data = (await res.json()) as Partial<TurnResult>;
        return normalizeRemoteResult(req, data);
      } catch (err) {
        if (err instanceof BrainUnavailableError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new BrainUnavailableError("Brain timed out", 504);
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new BrainUnavailableError(`Brain transport failed: ${msg}`, 503);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function softError(req: TurnRequest, error: string): TurnResult {
  return {
    turnId: `brain-err-${Date.now().toString(36)}`,
    clientTurnId: req.clientTurnId,
    replyText: "",
    sources: [],
    toolProposals: [],
    error,
  };
}

function normalizeRemoteResult(req: TurnRequest, data: Partial<TurnResult>): TurnResult {
  const proposals = Array.isArray(data.toolProposals)
    ? data.toolProposals
        .filter((p) => p && typeof p === "object" && typeof (p as ToolP).name === "string")
        .map((p) => {
          const t = p as ToolP;
          return {
            name: t.name,
            arguments:
              t.arguments && typeof t.arguments === "object" && !Array.isArray(t.arguments)
                ? t.arguments
                : {},
            reason: typeof t.reason === "string" ? t.reason : undefined,
          };
        })
    : [];
  const sources = Array.isArray(data.sources)
    ? data.sources
        .filter((s) => s && typeof s === "object" && typeof (s as Src).source === "string")
        .map((s) => {
          const x = s as Src;
          return {
            source: x.source,
            text: typeof x.text === "string" ? x.text : undefined,
            classification: typeof x.classification === "string" ? x.classification : undefined,
            score: typeof x.score === "number" ? x.score : undefined,
          };
        })
    : [];

  return {
    turnId:
      typeof data.turnId === "string" && data.turnId ? data.turnId : `brain-remote-${Date.now()}`,
    clientTurnId: typeof data.clientTurnId === "string" ? data.clientTurnId : req.clientTurnId,
    replyText: typeof data.replyText === "string" ? data.replyText : "",
    sources,
    toolProposals: proposals,
    error: typeof data.error === "string" && data.error ? data.error : null,
  };
}

type ToolP = { name: string; arguments?: Record<string, unknown>; reason?: string };
type Src = { source: string; text?: string; classification?: string; score?: number };
