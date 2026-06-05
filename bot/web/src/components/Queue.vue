<template>
  <div class="queue-panel" :class="{ open }">
    <div class="queue-header">
      <h3 class="queue-title">Play Queue</h3>
      <span class="queue-count">{{ botQueue.length }} tracks</span>
      <button 
        v-if="botQueue.length > 0"
        class="clear-btn" 
        @click="clearAndStop" 
        title="Clear queue and stop playback"
      >
        <Icon icon="mdi:stop-circle-outline" />
      </button>
      <button class="close-btn" @click="$emit('close')">
        <Icon icon="mdi:close" />
      </button>
    </div>

    <div v-if="botQueue.length === 0" class="queue-empty">
      Queue is empty
    </div>

    <div v-else class="queue-list">
      <div
        v-for="(song, i) in botQueue"
        :key="`${song.id}-${i}`"
        class="queue-item"
        :class="{ active: store.currentSong?.id === song.id }"
        @dblclick="playAtIndex(i)"
      >
        <CoverArt :url="song.coverUrl" :size="32" :radius="4" />
        <div class="queue-song-info">
          <div class="queue-song-name">{{ song.name }}</div>
          <div class="queue-song-artist">{{ song.artist }}</div>
        </div>
        <button class="remove-btn" @click="removeSong(i)" title="Remove">
          <Icon icon="mdi:close" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch, computed } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import CoverArt from './CoverArt.vue';

const props = defineProps<{
  open: boolean;
}>();

defineEmits<{
  close: [];
}>();

const store = usePlayerStore();
const botQueue = computed(() => store.queue);

// Fetch queue when panel opens
watch(() => props.open, (isOpen) => {
  if (isOpen) store.fetchQueue();
});

async function playAtIndex(index: number) {
  await store.playAtIndex(index);
  await store.fetchQueue();
}

async function removeSong(index: number) {
  if (!store.activeBotId) return;
  try {
    await axios.delete(`/api/player/${store.activeBotId}/queue/${index + 1}`);
    await store.fetchQueue();
  } catch {
    // Ignore
  }
}

async function clearAndStop() {
  try {
    await store.stop();
    await store.fetchQueue();
  } catch {
    // Ignore
  }
}
</script>

<style lang="scss" scoped>
.queue-panel {
  position: fixed;
  top: var(--navbar-height);
  right: -360px;
  bottom: var(--player-height);
  width: 360px;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  z-index: 90;
  transition: right var(--transition-normal);
  display: flex;
  flex-direction: column;

  &.open {
    right: 0;
  }
}

.queue-header {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.queue-title {
  font-size: 16px;
  font-weight: 700;
}

.queue-count {
  margin-left: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.close-btn {
  margin-left: auto;
  font-size: 18px;
  opacity: 0.6;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.clear-btn {
  font-size: 18px;
  opacity: 0.6;
  transition: opacity var(--transition-fast);
  color: var(--text-primary);
  &:hover { opacity: 1; }
}

.queue-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.queue-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
  cursor: pointer;
  user-select: none;

  &:hover {
    background: var(--hover-bg);
    .remove-btn { opacity: 1; }
  }

  &.active {
    background: var(--color-primary-10);
  }
}

.queue-song-info {
  flex: 1;
  min-width: 0;
}

.queue-song-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-song-artist {
  font-size: 11px;
  color: var(--text-secondary);
}

.remove-btn {
  font-size: 14px;
  opacity: 0;
  padding: 4px;
  border-radius: var(--radius-sm);
  transition: opacity var(--transition-fast);
  color: var(--text-tertiary);
  &:hover { color: var(--text-primary); }
}
</style>
