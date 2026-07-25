/**
 * Thin fetch wrappers for bot outbound HTTP (audit C2 — prefer over axios).
 * Timeouts via AbortSignal; errors carry optional HTTP status.
 *
 * SSRF CONTRACT — these helpers intentionally do NOT validate the target.
 * Most callers are supposed to reach private addresses: the LLM at `llmUrl`,
 * embeddings, the STT/TTS sidecars, TurboVec. Adding `assertSafePlaybackTarget`
 * here would block all of them and break the bot.
 *
 * The guard therefore belongs at any call site whose URL is attacker-
 * influenceable — cover art, stream-bridge responses, scraped page metadata.
 * `BotProfileManager.downloadImage` is the worked example. CodeQL reports
 * js/request-forgery against these functions because taint flows through them;
 * that is expected, and the fix is never to guard here.
 */

import { errorMessage } from "./error.js";

export class HttpRequestError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, opts?: { status?: number; body?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "HttpRequestError";
    this.status = opts?.status;
    this.body = opts?.body;
  }
}

export function isHttpRequestError(err: unknown): err is HttpRequestError {
  return err instanceof HttpRequestError;
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) {
    const t = AbortSignal.timeout(timeoutMs);
    if (!parent) return t;
    return AbortSignal.any([t, parent]);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (parent) {
    if (parent.aborted) {
      clearTimeout(timer);
      ctrl.abort();
    } else {
      parent.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          ctrl.abort();
        },
        { once: true },
      );
    }
  }
  // Clear timer when aborted from timeout path is fine; GC when request ends.
  void timer;
  return ctrl.signal;
}

async function readErrorBody(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

export type FetchJsonOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** GET/POST JSON; throws HttpRequestError on non-2xx or network failure. */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body != null ? "POST" : "GET"),
      headers: opts.headers,
      body: opts.body,
      signal: timeoutSignal(timeoutMs, opts.signal),
    });
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw new HttpRequestError(`HTTP ${res.status} ${res.statusText}`, {
        status: res.status,
        body,
      });
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    if (isHttpRequestError(err)) throw err;
    throw new HttpRequestError(errorMessage(err, "fetch failed"), { cause: err });
  }
}

export type FetchBufferOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Response as Buffer (arraybuffer). */
export async function fetchBuffer(url: string, opts: FetchBufferOptions = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  try {
    const res = await fetch(url, {
      method: opts.method ?? (opts.body != null ? "POST" : "GET"),
      headers: opts.headers,
      body: opts.body,
      signal: timeoutSignal(timeoutMs, opts.signal),
    });
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw new HttpRequestError(`HTTP ${res.status} ${res.statusText}`, {
        status: res.status,
        body,
      });
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    if (isHttpRequestError(err)) throw err;
    throw new HttpRequestError(errorMessage(err, "fetch failed"), { cause: err });
  }
}

/** DELETE/POST with no response body required. */
export async function fetchVoid(url: string, opts: FetchJsonOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    const res = await fetch(url, {
      method: opts.method ?? "DELETE",
      headers: opts.headers,
      body: opts.body,
      signal: timeoutSignal(timeoutMs, opts.signal),
    });
    if (!res.ok) {
      const body = await readErrorBody(res);
      throw new HttpRequestError(`HTTP ${res.status} ${res.statusText}`, {
        status: res.status,
        body,
      });
    }
  } catch (err) {
    if (isHttpRequestError(err)) throw err;
    throw new HttpRequestError(errorMessage(err, "fetch failed"), { cause: err });
  }
}

/** Low-level fetch with timeout — does not throw on non-2xx (caller inspects status). */
export async function fetchWithTimeout(
  url: string,
  opts: FetchJsonOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    return await fetch(url, {
      method: opts.method ?? (opts.body != null ? "POST" : "GET"),
      headers: opts.headers,
      body: opts.body,
      signal: timeoutSignal(timeoutMs, opts.signal),
    });
  } catch (err) {
    throw new HttpRequestError(errorMessage(err, "fetch failed"), { cause: err });
  }
}

/** GET/POST response as text; throws on non-2xx. */
export async function fetchText(url: string, opts: FetchJsonOptions = {}): Promise<string> {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new HttpRequestError(`HTTP ${res.status} ${res.statusText}`, {
      status: res.status,
      body,
    });
  }
  return res.text();
}

/** Append query params to a URL string. */
export function withQuery(
  url: string,
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}
