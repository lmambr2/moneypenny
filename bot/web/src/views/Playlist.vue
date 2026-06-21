<template>
  <div class="playlist-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      Back
    </button>
    <div v-if="loading" class="loading">Loading…</div>

    <template v-else-if="playlist">
      <!-- Hero Header -->
      <div class="playlist-hero">
        <CoverArt :url="playlist.coverUrl" :size="200" :radius="14" :show-shadow="true" />
        <div class="playlist-meta">
          <h1 class="playlist-title">{{ playlist.name }}</h1>
          <p class="playlist-desc" v-if="playlist.description">{{ playlist.description }}</p>
          <div class="playlist-stats">
            {{ songs.length }} tracks
          </div>
          <button class="play-all-btn" @click="playAll">
            <Icon icon="mdi:play" />
            Play All
          </button>
        </div>
      </div>

      <!-- Song List -->
      <div class="song-list">
        <SongCard
          v-for="(song, i) in songs"
          :key="song.id"
          :song="song"
          :index="i + 1"
          :active="store.currentSong?.id === song.id"
          @play="store.playSong(song)"
          @playNext="store.playNextSong(song)"
          @add="store.addSong(song)"
        />
      </div>
    </template>

    <div v-else class="loading">{{ kind === 'album' ? 'Album' : 'Playlist' }} not found or failed to load</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { Icon } from '@iconify/vue';
import api from '../api/axios.js';
import { usePlayerStore } from '../stores/player.js';
import CoverArt from '../components/CoverArt.vue';
import SongCard from '../components/SongCard.vue';

const store = usePlayerStore();
const route = useRoute();

import { Song, type Source } from '../stores/player.js';

interface PlaylistDetail {
  id: string;
  name: string;
  description: string;
  coverUrl: string;
  songCount: number;
}

const kind = (route.meta.kind as string) ?? 'playlist'; // 'playlist' | 'album'

const playlist = ref<PlaylistDetail | null>(null);
const songs = ref<Song[]>([]);
const loading = ref(true);

async function playAll() {
  const id = route.params.id as string;
  const platform = (route.query.platform as Source) || 'local';
  if (kind === 'album') {
    await store.playAlbum(id, platform);
  } else {
    await store.playPlaylist(id, platform);
  }
}

onMounted(async () => {
  const id = route.params.id as string;
  const platform = (route.query.platform as Source) || 'local';

  const detailUrl = kind === 'album'
    ? `/api/music/album/${id}/detail`
    : `/api/music/playlist/${id}/detail`;
  const songsUrl = kind === 'album'
    ? `/api/music/album/${id}`
    : `/api/music/playlist/${id}`;

  // allSettled, not Promise.all — if detail 404s but songs is fine
  // (e.g., a playlist whose detail endpoint flaked but the song list
  // resolved), we still want to show the songs rather than
  // the "not found" empty state. For albums, detail always 404s — that
  // is intentional; the fallback stub below handles it.
  const [detailRes, songsRes] = await Promise.allSettled([
    api.get(detailUrl, { params: { platform } }),
    api.get(songsUrl, { params: { platform } }),
  ]);

  const detail = detailRes.status === 'fulfilled' ? detailRes.value.data?.playlist : null;
  const songList = songsRes.status === 'fulfilled' ? (songsRes.value.data?.songs ?? []) : [];

  if (detail) {
    playlist.value = detail;
  } else if (songList.length > 0) {
    // Fall back to a stub built from the route + first song. For albums,
    // every song's `album` field carries the real album name.
    const fallbackName = kind === 'album'
      ? (songList[0]?.album || 'Album')
      : 'Playlist';
    playlist.value = {
      id,
      name: fallbackName,
      description: '',
      coverUrl: songList[0]?.coverUrl ?? '',
      songCount: songList.length,
    };
  } else {
    playlist.value = null;
    if (detailRes.status === 'rejected') {
      console.error('Failed to load detail:', (detailRes.reason as any)?.response?.status, (detailRes.reason as any)?.message);
    }
  }
  songs.value = songList;
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

.playlist-hero {
  display: flex;
  gap: 32px;
  margin-bottom: 36px;
}

.playlist-meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.playlist-title {
  font-size: 28px;
  font-weight: 800;
  margin-bottom: 8px;
}

.playlist-desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.playlist-stats {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 16px;
}

.play-all-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 28px;
  background: var(--color-primary);
  color: white;
  border-radius: var(--radius-lg);
  font-size: 14px;
  font-weight: 600;
  width: fit-content;
  transition: transform var(--transition-fast);

  &:hover { transform: scale(1.04); }
  &:active { transform: scale(0.96); }
}

.song-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.loading {
  text-align: center;
  padding: 60px;
  color: var(--text-secondary);
}
</style>
