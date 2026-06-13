<template>
  <div class="library-page">
    <h1 class="page-title">Library</h1>

    <!-- Local Library (Primary) -->
    <section class="section">
      <h2 class="section-title">
        Local Music Library
        <span v-if="store.localRecent.length > 0" class="section-count">{{ store.localRecent.length }}</span>
      </h2>

      <!-- Upload from web UI (admin only; non-admins get 403 which is toasted).
           Files are written to the `uploads/` subdir under MUSIC_DIR for easy auditing / securing. -->
      <div class="upload-row">
        <label class="upload-btn">
          <input
            type="file"
            multiple
            accept="audio/*,.mp3,.flac,.wav,.ogg,.m4a,.aac,.opus"
            @change="onUpload"
          />
          ⬆ Upload music files
        </label>

        <button
          class="refresh-btn"
          @click="refreshIndex"
          :disabled="refreshing"
          title="Re-scan the entire music directory (useful after adding files on the host via scp/rsync/etc.)"
        >
          ⟳ Refresh index
        </button>

        <span class="upload-hint">
          Multi-file OK (max ~20). Goes to <code>uploads/</code> under your MUSIC_DIR.
          Re-indexes instantly (no restart). Refresh index picks up host-side adds.
        </span>
      </div>

      <!-- Upload progress + per-file status + cancel (shown while a batch is active or just completed) -->
      <div v-if="currentUploadFiles.length > 0" class="upload-progress-panel">
        <div class="progress-header">
          <span class="progress-title">
            {{ uploading ? 'Uploading' : 'Upload' }} — {{ currentUploadFiles.length }} file(s)
            <span v-if="uploading && uploadProgress > 0">({{ uploadProgress }}%)</span>
          </span>
          <button
            v-if="uploading"
            class="cancel-btn"
            @click="cancelUpload"
            title="Abort the current upload (partial files on server will be ignored or cleaned by the atomic write logic)"
          >
            Cancel
          </button>
          <button
            v-else
            class="clear-btn"
            @click="currentUploadFiles = []"
            title="Clear this upload summary"
          >
            Clear
          </button>
        </div>

        <div class="progress-bar" v-if="uploading">
          <div class="progress-fill" :style="{ width: uploadProgress + '%' }"></div>
        </div>

        <div class="upload-file-list">
          <div
            v-for="f in currentUploadFiles"
            :key="f.name"
            class="upload-file-row"
            :class="f.status"
          >
            <span class="file-name">{{ f.name }}</span>
            <span class="file-status">{{ f.status }}</span>
            <span v-if="f.error" class="file-error">— {{ f.error }}</span>
          </div>
        </div>
      </div>

      <div v-if="store.localRecent.length === 0" class="empty">
        Local library is empty. Use "Upload music files" (goes to <code>uploads/</code> under MUSIC_DIR) or add files on the host then hit "Refresh index".
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
import api from '../api/axios.js';
import { usePlayerStore, type Song, type Source } from '../stores/player.js';
import { loadTabSource, saveTabSource } from '../stores/sourceTabs.js';
import CoverArt from '../components/CoverArt.vue';
import SongCard from '../components/SongCard.vue';
import SourceTabs from '../components/SourceTabs.vue';

const store = usePlayerStore();

const history = ref<Song[]>([]);
const historyLoading = ref(true);
const refreshing = ref(false);

// Upload progress + cancel state
const uploading = ref(false);
const uploadProgress = ref(0);
const currentUploadFiles = ref<Array<{
  name: string;
  status: 'pending' | 'uploading' | 'done' | 'failed' | 'cancelled';
  error?: string;
}>>([]);
const abortController = ref<AbortController | null>(null);

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
      const res = await api.get(`/api/player/${store.activeBotId}/history`);
      history.value = res.data.history ?? [];
    } catch (err: any) {
      if (err?.response?.status !== 404) {
        const playerStore = usePlayerStore();
        const msg = err?.response?.data?.message || err?.response?.data?.error || 'Failed to load history';
        playerStore.notify(msg, 'error');
      }
    }
  }

  historyLoading.value = false;
});

