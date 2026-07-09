<template>
  <div class="auth-page">
    <form class="auth-card" @submit.prevent="submit">
      <h1>Login to Moneypenny</h1>
      <label>
        <span>Username</span>
        <input v-model="username" type="text" autocomplete="username" autofocus required />
      </label>
      <label>
        <span>Password</span>
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>
      <p v-if="error" class="auth-error">{{ error }}</p>
      <button type="submit" :disabled="loading">{{ loading ? 'Logging in…' : 'Log In' }}</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../composables/useSession.js';

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const router = useRouter();
const route = useRoute();
const session = useSession();

onMounted(async () => {
  // Re-check in case the initial router guard saw a transient null (e.g. server still starting).
  // If needsSetup resolves to true, jump to the first-run form.
  if (session.needsSetup.value === null || !session.ready.value) {
    try {
      await session.refresh();
    } catch {
      // best-effort; stay on login if refresh fails
    }
  }
  if (session.needsSetup.value === true) {
    router.replace({ name: 'first-run' });
  }
});

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await session.login(username.value, password.value);
    const rawNext = typeof route.query.next === 'string' ? route.query.next : '/';
    const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
    router.replace(next);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped lang="scss">
.auth-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
}
.auth-card {
  width: 360px;
  padding: 32px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-shadow: var(--shadow-dropdown);
}
.auth-card h1 { margin: 0 0 8px; font-size: 20px; color: var(--text-primary); }
.auth-card label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.auth-card input {
  height: 36px; padding: 0 10px; border-radius: var(--radius-sm);
  background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color);
}
.auth-card button {
  height: 38px; border-radius: var(--radius-sm); border: 0;
  background: var(--color-primary); color: #fff; font-weight: 500; cursor: pointer;
}
.auth-card button:disabled { opacity: 0.6; cursor: progress; }
.auth-error { color: #e26a6a; font-size: 13px; margin: 0; }
</style>
