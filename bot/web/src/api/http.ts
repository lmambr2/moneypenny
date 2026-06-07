import router from '../router/index.js';
import { useSession } from '../composables/useSession.js';
import { usePlayerStore } from '../stores/player.js';

let installed = false;
const nativeFetch: typeof window.fetch = window.fetch.bind(window);

/**
 * Wraps fetch so every call:
 *   - sends cookies (`credentials: 'same-origin'`)
 *   - on 401 from /api/*: clear local session, redirect to /login
 *   - on 429 (rate limit): show a friendly toast with retry guidance
 *   - on 403 (forbidden): show a permission denied message
 *
 * Always uses the captured native fetch, never the (possibly wrapped) global.
 */
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const merged: RequestInit = {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.headers ?? {}) },
  };
  return nativeFetch(input, merged).then(async (res) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (res.status === 401 && shouldTriggerRefresh(input)) {
      const session = useSession();
      await session.refresh();
      const current = router.currentRoute.value;
      if (current.name !== 'login' && current.name !== 'first-run') {
        await router.replace({ name: 'login', query: { next: current.fullPath } });
      }
      return res;
    }

    // Handle rate limit and permission errors with server-provided messages + codes for UX + bug reports
    if ([429, 403].includes(res.status) && url.startsWith('/api/')) {
      try {
        const data = await res.clone().json();
        const msg = data?.message || data?.error || (res.status === 429 ? 'Rate limited. Please slow down.' : 'Permission denied.');
        const code = data?.code ? ` (code: ${data.code})` : '';
        const store = usePlayerStore();
        store.notify(`${msg}${code}`, 'error');
      } catch {
        const store = usePlayerStore();
        const fallback = res.status === 429 ? 'Too many requests. Please wait a moment before trying again.' : 'Permission denied.';
        store.notify(fallback, 'error');
      }
      return res;
    }

    // For other errors, if the response has a useful message, surface it (e.g. validation)
    if (res.status >= 400 && url.startsWith('/api/')) {
      try {
        const data = await res.clone().json();
        if (data?.message || data?.error) {
          const msg = data.message || data.error;
          const code = data?.code ? ` (code: ${data.code})` : '';
          const store = usePlayerStore();
          store.notify(`${msg}${code}`, res.status >= 500 ? 'error' : 'info');
        }
      } catch {
        // ignore, let caller handle
      }
    }

    return res;
  });
}

function shouldTriggerRefresh(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return url.startsWith('/api/') && !url.startsWith('/api/session/');
}

/**
 * Replaces window.fetch with apiFetch so existing call sites do not need to be touched.
 * Call once at app startup.
 */
export function installApiClient(): void {
  if (installed) return;
  installed = true;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return apiFetch(input, init ?? {});
  }) as typeof window.fetch;
  (window as unknown as { __originalFetch?: typeof fetch }).__originalFetch = nativeFetch;
}
