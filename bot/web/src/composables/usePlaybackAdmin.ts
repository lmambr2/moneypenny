/**
 * Shared admin ban/delete for Library, Search, History (and any SongCard list).
 * Same APIs as SongCard: banable / blacklisted / deletable + ban/unban/delete handlers.
 */
import { computed, type Ref, ref } from 'vue';
import api from '../api/axios.js';
import type { Song } from '../stores/player.js';
import { usePlayerStore } from '../stores/player.js';
import { useSession } from './useSession.js';

export function usePlaybackAdmin(opts?: {
  /** Called after a successful local file delete so the host list can drop the row. */
  onDeleted?: (song: Song) => void;
}) {
  const session = useSession();
  const store = usePlayerStore();
  const blacklistKeys: Ref<Set<string>> = ref(new Set());

  const isAdmin = computed(() => session.isAdmin.value);
  const banable = computed(() => isAdmin.value);

  function isBlacklisted(song: Pick<Song, 'id'>): boolean {
    return blacklistKeys.value.has(song.id);
  }

  /** Delete from disk only applies to local library files. */
  function isDeletable(song: Pick<Song, 'platform'>): boolean {
    return isAdmin.value && (song.platform === 'local' || !song.platform);
  }

  async function loadBlacklist(): Promise<void> {
    if (!isAdmin.value) {
      blacklistKeys.value = new Set();
      return;
    }
    try {
      const res = await api.get('/api/music/blacklist');
      const keys: string[] = res.data?.keys ?? [];
      blacklistKeys.value = new Set(keys);
    } catch {
      blacklistKeys.value = new Set();
    }
  }

  async function banTrack(song: Song): Promise<void> {
    if (!isAdmin.value) return;
    if (
      !confirm(
        `Blacklist “${song.name}” from playback?\n\nThe file stays on disk; search, !play, and radio will skip it.`,
      )
    ) {
      return;
    }
    try {
      await api.post('/api/music/blacklist', {
        id: song.id,
        platform: song.platform || 'local',
        name: song.name,
        artist: song.artist,
      });
      const next = new Set(blacklistKeys.value);
      next.add(song.id);
      blacklistKeys.value = next;
      store.notify(`Blacklisted “${song.name}”`, 'info');
    } catch (err: any) {
      store.notify(err?.response?.data?.error ?? 'Blacklist failed', 'error');
    }
  }

  async function unbanTrack(song: Song): Promise<void> {
    if (!isAdmin.value) return;
    try {
      await api.delete(`/api/music/blacklist/${encodeURIComponent(song.id)}`);
      const next = new Set(blacklistKeys.value);
      next.delete(song.id);
      blacklistKeys.value = next;
      store.notify(`Removed “${song.name}” from blacklist`, 'info');
    } catch (err: any) {
      store.notify(err?.response?.data?.error ?? 'Unban failed', 'error');
    }
  }

  async function deleteTrack(song: Song): Promise<void> {
    if (!isDeletable(song)) return;
    if (
      !confirm(
        `Delete “${song.name}” from the library?\n\nThis removes the file from disk under MUSIC_DIR.`,
      )
    ) {
      return;
    }
    try {
      await api.delete(`/api/music/tracks/${encodeURIComponent(song.id)}`);
      const next = new Set(blacklistKeys.value);
      next.delete(song.id);
      blacklistKeys.value = next;
      opts?.onDeleted?.(song);
      store.notify(`Deleted “${song.name}”`, 'info');
    } catch (err: any) {
      store.notify(err?.response?.data?.error ?? 'Delete failed', 'error');
    }
  }

  return {
    isAdmin,
    banable,
    blacklistKeys,
    isBlacklisted,
    isDeletable,
    loadBlacklist,
    banTrack,
    unbanTrack,
    deleteTrack,
  };
}
