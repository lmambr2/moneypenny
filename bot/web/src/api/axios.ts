import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import router from '../router/index.js';

const api = axios.create({ withCredentials: true });

function apiUrl(configUrl: string | undefined): string {
  return configUrl ?? '';
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
    (status === 429 ? 'Rate limited. Please slow down.' : status === 403 ? 'Permission denied.' : 'Request failed');
  const code = typeof data?.code === 'string' ? ` (code: ${data.code})` : '';
  const retryAfter = data?.retryAfter != null ? Number(data.retryAfter) : undefined;
  playerStore.notify(`${msg}${code}`, severity, retryAfter);
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    const data = (error.response?.data ?? {}) as Record<string, unknown>;
    const url = apiUrl(error.config?.url);

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

    if (url.startsWith('/api/')) {
      if (status === 429 || status === 403) {
        notifyFromPayload(data, status, 'error');
      } else if (status != null && status >= 500) {
        notifyFromPayload(data, status, 'error');
      } else if (status != null && status >= 400 && (data.message || data.error)) {
        notifyFromPayload(data, status, 'info');
      }
    }

    return Promise.reject(error);
  },
);

export default api;