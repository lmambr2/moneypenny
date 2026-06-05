<template>
  <div class="library-page">
    <h1 class="page-title">Library</h1>

    <!-- Local Library (Primary) -->
    <section class="section">
      <h2 class="section-title">
        Local Music Library
        <span v-if="store.localRecent.length > 0" class="section-count">{{ store.localRecent.length }}</span>
      </h2>
      <div v-if="store.localRecent.length === 0" class="empty">
        Local library is empty or not yet indexed. Add music files to MUSIC_DIR and restart the server.
      </div>
      <div v-else class="song-list">
        <SongCard
          v-for="(song, i) in store.localRecent.slice(0, 20)"
          :key="`local-${song.id}-${i}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.play(song.name, 'local')"
          @playNext="store.playNextSong(song)"
          @add="store.addToQueue(song.name, 'local')"
        />
      </div>
    </section>

    <!-- Recent Plays (across sources) -->
    <section class="section">
      <h2 class="section-title">Recently Played</h2>
      <div v-if="historyLoading" class="loading">Loading…</div>
      <div v-else-if="history.length === 0" class="empty">No play history yet</div>
      <div v-else class="song-list">
        <SongCard
          v-for="(song, i) in history.slice(0, 10)"
          :key="`hist-${song.id}-${i}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.play(song.name, song.platform)"
          @playNext="store.playNextSong(song)"
          @add="store.addToQueue(song.name, song.platform)"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore, type Song, type Source } from '../stores/player.js';
import { loadTabSource, saveTabSource } from '../stores/sourceTabs.js';
import CoverArt from '../components/CoverArt.vue';
import SongCard from '../components/SongCard.vue';
import SourceTabs from '../components/SourceTabs.vue';

const store = usePlayerStore();

const history = ref<Song[]>([]);
const historyLoading = ref(true);

const userAvailable = computed<Source[]>(() => store.availableSources);

const userSource = ref<Source>(loadTabSource('library.user', 'local'));
watch(userSource, (v) => saveTabSource('library.user', v));

onMounted(async () => {
  if (!store.activeBotId) {
    await store.fetchBots();
  }

  store.fetchHomeData();

  if (store.activeBotId) {
    try {
      const res = await axios.get(`/api/player/${store.activeBotId}/history`);
      history.value = res.data.history ?? [];
    } catch {
      // API may not be ready
    }
  }

  historyLoading.value = false;
});
</script>

<style lang="scss" scoped>
.page-title {
  font-size: var(--fs-hero);
  font-weight: var(--fw-bold);
  margin-bottom: 24px;
}

.section {
  margin-bottom: 36px;
}

.section-title {
  font-size: var(--fs-hero);
  font-weight: var(--fw-bold);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-count {
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  color: var(--text-tertiary);
}

.playlist-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 24px;

  @media (max-width: 1200px) { grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 900px) { grid-template-columns: repeat(3, 1fr); }
}

.playlist-card {
  cursor: pointer;
  display: block;
  text-decoration: none;
  color: inherit;
}

.playlist-name {
  margin-top: 8px;
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.playlist-count {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  margin-top: 2px;
}

.song-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.loading {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

.empty {
  text-align: center;
  padding: 40px;
  color: var(--text-tertiary);
  font-size: var(--fs-body);
}

.empty-state {
  text-align: center;
  padding: 80px 20px;
  color: var(--text-tertiary);
  font-size: var(--fs-body);
}

.empty-icon {
  font-size: 48px;
  opacity: 0.3;
  margin-bottom: 16px;
}
</style>
