import { computed, readonly, ref } from 'vue';
import api from '../api/axios.js';

interface User {
  id: string;
  username: string;
  role: 'admin' | 'member';
}

const currentUser = ref<User | null>(null);
const needsSetup = ref<boolean | null>(null); // null = unknown / not fetched yet
const ready = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 60_000;

function ensurePollStarted() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    if (currentUser.value !== null) {
      // Best-effort refresh; ignore errors (network blips etc.)
      refreshMe().catch(() => {});
    }
  }, POLL_INTERVAL_MS);
}

function stopPoll() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshNeedsSetup(): Promise<void> {
  const retries = 3;
  const delayMs = 300;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await api.get<{ needsSetup: boolean }>('/api/session/needs-setup');
      needsSetup.value = Boolean(res.data.needsSetup);
      return;
    } catch {
      // transient network / server-startup hiccup — retry
    }
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // final failure: leave as null; guard treats it as "not first-run" (server is source of truth)
  // eslint-disable-next-line no-console
  console.warn(
    '[useSession] Failed to determine needs-setup state after retries (check server logs /api/health)',
  );
}

async function refreshMe(): Promise<void> {
  try {
    const res = await api.get<User>('/api/session/me');
    currentUser.value = res.data;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      currentUser.value = null;
      return;
    }
    throw err;
  }
}

async function refresh(): Promise<void> {
  await refreshNeedsSetup();
  if (needsSetup.value) {
    currentUser.value = null;
  } else {
    await refreshMe();
  }
  ready.value = true;
  ensurePollStarted();
}

async function login(username: string, password: string): Promise<void> {
  try {
    const res = await api.post<User>('/api/session/login', { username, password });
    currentUser.value = res.data;
  } catch (err: unknown) {
    const data = (err as { response?: { data?: { error?: string }; status?: number } })?.response;
    throw new Error(data?.data?.error ?? `login failed (${data?.status ?? 'unknown'})`);
  }
}

async function setup(username: string, password: string): Promise<void> {
  try {
    const res = await api.post<User>('/api/session/setup', { username, password });
    currentUser.value = res.data;
    needsSetup.value = false;
  } catch (err: unknown) {
    const data = (err as { response?: { data?: { error?: string }; status?: number } })?.response;
    throw new Error(data?.data?.error ?? `setup failed (${data?.status ?? 'unknown'})`);
  }
}

async function logout(): Promise<void> {
  stopPoll();
  try {
    await api.post('/api/session/logout');
  } catch {
    // still clear local state
  }
  currentUser.value = null;
}

export function useSession() {
  return {
    currentUser: readonly(currentUser),
    needsSetup: readonly(needsSetup),
    isAuthenticated: computed(() => currentUser.value !== null),
    isAdmin: computed(() => currentUser.value?.role === 'admin'),
    ready: readonly(ready),
    refresh,
    login,
    logout,
    setup,
  };
}
