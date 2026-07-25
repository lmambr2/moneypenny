/**
 * HTTP client for the station API (audit C2 — fetch, no axios).
 *
 * Deliberately keeps the axios call surface (`api.get(url, config)` returning
 * `{ data, status }`, errors carrying `.response`) so the ~140 existing call
 * sites are unchanged. The module name is kept for the same reason.
 *
 * Upload progress is the one thing `fetch` cannot report, so requests passing
 * `onUploadProgress` are sent via XMLHttpRequest instead.
 */

import router from '../router/index.js';
import { usePlayerStore } from '../stores/player.js';

export type ResponseType = 'json' | 'blob' | 'text';

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface RequestConfig {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  responseType?: ResponseType;
  signal?: AbortSignal;
  onUploadProgress?: (e: UploadProgress) => void;
}

export interface ApiResponse<T = any> {
  data: T;
  status: number;
  /** Lowercase-keyed, like axios — call sites read `headers['content-type']`. */
  headers: Record<string, string>;
}

function headersFromFetch(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function headersFromXhr(xhr: XMLHttpRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (xhr.getAllResponseHeaders() || '').trim().split(/[\r\n]+/)) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** Mirrors the axios error shape the views already branch on. */
export class ApiError extends Error {
  readonly response?: { status: number; data: any };
  readonly code?: string;

  constructor(message: string, opts?: { status?: number; data?: any; code?: string }) {
    super(message);
    this.name = 'ApiError';
    this.code = opts?.code;
    if (opts?.status !== undefined) {
      this.response = { status: opts.status, data: opts.data };
    }
  }
}

function buildUrl(url: string, params?: Record<string, unknown>): string {
  if (!params) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  const q = qs.toString();
  if (!q) return url;
  return url.includes('?') ? `${url}&${q}` : `${url}?${q}`;
}

function isFormData(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

function stripContentType(headers: Record<string, string>): void {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'content-type') delete headers[k];
  }
}

/**
 * The browser must set multipart Content-Type itself so the boundary is
 * included. Call sites carried an explicit `multipart/form-data` header for
 * axios; honoring it here would produce a body the server cannot parse.
 */
function prepareHeaders(
  body: unknown,
  headers: Record<string, string> | undefined,
): { headers: Record<string, string>; body: BodyInit | undefined } {
  const out: Record<string, string> = { ...headers };

  if (body === undefined || body === null) {
    stripContentType(out);
    return { headers: out, body: undefined };
  }

  if (isFormData(body)) {
    stripContentType(out);
    return { headers: out, body };
  }

  if (typeof body === 'string' || body instanceof Blob) {
    return { headers: out, body: body as BodyInit };
  }

  const hasType = Object.keys(out).some((k) => k.toLowerCase() === 'content-type');
  if (!hasType) out['Content-Type'] = 'application/json';
  return { headers: out, body: JSON.stringify(body) };
}

