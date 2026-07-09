<template>
  <div class="home">
    <!-- Search Bar -->
    <div class="search-bar" @click="$router.push('/search')">
      <Icon icon="mdi:magnify" class="search-icon" />
      <span class="search-placeholder">Search songs, playlists, albums…</span>
    </div>

    <!-- Now Playing -->
    <section v-if="store.currentSong" class="section">
      <h2 class="section-title">Now Playing</h2>
      <div class="now-playing">
        <CoverArt :url="store.currentSong.coverUrl" :size="80" :radius="10" :show-shadow="true" />
        <div class="now-playing-info">
          <div class="now-playing-name">{{ store.currentSong.name }}</div>
          <div class="now-playing-artist">{{ store.currentSong.artist }} · {{ store.currentSong.album }}</div>
        </div>
      </div>
    </section>

    <!-- Local Quick Picks (primary source) -->
    <section v-if="store.localRecent.length" class="section">
      <h2 class="section-title">Local Library — Recent</h2>
      <div class="rec-grid">
        <SongCard
          v-for="(song, i) in store.localRecent.slice(0, 8)"
          :key="`local-${i}`"
          :song="song"
          :index="i + 1"
          @play="store.play(song.name, 'local')"
          @playNext="store.playNextSong(song)"
          @add="store.addToQueue(song.name, 'local')"
        />
      </div>
    </section>

    <!-- My Playlists -->
    <section class="section" v-if="userAvailable.length > 0">
      <h2 class="section-title">
        My Playlists
        <span v-if="currentUserPlaylists.length > 0" class="section-count">{{ currentUserPlaylists.length }}</span>
        <SourceTabs v-model="userSource" :sources="userAvailable" />
      </h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="pl in visibleUserPlaylists"
          :key="pl.id"
          :to="`/playlist/${pl.id}?platform=${pl.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ pl.name }}</div>
          <div class="playlist-count">{{ pl.songCount }} tracks</div>
        </RouterLink>
      </div>
      <button
        v-if="currentUserPlaylists.length > USER_PLAYLIST_LIMIT"
        class="expand-btn"
        @click="userPlaylistsExpanded = !userPlaylistsExpanded"
      >
        <Icon :icon="userPlaylistsExpanded ? 'mdi:chevron-up' : 'mdi:chevron-down'" />
        {{ userPlaylistsExpanded ? 'Collapse' : `Show all ${currentUserPlaylists.length} playlists` }}
      </button>
    </section>

    <!-- Local Recent (primary) -->
    <section class="section" v-if="store.localRecent.length > 0">
      <h2 class="section-title">Local Library — Recent</h2>
      <div class="daily-grid">
        <div
          v-for="song in store.localRecent.slice(0, 12)"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playSong(song)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>

    <!-- YouTube placeholder -->
    <section class="section" v-if="store.youtubeTrending.length > 0">
      <h2 class="section-title">YouTube</h2>
      <div class="daily-grid">
        <div
          v-for="song in store.youtubeTrending.slice(0, 8)"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playSong(song)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, onMounted, ref, watch } from 'vue';
import api from '../api/axios.js';
import CoverArt from '../components/CoverArt.vue';
import SourceTabs from '../components/SourceTabs.vue';
import { type Song, type Source, usePlayerStore } from '../stores/player.js';
import { loadTabSource, saveTabSource } from '../stores/sourceTabs.js';

const store = usePlayerStore();
const USER_PLAYLIST_LIMIT = 20;
const userPlaylistsExpanded = ref(false);

// For the new Local/YouTube/Stream world, we keep simple source selection
// but default heavily to local.
const userAvailable = computed<Source[]>(() => store.availableSources);
const userSource = ref<Source>(loadTabSource('home.user'));
watch(userSource, (v) => saveTabSource('home.user', v));

// For now, user playlists in home are stubbed (real implementation would
// come from LocalProvider playlists or YouTube playlists via future bridge).
const currentUserPlaylists = computed(() => [] as any[]);
const visibleUserPlaylists = computed(() =>
  userPlaylistsExpanded.value
    ? currentUserPlaylists.value
    : currentUserPlaylists.value.slice(0, USER_PLAYLIST_LIMIT),
);

onMounted(() => {
  store.fetchHomeData();
});
</script>

<style lang="scss" scoped>
.search-bar {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  margin-bottom: 32px;
  cursor: pointer;
  transition: background var(--transition-fast);

  &:hover { background: var(--hover-bg); }
}

.search-icon {
  font-size: 20px;
  opacity: 0.4;
  margin-right: 12px;
}

.search-placeholder {
  opacity: 0.3;
  font-size: 14px;
}

.section {
  margin-bottom: 36px;

  @media (max-width: 768px) {
    margin-bottom: 28px;
  }
}

.section-title {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;

  @media (max-width: 768px) {
    font-size: 18px;
    margin-bottom: 12px;
  }
}

.section-count {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-tertiary);
}

.expand-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  padding: 10px;
  margin-top: 12px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  transition: all var(--transition-fast);

  &:hover {
    background: var(--hover-bg);
    color: var(--color-primary);
  }
}

.bili-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: var(--accent-cyan);
  color: white;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 800;
}

// Now Playing
.now-playing {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
}

.now-playing-name {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 4px;
}

.now-playing-artist {
  font-size: 13px;
  color: var(--text-secondary);
}

.daily-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 20px;

  @media (max-width: 1200px) { grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 900px) { grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 768px) { grid-template-columns: repeat(3, 1fr); gap: 14px; }
}

.daily-card {
  cursor: pointer;
  min-width: 0;
}

.daily-name {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.daily-artist {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

// Playlists grid (shared)
.playlist-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 24px;

  @media (max-width: 1200px) { grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 900px) { grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 768px) { grid-template-columns: repeat(3, 1fr); gap: 14px; }
}

.playlist-card {
  cursor: pointer;
  display: block;
  text-decoration: none;
  color: inherit;
}

.playlist-name {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.playlist-count {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
</style>
