<template>
  <div class="search-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      Back
    </button>
    <div class="search-header">
      <div class="search-input-wrap">
        <Icon icon="mdi:magnify" class="search-icon" />
        <input
          ref="searchInput"
          v-model="query"
          class="search-input"
          placeholder="Search songs, artists, albums…"
          @keyup.enter="doSearch"
          autofocus
        />
      </div>
    </div>

    <div v-if="loading" class="loading">Searching…</div>

    <template v-else-if="allSongs.length || allAlbums.length || allPlaylists.length">
      <div class="source-bar">
        <button
          class="source-btn"
          :class="{ active: selectedSource === 'local' }"
          @click="selectedSource = 'local'"
        >Local</button>
        <button
          class="source-btn"
          :class="{ active: selectedSource === 'youtube' }"
          @click="selectedSource = 'youtube'"
        >YouTube</button>
        <button
          class="source-btn"
          :class="{ active: selectedSource === 'stream' }"
          @click="selectedSource = 'stream'"
        >Stream</button>
      </div>

      <div class="tab-bar">
        <button
          class="tab"
          :class="{ active: activeTab === 'songs' }"
          @click="activeTab = 'songs'"
        >
          Songs<span class="tab-count">{{ filteredSongs.length }}</span>
        </button>
        <button
          class="tab"
          :class="{ active: activeTab === 'albums' }"
          @click="activeTab = 'albums'"
        >
          Albums<span class="tab-count">{{ filteredAlbums.length }}</span>
        </button>
        <button
          class="tab"
          :class="{ active: activeTab === 'playlists' }"
          @click="activeTab = 'playlists'"
        >
          Playlists<span class="tab-count">{{ filteredPlaylists.length }}</span>
        </button>
      </div>

      <section v-if="activeTab === 'albums' && filteredAlbums.length" class="result-section">
        <div class="card-grid">
          <router-link
            v-for="al in filteredAlbums"
            :key="`${al.platform}-${al.id}`"
            :to="`/album/${al.id}?platform=${al.platform}`"
            class="card hover-scale"
          >
            <CoverArt :url="al.coverUrl" :size="160" :radius="10" :show-shadow="true" />
            <div class="card-name">
              {{ al.name }}
              <span class="platform-badge" :class="badgeClass(al.platform)">{{ badgeLabel(al.platform) }}</span>
            </div>
            <div class="card-sub">{{ al.artist }}</div>
          </router-link>
        </div>
      </section>

      <section v-if="activeTab === 'playlists' && filteredPlaylists.length" class="result-section">
        <div class="card-grid">
          <router-link
            v-for="pl in filteredPlaylists"
            :key="`${pl.platform}-${pl.id}`"
            :to="`/playlist/${pl.id}?platform=${pl.platform}`"
            class="card hover-scale"
          >
            <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
            <div class="card-name">
              {{ pl.name }}
              <span class="platform-badge" :class="badgeClass(pl.platform)">{{ badgeLabel(pl.platform) }}</span>
            </div>
          </router-link>
        </div>
      </section>

      <section v-if="activeTab === 'songs' && filteredSongs.length" class="result-section">
        <SongCard
          v-for="(song, i) in filteredSongs"
          :key="`${song.platform}-${song.id}`"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.playSong(song)"
          @playNext="store.playNextSong(song)"
          @add="store.addSong(song)"
        />
      </section>
    </template>

    <div v-else-if="searched" class="empty">No results found</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import type { Song } from '../stores/player.js';
import SongCard from '../components/SongCard.vue';
import CoverArt from '../components/CoverArt.vue';

const store = usePlayerStore();
const route = useRoute();
const router = useRouter();

const SOURCE_STORAGE_KEY = 'search-source';

function loadSource(): 'local' | 'youtube' | 'stream' {
  try {
    const stored = localStorage.getItem(SOURCE_STORAGE_KEY);
    if (stored === 'local' || stored === 'youtube' || stored === 'stream') return stored as any;
  } catch { /* localStorage blocked */ }
  return 'local';
}

const query = ref((route.query.q as string) || '');
const activeTab = ref<'songs' | 'albums' | 'playlists'>('songs');
const selectedSource = ref<'local' | 'youtube' | 'stream'>(loadSource());

