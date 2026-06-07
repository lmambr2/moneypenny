import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import router from '../router/index.js';

const api = axios.create();

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    const data = error.response?.data || {};
    const url = error.config?.url || '';

    const playerStore = usePlayerStore();

    if (status === 401 && url.startsWith('/api/') && !url.startsWith('/api/session/')) {
      try {
        // Dynamic import to avoid circular deps if any
        const { useSession } = await import('../composables/useSession.js');
        const session = useSession();
        await session.refresh();
        const current = router.currentRoute.value;
        if (current.name !== 'login' && current.name !== 'first-run') {
          await router.replace({ name: 'login', query: { next: current.fullPath } });
        }
      } catch (e) {
        // ignore
      }
    }

    if (status === 429 || status === 403) {
      const msg = data?.message || data?.error || (status === 429 ? 'Rate limited. Please slow down.' : 'Permission denied.');
      const code = data?.code ? ` (code: ${data.code})` : '';
      const retryAfter = data?.retryAfter ? Number(data.retryAfter) : undefined;
      playerStore.notify(`${msg}${code}`, 'error', retryAfter);
    } else if (status >= 500 && url.startsWith('/api/')) {
      // Only auto-notify for server errors; 4xx (like 404) are often expected and handled by caller
      const msg = data?.message || data?.error || 'Request failed';
      const code = data?.code ? ` (code: ${data.code})` : '';
      playerStore.notify(`${msg}${code}`, 'error');
    }

    return Promise.reject(error);
  }
);

export default api;
