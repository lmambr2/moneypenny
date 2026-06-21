<template>
  <div class="history-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      Back
    </button>
    <h1 class="page-title">Play History</h1>

    <div v-if="loading" class="loading">Loading…</div>

    <div v-else-if="history.length === 0" class="empty">
      No play history yet
    </div>

    <div v-else class="history-list">
      <SongCard
        v-for="(song, i) in history"
        :key="`${song.id}-${i}`"
        :song="song"
        :index="i + 1"
        :active="store.currentSong?.id === song.id"
        @play="store.playSong(song)"
        @playNext="store.playNextSong(song)"
        @add="store.addSong(song)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import api from '../api/axios.js';
import { usePlayerStore } from '../stores/player.js';
import SongCard from '../components/SongCard.vue';

const store = usePlayerStore();

import { Song } from '../stores/player.js';

const history = ref<Song[]>([]);
const loading = ref(true);

onMounted(async () => {
  if (!store.activeBotId) {
    await store.fetchBots();
  }

  if (store.activeBotId) {
    try {
      const res = await api.get(`/api/player/${store.activeBotId}/history`);
      history.value = res.data.history;
    } catch (err: any) {
      if (err?.response?.status !== 404) {
        const playerStore = usePlayerStore();
        const msg = err?.response?.data?.message || err?.response?.data?.error || 'Failed to load history';
        playerStore.notify(msg, 'error');
      }
    }
  }

  loading.value = false;
});
</script>

<style lang="scss" scoped>
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  opacity: 0.7;
  margin-bottom: 16px;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.page-title {
  font-size: 28px;
  font-weight: 800;
  margin-bottom: 24px;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.loading {
  text-align: center;
  padding: 60px;
  color: var(--text-secondary);
}

.empty {
  text-align: center;
  padding: 80px;
  color: var(--text-tertiary);
  font-size: 14px;
}
</style>
