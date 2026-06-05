<template>
  <div class="auth-page">
    <form class="auth-card" @submit.prevent="submit">
      <h1>First-time Setup</h1>
      <p class="auth-hint">Create an administrator account. This account will have full control over the WebUI.</p>
      <label>
        <span>Username</span>
        <input v-model="username" type="text" autocomplete="username" autofocus required />
      </label>
      <label>
        <span>Password (min 8 characters)</span>
        <input v-model="password" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <label>
        <span>Confirm password</span>
        <input v-model="confirm" type="password" autocomplete="new-password" minlength="8" required />
      </label>
      <p v-if="error" class="auth-error">{{ error }}</p>
      <button type="submit" :disabled="loading">{{ loading ? 'Creating…' : 'Create Admin Account' }}</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSession } from '../composables/useSession.js';

const username = ref('');
const password = ref('');
const confirm = ref('');
const error = ref('');
const loading = ref(false);
const router = useRouter();
const session = useSession();

async function submit() {
  error.value = '';
  if (password.value !== confirm.value) {
    error.value = 'Passwords do not match';
    return;
  }
  loading.value = true;
  try {
    await session.setup(username.value, password.value);
    router.replace('/');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped lang="scss">
.auth-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg-primary); }
.auth-card {
  width: 360px; padding: 32px; background: var(--bg-secondary);
  border-radius: var(--radius-md); display: flex; flex-direction: column; gap: 12px;
  box-shadow: var(--shadow-dropdown);
}
.auth-card h1 { margin: 0; font-size: 20px; color: var(--text-primary); }
.auth-hint { margin: 0 0 4px; font-size: 12px; color: var(--text-secondary); }
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
