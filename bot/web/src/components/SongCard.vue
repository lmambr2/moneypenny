<template>
  <div class="song-card" :class="{ active, blacklisted }" @dblclick="$emit('play')">
    <div class="song-index">{{ index }}</div>
    <CoverArt :url="song.coverUrl" :size="36" :radius="6" />
    <div class="song-info">
      <div class="song-name-row">
        <span class="song-name">{{ song.name }}</span>
        <span
          class="platform-badge"
          :class="song.platform === 'youtube' ? 'badge-youtube' : song.platform === 'stream' ? 'badge-stream' : 'badge-local'"
        >{{ song.platform === 'youtube' ? 'YouTube' : song.platform === 'stream' ? 'Stream' : 'Local' }}</span>
      </div>
      <div class="song-artist">{{ song.artist }}</div>
    </div>
    <div class="song-album">{{ song.album }}</div>
    <div class="song-duration">{{ formatDuration(song.duration) }}</div>
    <div class="song-actions">
      <button class="action-btn" @click.stop="$emit('play')" title="Play">
        <Icon icon="mdi:play" />
      </button>
      <button class="action-btn" @click.stop="$emit('playNext')" title="Play Next">
        <Icon icon="mdi:playlist-play" />
      </button>
      <button class="action-btn" @click.stop="$emit('add')" title="Add to Queue">
        <Icon icon="mdi:playlist-plus" />
      </button>
      <button
        v-if="banable && blacklisted"
        class="action-btn action-unban"
        @click.stop="$emit('unban')"
        title="Remove from playback blacklist"
      >
        <Icon icon="mdi:cancel" />
      </button>
      <button
        v-else-if="banable"
        class="action-btn action-ban"
        @click.stop="$emit('ban')"
        title="Blacklist from playback (admin)"
      >
        <Icon icon="mdi:block-helper" />
      </button>
      <button
        v-if="deletable"
        class="action-btn action-delete"
        @click.stop="$emit('delete')"
        title="Delete from library"
      >
        <Icon icon="mdi:delete-outline" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { Song } from '../stores/player.js';
import CoverArt from './CoverArt.vue';

defineProps<{
  song: Song;
  index: number;
  active?: boolean;
  /** Show admin delete control (local library only). */
  deletable?: boolean;
  /** Show admin blacklist toggle. */
  banable?: boolean;
  /** Currently on the playback blacklist. */
  blacklisted?: boolean;
}>();

defineEmits<{
  play: [];
  playNext: [];
  add: [];
  delete: [];
  ban: [];
  unban: [];
}>();

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
</script>

<style lang="scss" scoped>
.song-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
  cursor: pointer;

  &:hover {
    background: var(--hover-bg);
    .song-actions { opacity: 1; }
  }

  &.active {
    background: var(--color-primary-10);
  }
}

.song-index {
  width: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

.song-info {
  flex: 1;
  min-width: 0;
}

.song-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.song-name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.platform-badge {
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

.song-artist {
  font-size: 12px;
  color: var(--text-secondary);
}

.song-album {
  width: 160px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-duration {
  width: 48px;
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: right;
}

.song-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

// Touch devices have no :hover, so the parent-hover-reveals-actions
// pattern leaves all action buttons invisible. Always show on coarse-
// pointer (touch) inputs — this is also where bigger tap targets matter.
@media (pointer: coarse) {
  .song-actions {
    opacity: 1;
  }
}

.action-btn {
  font-size: 18px;
  padding: 4px;
  border-radius: var(--radius-sm);
  opacity: 0.7;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.action-delete:hover {
  color: var(--color-danger, #e55);
  opacity: 1;
}

.action-ban:hover {
  color: var(--color-warning, #e9a23b);
  opacity: 1;
}

.action-unban {
  color: var(--color-warning, #e9a23b);
  opacity: 1;
}

.action-unban:hover {
  color: var(--color-success, #3d9a5f);
  opacity: 1;
}

.song-card.blacklisted {
  opacity: 0.72;
  .song-name::after {
    content: ' · banned';
    font-size: 11px;
    color: var(--color-warning, #e9a23b);
    font-weight: 500;
  }
}
</style>
