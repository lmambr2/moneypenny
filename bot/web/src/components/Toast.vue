<template>
  <Transition name="toast">
    <div v-if="visible && current" class="toast" :class="`toast--${current.type}`">
      <Icon :icon="current.type === 'error' ? 'mdi:alert-circle' : 'mdi:information'" class="toast-icon" />
      <span class="toast-msg">{{ current.message }}</span>
      <button class="toast-close" @click="visible = false" aria-label="Close">
        <Icon icon="mdi:close" />
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { Icon } from '@iconify/vue';
import { usePlayerStore } from '../stores/player.js';

const store = usePlayerStore();
const visible = ref(false);
const current = ref<{ id: number; message: string; type: 'error' | 'info'; retryAfter?: number } | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let baseMessage = '';
let initialRetryAfter = 0;

watch(
  () => store.notification?.id,
  () => {
    if (!store.notification) return;
    // Clear any previous countdown
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    current.value = store.notification;
    visible.value = true;
    baseMessage = current.value.message;
    initialRetryAfter = current.value.retryAfter || 0;

    if (initialRetryAfter > 0) {
      // Start live countdown
      let secondsLeft = initialRetryAfter;
      const updateCountdown = () => {
        if (secondsLeft <= 0) {
          if (countdownInterval) clearInterval(countdownInterval);
          visible.value = false;
          // Clear the notification in store so it doesn't re-trigger
          store.notification = null;
          return;
        }
        current.value = {
          ...current.value!,
          message: `${baseMessage} (retry in ${secondsLeft}s)`,
        };
        secondsLeft--;
      };
      updateCountdown(); // initial
      countdownInterval = setInterval(updateCountdown, 1000);
    } else {
      timer = setTimeout(() => {
        visible.value = false;
      }, current.value.type === 'error' ? 5000 : 3000);
    }
  }
);

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  if (countdownInterval) clearInterval(countdownInterval);
});
</script>

<style lang="scss" scoped>
.toast {
  position: fixed;
  left: 50%;
  bottom: calc(var(--player-height) + 24px);
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  max-width: min(90vw, 480px);
  background: var(--bg-card);
  backdrop-filter: blur(20px);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-dropdown);
  font-size: var(--fs-body);
  color: var(--text-primary);
  z-index: 1000;

  @media (max-width: 768px) {
    bottom: calc(var(--player-height) + 60px);  // sit above mobile tabbar
  }
}

.toast--error {
  border-color: var(--color-danger);
  .toast-icon { color: var(--color-danger); }
}

.toast--info {
  border-color: var(--color-primary);
  .toast-icon { color: var(--color-primary); }
}

.toast-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.toast-msg {
  flex: 1;
  line-height: 1.4;
}

.toast-close {
  flex-shrink: 0;
  font-size: 18px;
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  cursor: pointer;
  &:hover { color: var(--text-primary); }
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>