interface Album { id: string; name: string; artist: string; coverUrl: string; songCount?: number; platform: string; }
interface Playlist { id: string; name: string; coverUrl: string; songCount?: number; platform: string; }

const allSongs = ref<Song[]>([]);
const allAlbums = ref<Album[]>([]);
const allPlaylists = ref<Playlist[]>([]);
const loading = ref(false);
const searched = ref(false);

const filteredSongs = computed(() =>
  allSongs.value.filter((s) => s.platform === selectedSource.value)
);

const filteredAlbums = computed(() =>
  allAlbums.value.filter((a) => a.platform === selectedSource.value)
);

const filteredPlaylists = computed(() =>
  allPlaylists.value.filter((p) => p.platform === selectedSource.value)
);

// Persist source preference
watch(selectedSource, (src) => {
  try { localStorage.setItem(SOURCE_STORAGE_KEY, src); } catch (e) { console.warn('Failed to save source', e); }
});

// Note: old Chinese platforms removed; tabs simplified for Local/YouTube/Stream
watch(selectedSource, (src) => {
  if (src === 'stream' && activeTab.value !== 'songs') {
    activeTab.value = 'songs';
  }
});

async function doSearch() {
  if (!query.value.trim()) return;
  loading.value = true;
  searched.value = true;
  activeTab.value = 'songs';
  router.replace({ query: { q: query.value } });
  try {
    const res = await axios.get('/api/music/search/all', { params: { q: query.value } });
    allSongs.value = res.data.songs ?? [];
    allAlbums.value = res.data.albums ?? [];
    allPlaylists.value = res.data.playlists ?? [];
  } catch {
    allSongs.value = []; allAlbums.value = []; allPlaylists.value = [];
  } finally {
    loading.value = false;
  }
}

function badgeLabel(platform: string): string {
  if (platform === 'youtube') return 'YouTube';
  if (platform === 'stream') return 'Stream';
  return 'Local';
}

function badgeClass(platform: string): string {
  if (platform === 'youtube') return 'badge-youtube';
  if (platform === 'stream') return 'badge-stream';
  return 'badge-local';
}

onMounted(() => {
  if (query.value) doSearch();
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

.search-header {
  margin-bottom: 24px;
}

.search-input-wrap {
  display: flex;
  align-items: center;
  padding: 14px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
}

.search-icon {
  font-size: 22px;
  opacity: 0.4;
  margin-right: 12px;
}

.search-input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 16px;
  font-family: inherit;
  color: var(--text-primary);

  &::placeholder {
    color: var(--text-tertiary);
  }
}

.loading {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

.empty {
  text-align: center;
  padding: 60px;
  color: var(--text-tertiary);
  font-size: 14px;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.source-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.source-btn {
  padding: 5px 16px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-family: inherit;
  font-weight: var(--fw-semi);
  color: var(--text-secondary);
  background: var(--bg-card);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;

  &:hover { color: var(--text-primary); }

  &.active {
    color: var(--color-primary);
    background: rgba(51, 94, 234, 0.12);
  }
}

.tab-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 24px;
  padding: 4px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  width: fit-content;
}

.tab {
  padding: 8px 20px;
  border-radius: calc(var(--radius-md) - 2px);
  font-size: 14px;
  font-family: inherit;
  font-weight: var(--fw-semi);
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;

  &:hover { color: var(--text-primary); }

  &.active {
    background: var(--color-primary);
    color: #fff;
    .tab-count { opacity: 0.85; }
  }
}

.tab-count {
  margin-left: 5px;
  opacity: 0.55;
  font-weight: var(--fw-regular);
  font-size: 13px;

  &::before { content: '('; }
  &::after  { content: ')'; }
}

.result-section {
  margin-bottom: 32px;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px 28px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-decoration: none;
  color: inherit;
  .card-name { font-size: 14px; line-height: 1.3; max-height: 2.6em; overflow: hidden; }
  .card-sub  { font-size: 12px; opacity: 0.6; }
}

.platform-badge {
  vertical-align: middle;
  flex-shrink: 0;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semi);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  line-height: 1.4;
}

.badge-youtube {
  background: var(--brand-youtube-12);
  color: var(--brand-youtube);
}
</style>