async function onUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const fileList = input.files;
  if (!fileList || fileList.length === 0) return;

  // Start fresh progress UI for this batch
  currentUploadFiles.value = Array.from(fileList).map(f => ({
    name: f.name,
    status: 'uploading' as const,
  }));
  uploadProgress.value = 0;
  uploading.value = true;

  const fd = new FormData();
  // Multer .array('files') expects the same field name repeated for each file
  for (const f of Array.from(fileList)) {
    fd.append('files', f);
  }

  // Setup cancel support
  const controller = new AbortController();
  abortController.value = controller;

  try {
    const res = await api.post('/api/music/upload', fd, {
      signal: controller.signal,
      onUploadProgress: (progressEvent: any) => {
        if (progressEvent.total) {
          uploadProgress.value = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        }
      },
    });

    const uploaded: Song[] = res.data?.uploaded ?? [];
    const failed: Array<{ name: string; error: string }> = res.data?.failed ?? [];

    // Update per-file statuses from server response
    for (const f of currentUploadFiles.value) {
      const wasUploaded = uploaded.some((u: Song) => u.name === f.name || f.name.includes(u.name) || u.name.includes(f.name.replace(/\.[^.]+$/, '')));
      const failInfo = failed.find((x: any) => x.name === f.name);
      if (wasUploaded) {
        f.status = 'done';
      } else if (failInfo) {
        f.status = 'failed';
        f.error = failInfo.error;
      } else {
        // If server didn't mention it explicitly but overall succeeded, treat as done
        f.status = 'done';
      }
    }

    if (uploaded.length > 0) {
      store.notify(`Uploaded ${uploaded.length} file(s)`, 'info');

      // Optimistically put the newly uploaded tracks at the front of the visible list.
      let current = [...(store.localRecent || [])];
      for (const u of uploaded) {
        current = current.filter((s: Song) => s.id !== u.id);
        current.unshift(u);
      }
      store.localRecent = current.slice(0, 20);
    }

    if (failed.length > 0) {
      const firstFail = failed[0];
      store.notify(`Failed to upload ${failed.length} file(s). First: ${firstFail.name} — ${firstFail.error}`, 'error');
    }

    // Re-fetch to keep Home / other views / counts in sync with the fresh index.
    await store.fetchHomeData();
  } catch (err: any) {
    const isCancel = err?.code === 'ERR_CANCELED' ||
                     err?.name === 'CanceledError' ||
                     err?.message?.toLowerCase?.().includes('cancel') ||
                     err?.name === 'AbortError';

    if (isCancel) {
      store.notify('Upload cancelled', 'info');
      // Mark any still-uploading as cancelled
      for (const f of currentUploadFiles.value) {
        if (f.status === 'uploading' || f.status === 'pending') {
          f.status = 'cancelled';
        }
      }
    } else {
      const msg = err?.response?.data?.error || err?.message || 'Upload failed';
      store.notify(msg, 'error');
      // Mark remaining as failed
      for (const f of currentUploadFiles.value) {
        if (f.status === 'uploading' || f.status === 'pending') {
          f.status = 'failed';
          f.error = msg;
        }
      }
    }
  } finally {
    uploading.value = false;
    abortController.value = null;
    uploadProgress.value = 0;
    // allow picking the exact same set of files again
    input.value = '';
    // leave currentUploadFiles populated so the user sees the final status summary
    // (they can hit the "Clear" button or start a new upload to reset the panel)
  }
}

function cancelUpload() {
  if (abortController.value) {
    abortController.value.abort();
    // The catch handler will mark statuses + notify
  }
}

async function refreshIndex() {
  refreshing.value = true;
  try {
    const r = await api.post('/api/music/refresh');
    const count = r.data?.trackCount ?? 0;
    store.notify(`Library index refreshed (${count} tracks)`, 'info');
    await store.fetchHomeData();
  } catch (err: any) {
    const msg = err?.response?.data?.error || err?.message || 'Refresh failed';
    store.notify(msg, 'error');
  } finally {
    refreshing.value = false;
  }
}
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

.upload-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0 16px;
  flex-wrap: wrap;
}

.upload-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  user-select: none;
}
.upload-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.upload-btn input[type="file"] {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0,0,0,0);
  white-space: nowrap;
  border: 0;
}

.upload-hint {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  cursor: pointer;
  user-select: none;
}
.refresh-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.refresh-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Upload progress panel */
.upload-progress-panel {
  margin: 12px 0 20px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
  font-size: var(--fs-sm);
}

.progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.progress-title {
  font-weight: var(--fw-medium);
}

.cancel-btn,
.clear-btn {
  font-size: var(--fs-xs);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.cancel-btn:hover {
  border-color: #e74c3c;
  color: #e74c3c;
}
.clear-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.progress-bar {
  height: 6px;
  background: var(--bg);
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 10px;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 120ms linear;
}

.upload-file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.upload-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: var(--fs-xs);
}
.upload-file-row .file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upload-file-row .file-status {
  font-variant: small-caps;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg);
}
.upload-file-row.done .file-status { color: #2ecc71; }
.upload-file-row.failed .file-status { color: #e74c3c; }
.upload-file-row.cancelled .file-status { color: #f39c12; }
.upload-file-row.uploading .file-status { color: var(--accent); }

.file-error {
  color: #e74c3c;
  font-size: 11px;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