async function parseBody(res: Response, responseType: ResponseType): Promise<any> {
  if (res.status === 204) return undefined;
  if (responseType === 'blob') return res.blob();
  if (responseType === 'text') return res.text();
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function notifyFromPayload(
  data: Record<string, unknown> | undefined,
  status: number,
  severity: 'error' | 'info',
): void {
  const playerStore = usePlayerStore();
  const msg =
    (typeof data?.message === 'string' && data.message) ||
    (typeof data?.error === 'string' && data.error) ||
    (status === 429
      ? 'Rate limited. Please slow down.'
      : status === 403
        ? 'Permission denied.'
        : 'Request failed');
  const code = typeof data?.code === 'string' ? ` (code: ${data.code})` : '';
  const retryAfter = data?.retryAfter != null ? Number(data.retryAfter) : undefined;
  playerStore.notify(`${msg}${code}`, severity, retryAfter);
}

/** Former axios response interceptor: session recovery + user-facing notices. */
async function handleFailure(url: string, status: number, data: any): Promise<void> {
  if (status === 401 && url.startsWith('/api/') && !url.startsWith('/api/session/')) {
    try {
      const { useSession } = await import('../composables/useSession.js');
      const session = useSession();
      await session.refresh();
      const current = router.currentRoute.value;
      if (current.name !== 'login' && current.name !== 'first-run') {
        await router.replace({ name: 'login', query: { next: current.fullPath } });
      }
    } catch {
      // ignore
    }
  }

  if (!url.startsWith('/api/')) return;
  const payload = (data ?? {}) as Record<string, unknown>;
  if (status === 429 || status === 403 || status >= 500) {
    notifyFromPayload(payload, status, 'error');
  } else if (status >= 400 && (payload.message || payload.error)) {
    notifyFromPayload(payload, status, 'info');
  }
}

/** XHR path — only for uploads that need progress events. */
function requestWithProgress<T>(
  method: string,
  url: string,
  body: unknown,
  config: RequestConfig,
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.withCredentials = true;
    const responseType = config.responseType ?? 'json';
    if (responseType === 'blob') xhr.responseType = 'blob';

    const { headers, body: payload } = prepareHeaders(body, config.headers);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

    if (config.onUploadProgress) {
      xhr.upload.onprogress = (e) => {
        config.onUploadProgress?.({ loaded: e.loaded, total: e.total });
      };
    }

    const onAbort = () => xhr.abort();
    if (config.signal) {
      if (config.signal.aborted) {
        reject(new ApiError('canceled', { code: 'ERR_CANCELED' }));
        return;
      }
      config.signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => config.signal?.removeEventListener('abort', onAbort);

    xhr.onabort = () => {
      cleanup();
      reject(new ApiError('canceled', { code: 'ERR_CANCELED' }));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError('Network error'));
    };
    xhr.onload = () => {
      cleanup();
      let data: any = xhr.response;
      if (responseType === 'json' && typeof data === 'string') {
        try {
          data = data ? JSON.parse(data) : undefined;
        } catch {
          // leave as text
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ data: data as T, status: xhr.status, headers: headersFromXhr(xhr) });
        return;
      }
      void handleFailure(url, xhr.status, data).finally(() => {
        reject(new ApiError(`HTTP ${xhr.status} ${xhr.statusText}`, { status: xhr.status, data }));
      });
    };

    xhr.send(payload as XMLHttpRequestBodyInit | null | undefined);
  });
}

async function request<T>(
  method: string,
  rawUrl: string,
  body?: unknown,
  config: RequestConfig = {},
): Promise<ApiResponse<T>> {
  const url = buildUrl(rawUrl, config.params);

  if (config.onUploadProgress) {
    return requestWithProgress<T>(method, url, body, config);
  }

  const { headers, body: payload } = prepareHeaders(body, config.headers);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      credentials: 'include',
      signal: config.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('canceled', { code: 'ERR_CANCELED' });
    }
    throw new ApiError(err instanceof Error ? err.message : 'Network error');
  }

  const data = await parseBody(res, config.responseType ?? 'json');
  if (res.ok) return { data: data as T, status: res.status, headers: headersFromFetch(res) };

  await handleFailure(url, res.status, data);
  throw new ApiError(`HTTP ${res.status} ${res.statusText}`, { status: res.status, data });
}

export const api = {
  get: <T = any>(url: string, config?: RequestConfig) => request<T>('GET', url, undefined, config),
  delete: <T = any>(url: string, config?: RequestConfig) =>
    request<T>('DELETE', url, undefined, config),
  post: <T = any>(url: string, body?: unknown, config?: RequestConfig) =>
    request<T>('POST', url, body, config),
  put: <T = any>(url: string, body?: unknown, config?: RequestConfig) =>
    request<T>('PUT', url, body, config),
  patch: <T = any>(url: string, body?: unknown, config?: RequestConfig) =>
    request<T>('PATCH', url, body, config),
};

export default api;
