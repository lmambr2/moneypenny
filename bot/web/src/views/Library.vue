<template>
  <div class="library-page">
    <h1 class="page-title">Library</h1>

    <!-- Local Library (Primary) -->
    <section class="section">
      <h2 class="section-title">
        Local Music Library
        <span v-if="libraryTracks.length > 0" class="section-count">{{ libraryTracks.length }}</span>
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

      <!-- ACE-Step generate (admin; needs Settings → ACE-Step enabled) -->
      <div v-if="session.isAdmin.value" class="generate-row">
        <input
          v-model="genPrompt"
          class="library-filter-input"
          type="text"
          maxlength="500"
          placeholder="Generate with ACE-Step… e.g. late night focus ambient, 110 bpm"
          :disabled="genBusy"
          @keydown.enter.prevent="runGenerate"
        />
        <button
          class="refresh-btn"
          :disabled="genBusy || !genPrompt.trim()"
          title="Generate a track via ACE-Step → library → play (same as !generate)"
          @click="runGenerate"
        >
          {{ genBusy ? 'Generating…' : '✦ Generate' }}
        </button>
        <span v-if="genMsg" class="upload-hint" :class="{ 'gen-msg-err': genErr }">{{ genMsg }}</span>
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

      <div v-if="libraryLoading" class="loading">Loading library…</div>
      <div v-else-if="libraryTracks.length === 0" class="empty">
        Local library is empty. Use "Upload music files" (goes to <code>uploads/</code> under MUSIC_DIR) or add files on the host then hit "Refresh index".
      </div>
      <template v-else>
        <div class="library-filter-row">
          <input
            v-model="libraryFilter"
            class="library-filter-input"
            type="search"
            spellcheck="false"
            placeholder="Filter by title, artist, or album…"
          />
          <span class="library-filter-count">
            {{ filteredLibraryTracks.length }} / {{ libraryTracks.length }}
          </span>
        </div>
        <div v-if="filteredLibraryTracks.length === 0" class="empty">
          No tracks match “{{ libraryFilter.trim() }}”.
        </div>
        <div v-else class="song-list song-list-scroll">
          <SongCard
            v-for="(song, i) in filteredLibraryTracks"
            :key="`local-${song.id}-${i}`"
            :song="song"
            :index="i + 1"
            :active="store.currentSong?.id === song.id"
            :deletable="session.isAdmin.value"
            @play="store.play(song.name, 'local')"
            @playNext="store.playNextSong(song)"
            @add="store.addToQueue(song.name, 'local')"
            @delete="deleteLibraryTrack(song)"
          />
        </div>
      </template>
    </section>

    <!-- Radio tag overlay (docs/radio.md §9.3) -->
    <section v-if="libraryTracks.length > 0" class="section">
      <h2 class="section-title">
        Track tags
        <span class="section-count">{{ Math.min(libraryTracks.length, 40) }}</span>
      </h2>
      <p class="upload-hint" style="margin-bottom:10px">
        Tag local tracks for <code>select_tracks</code> / radio profiles. Star ratings feed rotation weighting. Admins can edit tags and mark bumper-eligible assets.
      </p>
      <div v-if="session.isAdmin.value" class="analyzer-row">
        <button
          class="refresh-btn"
          @click="runAnalyzer(false)"
          :disabled="analyzerBusy || !analyzerStatus?.enabled"
          title="Run keyfinder+aubio over the full library (enable analyzer in Settings → Radio/DJ first)"
        >
          {{ analyzerBusy ? 'Analyzing…' : '⟳ Analyze library' }}
        </button>
        <button
          v-if="analyzerStatus?.enabled"
          class="clear-btn"
          @click="runAnalyzer(true)"
          :disabled="analyzerBusy"
          title="Re-run key/BPM even when tags already exist"
        >
          Force re-analyze
        </button>
        <span class="upload-hint analyzer-hint">
          <template v-if="analyzerStatus?.enabled && analyzerStatus.available">
            Analyzer ready (keyfinder + aubio). Runs off-peak; does not block playback.
          </template>
          <template v-else-if="analyzerStatus?.enabled">
            Analyzer enabled but CLIs missing in the bot image — rebuild with the latest Dockerfile.
          </template>
          <template v-else>
            Enable <strong>Radio analyzer</strong> in Settings → Radio/DJ to populate key/BPM tags.
          </template>
          <span v-if="analyzerMsg"> — {{ analyzerMsg }}</span>
        </span>
      </div>
      <div class="track-tags-table track-tags-scroll">
        <div v-for="song in libraryTracks.slice(0, 40)" :key="`tag-${song.id}`" class="track-tags-row">
          <div class="track-tags-main">
            <span class="track-tags-name">{{ song.name }}</span>
            <span class="track-tags-artist">{{ song.artist }}</span>
            <span
              v-if="trackTags[song.id]?.musicalKey || trackTags[song.id]?.bpm"
              class="track-tags-dsp"
            >
              <template v-if="trackTags[song.id]?.musicalKey">{{ trackTags[song.id]!.musicalKey }}</template>
              <template v-if="trackTags[song.id]?.musicalKey && trackTags[song.id]?.bpm"> · </template>
              <template v-if="trackTags[song.id]?.bpm">{{ trackTags[song.id]!.bpm }} bpm</template>
            </span>
          </div>
          <StarRating
            :model-value="trackTags[song.id]?.myStars ?? null"
            :aggregate="trackTags[song.id]?.ratingLabel"
            :busy="trackTags[song.id]?.ratingBusy"
            @rate="(n) => rateTrack(song.id, n)"
            @unrate="() => unrateTrack(song.id)"
          />
          <template v-if="session.isAdmin.value && trackTags[song.id]">
            <input
              v-model="trackTags[song.id]!.genre"
              class="input tag-input"
              placeholder="genre"
              @blur="saveTrackTags(song.id)"
            />
            <input
              v-model="trackTags[song.id]!.mood"
              class="input tag-input"
              placeholder="mood"
              @blur="saveTrackTags(song.id)"
            />
            <label class="bumper-flag">
              <input type="checkbox" v-model="trackTags[song.id]!.bumper" @change="saveTrackTags(song.id)" />
              bumper
            </label>
          </template>
        </div>
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

    <!-- Doctrine knowledge base (admin; needs the AI knowledge base enabled in Settings) -->
    <section class="section">
      <h2 class="section-title">
        Doctrine (Knowledge Base)
        <span v-if="doctrine.length > 0" class="section-count">{{ doctrine.length }}</span>
      </h2>
      <div class="upload-row">
        <label class="upload-btn">
          <input type="file" multiple accept=".md,.markdown" @change="onDoctrineUpload" />
          ⬆ Upload doctrine (.md)
        </label>
        <button class="refresh-btn" @click="toggleNewDoc" :disabled="doctrineBusy">+ New doc</button>
        <button class="refresh-btn" @click="reindexDoctrine" :disabled="doctrineBusy">⟳ Reindex</button>
        <span class="upload-hint">
          Markdown docs are chunked and embedded so <code>!ask</code> / <code>!analyst</code> can cite them.
          Requires the knowledge base (RAG) enabled in Settings.
        </span>
      </div>

      <details class="doctrine-help">
        <summary>Doctrine metadata (YAML frontmatter)</summary>
        <p class="doctrine-help-lead">
          Put metadata at the top of each <code>.md</code> file — either wrapped in <code>---</code> fences
          or as plain <code>key: value</code> lines before your first heading. Everything after the metadata
          block is chunked and embedded; the header itself is not sent to the model.
        </p>

        <div class="doctrine-help-examples">
          <div class="doctrine-help-example">
            <span class="doctrine-help-label">Fenced (recommended for git/wiki)</span>
            <pre class="doctrine-help-code">---
classification: secret
tags: [intel, fleet-ops]
valid_until: 2026-12-31
---

# INTSUM title
Body markdown…</pre>
          </div>
          <div class="doctrine-help-example">
            <span class="doctrine-help-label">Loose (no fences)</span>
            <pre class="doctrine-help-code">classification: secret
tags: [intel, fleet-ops]

# Ship list
Body markdown…</pre>
          </div>
        </div>

        <dl class="doctrine-help-params">
          <div>
            <dt><code>classification</code></dt>
            <dd>
              Rank-gates retrieval. Members only see chunks at levels their TeamSpeak rights allow
              (<code>doctrine:&lt;level&gt;</code> in Settings → AI &amp; Permissions).
              Omitted or empty → <code>unclassified</code> (everyone).
              Values are normalized to lowercase; use the ladder below.
            </dd>
          </div>
          <div>
            <dt><code>tags</code></dt>
            <dd>
              Optional labels for your own organization. Accepted forms:
              <code>[intel, fleet-ops]</code>, <code>intel, fleet-ops</code>, or quoted tokens.
              Stored on each chunk in the vector index (lowercased). Not used for rank-gating today.
            </dd>
          </div>
          <div>
            <dt><code>valid_until</code></dt>
            <dd>
              Optional expiry hint (e.g. <code>2026-12-31</code>). Parsed and kept for future use;
              stale docs are <em>not</em> auto-removed — delete or re-upload when content expires.
            </dd>
          </div>
        </dl>

        <p class="doctrine-help-note">
          <strong>Classification ladder:</strong>
          <code>unclassified</code> → <code>restricted</code> → <code>confidential</code> → <code>secret</code>
          (lowest to highest). Configure who gets each level in the rights JSON
          (<code>doctrine:restricted</code>, <code>doctrine:confidential</code>, <code>doctrine:secret</code>).
        </p>
        <p class="doctrine-help-note">
          Click <strong>New doc</strong> to create a blank template, or <strong>Edit</strong> on any doc to change it inline —
          <strong>Save</strong> writes to disk and re-embeds automatically.
          For host-side edits, click <strong>Reindex</strong> (or run <code>!reindex path/to/doc.md</code>).
          Git push / file-drop re-index automatically.
        </p>
      </details>

      <div v-if="showNewDoc" class="doctrine-new-panel">
        <label class="doctrine-new-label" for="doctrine-new-path">New doc path</label>
        <div class="doctrine-new-row">
          <input
            id="doctrine-new-path"
            v-model="newDocPath"
            class="doctrine-new-input"
            type="text"
            spellcheck="false"
            placeholder="intel/intsum.md"
            @keyup.enter="createDoctrineDoc"
          />
          <button
            class="refresh-btn"
            @click="createDoctrineDoc"
            :disabled="doctrineBusy || !newDocPath.trim()"
          >
            {{ doctrineBusy ? 'Creating…' : 'Create' }}
          </button>
          <button class="clear-btn" @click="closeNewDoc" :disabled="doctrineBusy">Cancel</button>
        </div>
        <p class="doctrine-new-hint">
          Relative to the doctrine folder — nested paths OK (<code>intel/foo.md</code>).
          <code>.md</code> is added automatically if omitted.
        </p>
      </div>

      <p v-if="doctrineMsg" class="upload-hint">{{ doctrineMsg }}</p>
      <div v-if="doctrine.length === 0" class="empty">No doctrine yet. Upload a <code>.md</code> file or click <strong>New doc</strong>.</div>
      <template v-else>
        <div class="doctrine-filter-row">
          <input
            v-model="doctrineFilter"
            class="doctrine-filter-input"
            type="search"
            spellcheck="false"
            placeholder="Filter by path, tag, or classification…"
          />
          <span v-if="doctrineFilter.trim()" class="doctrine-filter-count">
            {{ filteredDoctrine.length }} / {{ doctrine.length }}
          </span>
        </div>
        <div v-if="filteredDoctrine.length === 0" class="empty">No docs match “{{ doctrineFilter.trim() }}”.</div>
        <div v-else class="doctrine-list">
        <div v-for="d in filteredDoctrine" :key="d.source" class="doctrine-item">
          <div class="doctrine-row">
            <span class="doctrine-source">{{ d.source }}</span>
            <span v-if="d.tags.length" class="doctrine-tags" :title="d.tags.join(', ')">
              <span v-for="tag in d.tags.slice(0, 3)" :key="tag" class="doctrine-tag">{{ tag }}</span>
              <span v-if="d.tags.length > 3" class="doctrine-tag-more">+{{ d.tags.length - 3 }}</span>
            </span>
            <span class="doctrine-badge">{{ d.classification }}</span>
            <span class="doctrine-chunks">{{ d.chunks }} chunks</span>
            <button
              class="doctrine-edit-btn"
              :class="{ active: editingSource === d.source }"
              @click="toggleEditDoctrine(d.source)"
              :disabled="doctrineBusy && editingSource !== d.source"
              title="Edit markdown inline"
            >
              {{ editingSource === d.source ? 'Close' : 'Edit' }}
            </button>
            <button
              v-if="exportAvailable"
              class="doctrine-export-btn"
              @click="exportDoctrineDoc(d.source)"
              :disabled="doctrineBusy"
              title="Download Word (.docx) via Pandoc"
            >
              Export
            </button>
            <button class="btn-delete" @click="deleteDoctrine(d.source)" title="Delete + purge from the knowledge base">✕</button>
          </div>

          <div v-if="editingSource === d.source" class="doctrine-editor">
            <div v-if="editorLoading" class="doctrine-editor-loading">Loading…</div>
            <template v-else>
              <div class="doctrine-editor-tabs">
                <button
                  type="button"
                  class="doctrine-tab"
                  :class="{ active: editorTab === 'edit' }"
                  @click="editorTab = 'edit'"
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="doctrine-tab"
                  :class="{ active: editorTab === 'preview' }"
                  @click="editorTab = 'preview'"
                >
                  Preview
                </button>
                <span v-if="editorDirty" class="doctrine-dirty">unsaved changes</span>
              </div>

              <textarea
                v-show="editorTab === 'edit'"
                v-model="editorContent"
                class="doctrine-textarea"
                spellcheck="false"
                placeholder="Markdown with optional YAML frontmatter…"
              />

              <div
                v-show="editorTab === 'preview'"
                class="doctrine-preview"
                v-html="editorPreviewHtml"
              />

              <div class="doctrine-editor-actions">
                <button
                  class="refresh-btn"
                  @click="saveDoctrineEdit"
                  :disabled="doctrineBusy || !editorDirty"
                >
                  {{ doctrineBusy ? 'Saving…' : 'Save & re-index' }}
                </button>
                <button class="clear-btn" @click="cancelDoctrineEdit" :disabled="doctrineBusy">Cancel</button>
              </div>
            </template>
          </div>
        </div>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { Icon } from '@iconify/vue';
import api from '../api/axios.js';
import { usePlayerStore, type Song, type Source } from '../stores/player.js';
import { loadTabSource, saveTabSource } from '../stores/sourceTabs.js';
import { renderMarkdownPreview } from '../utils/markdownPreview.js';
import CoverArt from '../components/CoverArt.vue';
import SongCard from '../components/SongCard.vue';
import StarRating from '../components/StarRating.vue';
import SourceTabs from '../components/SourceTabs.vue';
import { useSession } from '../composables/useSession.js';

const store = usePlayerStore();
const session = useSession();

interface TrackTagRow {
  genre: string;
  mood: string;
  musicalKey: string;
  bpm: number | null;
  bumper: boolean;
  myStars: number | null;
  ratingLabel: string;
  ratingBusy: boolean;
  loaded: boolean;
}
const trackTags = ref<Record<string, TrackTagRow>>({});
const analyzerStatus = ref<{ enabled: boolean; available: boolean; onIngest?: boolean } | null>(null);
const analyzerBusy = ref(false);
const analyzerMsg = ref('');

const history = ref<Song[]>([]);
const historyLoading = ref(true);
const refreshing = ref(false);

const genPrompt = ref('');
const genBusy = ref(false);
const genMsg = ref('');
const genErr = ref(false);

async function runGenerate() {
  const prompt = genPrompt.value.trim();
  if (!prompt || genBusy.value) return;
  genBusy.value = true;
  genMsg.value = '';
  genErr.value = false;
  try {
    const res = await api.post('/api/bot/ace-step/generate', { prompt });
    genMsg.value = res.data?.message ?? 'Generated';
    genErr.value = res.data?.ok === false;
    if (res.data?.ok !== false) {
      genPrompt.value = '';
      await loadLibraryTracks();
      store.fetchHomeData();
    }
  } catch (err: any) {
    genErr.value = true;
    genMsg.value =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      'Generation failed';
  } finally {
    genBusy.value = false;
  }
}

/** Full local library for the scrollable Library panel (not the Home recent sample). */
const libraryTracks = ref<Song[]>([]);
const libraryLoading = ref(true);
const libraryFilter = ref('');
const filteredLibraryTracks = computed(() => {
  const q = libraryFilter.value.trim().toLowerCase();
  if (!q) return libraryTracks.value;
  return libraryTracks.value.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.artist.toLowerCase().includes(q) ||
      (s.album || '').toLowerCase().includes(q),
  );
});

async function loadLibraryTracks() {
  libraryLoading.value = true;
  try {
    const res = await api.get('/api/music/library', { params: { limit: 2000 } });
    libraryTracks.value = res.data?.songs ?? [];
    // Keep Home/recent sample in sync with first slice when empty or after refresh.
    if (libraryTracks.value.length) {
      store.localRecent = libraryTracks.value.slice(0, 20);
      store.localTrackCount = libraryTracks.value.length;
    }
  } catch {
    // Fall back to the small home sample so the page is not empty.
    libraryTracks.value = [...(store.localRecent || [])];
  } finally {
    libraryLoading.value = false;
  }
}

async function deleteLibraryTrack(song: Song) {
  if (!session.isAdmin.value) return;
  if (!confirm(`Delete “${song.name}” from the library?\n\nThis removes the file from disk under MUSIC_DIR.`)) {
    return;
  }
  try {
    await api.delete(`/api/music/tracks/${encodeURIComponent(song.id)}`);
    libraryTracks.value = libraryTracks.value.filter((s) => s.id !== song.id);
    store.localRecent = store.localRecent.filter((s) => s.id !== song.id);
    store.localTrackCount = Math.max(0, (store.localTrackCount || 1) - 1);
    delete trackTags.value[song.id];
    store.notify(`Deleted “${song.name}”`, 'info');
  } catch (err: any) {
    store.notify(err?.response?.data?.error ?? 'Delete failed', 'error');
  }
}

// Doctrine knowledge base (ROADMAP Phase 6). Admin-only API; non-admins / RAG-off
// simply get an empty list.
interface DoctrineDoc { source: string; classification: string; tags: string[]; chunks: number; bytes: number; updatedAt: number; }
const doctrine = ref<DoctrineDoc[]>([]);
const doctrineBusy = ref(false);
const doctrineMsg = ref('');
const editingSource = ref<string | null>(null);
const editorContent = ref('');
const editorOriginal = ref('');
const editorLoading = ref(false);
const editorTab = ref<'edit' | 'preview'>('edit');
const editorDirty = computed(() => editorContent.value !== editorOriginal.value);
const editorPreviewHtml = computed(() => renderMarkdownPreview(editorContent.value));
const showNewDoc = ref(false);
const newDocPath = ref('');
const doctrineFilter = ref('');
const exportAvailable = ref(false);

const filteredDoctrine = computed(() => {
  const q = doctrineFilter.value.trim().toLowerCase();
  if (!q) return doctrine.value;
  return doctrine.value.filter((d) => {
    if (d.source.toLowerCase().includes(q)) return true;
    if (d.classification.toLowerCase().includes(q)) return true;
    return d.tags.some((t) => t.toLowerCase().includes(q));
  });
});

function onDoctrineEditorKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.key !== 's') return;
  if (!editingSource.value || !editorDirty.value || doctrineBusy.value) return;
  e.preventDefault();
  void saveDoctrineEdit();
}

function normalizeNewDocPath(input: string): string {
  const raw = input.replace(/\\/g, '/').trim();
  if (!raw) return '';
  return /\.(md|markdown)$/i.test(raw) ? raw : `${raw}.md`;
}

function openDoctrineEditor(source: string, content: string) {
  editingSource.value = source;
  editorTab.value = 'edit';
  editorLoading.value = false;
  editorContent.value = content;
  editorOriginal.value = content;
}

async function discardEditorIfDirty(): Promise<boolean> {
  if (!editingSource.value || !editorDirty.value) return true;
  return confirm('Discard unsaved changes?');
}

async function toggleNewDoc() {
  if (showNewDoc.value) {
    closeNewDoc();
    return;
  }
  if (!(await discardEditorIfDirty())) return;
  editingSource.value = null;
  showNewDoc.value = true;
  newDocPath.value = '';
  doctrineMsg.value = '';
}

function closeNewDoc() {
  showNewDoc.value = false;
  newDocPath.value = '';
}

async function createDoctrineDoc() {
  const source = normalizeNewDocPath(newDocPath.value);
  if (!source) return;
  doctrineBusy.value = true;
  doctrineMsg.value = '';
  try {
    const res = await api.post('/api/rag/doctrine/new', { source });
    const created = res.data.source as string;
    const content = res.data.content as string;
    const ing = res.data.ingested;
    closeNewDoc();
    await loadDoctrine();
    openDoctrineEditor(created, content);
    doctrineMsg.value = `Created ${ing?.source ?? created} (${ing?.chunks ?? '?'} chunks).`;
  } catch (err: any) {
    const code = err?.response?.data?.code;
    if (code === 'CONFLICT') {
      doctrineMsg.value = `"${source}" already exists — use Edit instead.`;
    } else {
      doctrineMsg.value = err?.response?.data?.error ?? 'Create failed.';
    }
  } finally {
    doctrineBusy.value = false;
  }
}

async function loadDoctrine() {
  try {
    const res = await api.get('/api/rag/doctrine');
    doctrine.value = res.data.docs ?? [];
  } catch { /* RAG off or not admin — leave empty */ }
}

async function loadExportCapabilities() {
  try {
    const res = await api.get('/api/rag/doctrine/export/capabilities');
    exportAvailable.value = res.data.pandoc === true;
  } catch {
    exportAvailable.value = false;
  }
}

async function exportDoctrineDoc(source: string, format: 'docx' | 'pdf' = 'docx') {
  doctrineBusy.value = true;
  doctrineMsg.value = '';
  try {
    const res = await api.get(`/api/rag/doctrine/${encodeURIComponent(source)}/export`, {
      params: { format },
      responseType: 'blob',
    });
    const disposition = res.headers['content-disposition'] as string | undefined;
    const match = disposition?.match(/filename="([^"]+)"/);
    const filename = match?.[1] ?? source.replace(/\.(md|markdown)$/i, `.${format}`);
    const mime = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined;
    const blob = new Blob([res.data], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    doctrineMsg.value = `Exported ${filename}.`;
  } catch (err: any) {
    const data = err?.response?.data;
    if (data instanceof Blob) {
      try {
        const parsed = JSON.parse(await data.text()) as { error?: string };
        doctrineMsg.value = parsed.error ?? 'Export failed.';
      } catch {
        doctrineMsg.value = 'Export failed.';
      }
    } else {
      doctrineMsg.value = data?.error ?? 'Export failed.';
    }
  } finally {
    doctrineBusy.value = false;
  }
}
async function onDoctrineUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  doctrineBusy.value = true; doctrineMsg.value = '';
  try {
    const res = await api.post('/api/rag/doctrine', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    const ok = res.data.ingested?.length ?? 0;
    const bad = res.data.failed?.length ?? 0;
    doctrineMsg.value = `Ingested ${ok} doc(s)` + (bad ? `, ${bad} failed` : '') + '.';
    await loadDoctrine();
  } catch (err: any) {
    doctrineMsg.value = err?.response?.data?.error ?? 'Upload failed — is the knowledge base enabled and are you an admin?';
  } finally {
    doctrineBusy.value = false; input.value = '';
  }
}
async function deleteDoctrine(source: string) {
  if (!confirm(`Delete doctrine "${source}" and purge it from the knowledge base?`)) return;
  if (editingSource.value === source) editingSource.value = null;
  try {
    await api.delete(`/api/rag/doctrine/${encodeURIComponent(source)}`);
    await loadDoctrine();
  } catch (err: any) {
    doctrineMsg.value = err?.response?.data?.error ?? 'Delete failed.';
  }
}

async function toggleEditDoctrine(source: string) {
  if (editingSource.value === source) {
    if (!(await discardEditorIfDirty())) return;
    editingSource.value = null;
    return;
  }
  if (!(await discardEditorIfDirty())) return;
  closeNewDoc();

  editingSource.value = source;
  editorTab.value = 'edit';
  editorLoading.value = true;
  editorContent.value = '';
  editorOriginal.value = '';
  try {
    const res = await api.get(`/api/rag/doctrine/${encodeURIComponent(source)}`);
    openDoctrineEditor(source, res.data.content ?? '');
  } catch (err: any) {
    doctrineMsg.value = err?.response?.data?.error ?? 'Failed to load doctrine for editing.';
    editingSource.value = null;
  } finally {
    editorLoading.value = false;
  }
}

function cancelDoctrineEdit() {
  if (editorDirty.value && !confirm('Discard unsaved changes?')) return;
  editingSource.value = null;
}

async function saveDoctrineEdit() {
  const source = editingSource.value;
  if (!source || !editorDirty.value) return;
  doctrineBusy.value = true;
  doctrineMsg.value = '';
  try {
    const res = await api.put(`/api/rag/doctrine/${encodeURIComponent(source)}`, {
      content: editorContent.value,
    });
    const ing = res.data.ingested;
    doctrineMsg.value = `Saved ${ing?.source ?? source} (${ing?.chunks ?? '?'} chunks, ${ing?.classification ?? 'unclassified'}).`;
    editorOriginal.value = editorContent.value;
    await loadDoctrine();
  } catch (err: any) {
    doctrineMsg.value = err?.response?.data?.error ?? 'Save failed.';
  } finally {
    doctrineBusy.value = false;
  }
}
async function reindexDoctrine() {
  doctrineBusy.value = true; doctrineMsg.value = '';
  try {
    const res = await api.post('/api/rag/doctrine/reindex');
    doctrineMsg.value = `Re-indexed ${res.data.reindexed} doc(s).`;
    await loadDoctrine();
  } catch (err: any) {
    doctrineMsg.value = err?.response?.data?.error ?? 'Reindex failed.';
  } finally {
    doctrineBusy.value = false;
  }
}
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
  loadDoctrine();
  void loadExportCapabilities();
  window.addEventListener('keydown', onDoctrineEditorKeydown);

  if (!store.activeBotId) {
    await store.fetchBots();
  }

  store.fetchHomeData();
  await loadLibraryTracks();
  void loadTrackTagsForRecent();
  if (session.isAdmin.value) void loadAnalyzerStatus();

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
onUnmounted(() => {
  window.removeEventListener('keydown', onDoctrineEditorKeydown);
});

function ensureTagRow(id: string): TrackTagRow {
  if (!trackTags.value[id]) {
    trackTags.value[id] = {
      genre: '',
      mood: '',
      musicalKey: '',
      bpm: null,
      bumper: false,
      myStars: null,
      ratingLabel: '',
      ratingBusy: false,
      loaded: false,
    };
  }
  return trackTags.value[id];
}

async function loadTrackTagsForRecent() {
  const tagSongs = libraryTracks.value.slice(0, 40);
  for (const song of tagSongs) ensureTagRow(song.id);
  for (const song of tagSongs) {
    try {
      const res = await api.get(`/api/music/tracks/${encodeURIComponent(song.id)}/tags`);
      const row = ensureTagRow(song.id);
      const t = res.data?.tags ?? {};
      row.genre = t.genre ?? '';
      row.mood = t.mood ?? '';
      row.musicalKey = t.musicalKey ?? '';
      row.bpm = typeof t.bpm === 'number' ? t.bpm : null;
      row.bumper = !!t.bumper;
      const r = res.data?.rating;
      if (r?.avg != null && r.count) row.ratingLabel = `${r.avg.toFixed(1)}★ (${r.count})`;
      row.loaded = true;
    } catch { /* tag overlay optional */ }
  }
}

async function loadAnalyzerStatus() {
  try {
    const res = await api.get('/api/music/analyze/status');
    analyzerStatus.value = res.data;
  } catch {
    analyzerStatus.value = null;
  }
}

async function runAnalyzer(force: boolean) {
  analyzerBusy.value = true;
  analyzerMsg.value = '';
  try {
    const res = await api.post('/api/music/analyze', { force });
    const a = res.data?.analyzed ?? 0;
    const s = res.data?.skipped ?? 0;
    analyzerMsg.value = `Done — analyzed ${a}, skipped ${s}.`;
    await loadTrackTagsForRecent();
  } catch (err: any) {
    analyzerMsg.value = err?.response?.data?.error ?? 'Analyze failed.';
  } finally {
    analyzerBusy.value = false;
  }
}

async function saveTrackTags(id: string) {
  const row = ensureTagRow(id);
  try {
    await api.patch(`/api/music/tracks/${encodeURIComponent(id)}/tags`, {
      genre: row.genre.trim() || undefined,
      mood: row.mood.trim() || undefined,
      bumper: row.bumper,
    });
  } catch (err: any) {
    store.notify(err?.response?.data?.error ?? 'Tag save failed (admin only)', 'error');
  }
}

async function rateTrack(id: string, stars: number) {
  const row = ensureTagRow(id);
  row.ratingBusy = true;
  try {
    const res = await api.post(`/api/music/tracks/${encodeURIComponent(id)}/rating`, { stars });
    row.myStars = stars;
    const r = res.data?.rating;
    if (r?.avg != null && r.count) row.ratingLabel = `${r.avg.toFixed(1)}★ (${r.count})`;
  } catch (err: any) {
    store.notify(err?.response?.data?.error ?? 'Rating failed', 'error');
  } finally {
    row.ratingBusy = false;
  }
}

async function unrateTrack(id: string) {
  const row = ensureTagRow(id);
  row.ratingBusy = true;
  try {
    const res = await api.delete(`/api/music/tracks/${encodeURIComponent(id)}/rating`);
    row.myStars = null;
    const r = res.data?.rating;
    if (r?.avg != null && r.count) row.ratingLabel = `${r.avg.toFixed(1)}★ (${r.count})`;
    else row.ratingLabel = '';
  } catch (err: any) {
    store.notify(err?.response?.data?.error ?? 'Unrate failed', 'error');
  } finally {
    row.ratingBusy = false;
  }
}

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
      // Prepend uploads in the full library list (full reload below too).
      let full = [...libraryTracks.value];
      for (const u of uploaded) {
        full = full.filter((s: Song) => s.id !== u.id);
        full.unshift(u);
      }
      libraryTracks.value = full;
      store.localRecent = full.slice(0, 20);
    }

    if (failed.length > 0) {
      const firstFail = failed[0];
      store.notify(`Failed to upload ${failed.length} file(s). First: ${firstFail.name} — ${firstFail.error}`, 'error');
    }

    // Re-fetch to keep Home / Library / counts in sync with the fresh index.
    await store.fetchHomeData();
    await loadLibraryTracks();
    void loadTrackTagsForRecent();
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
    await loadLibraryTracks();
    void loadTrackTagsForRecent();
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

.song-list-scroll {
  max-height: min(60vh, 560px);
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding-right: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
}

.library-filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 10px;
}

.generate-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
}

.generate-row .library-filter-input {
  flex: 1 1 220px;
  min-width: 180px;
}

.gen-msg-err {
  color: var(--danger, #e55);
}

.library-filter-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: var(--fs-sm);
}

.library-filter-count {
  flex-shrink: 0;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.track-tags-scroll {
  max-height: min(40vh, 360px);
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
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

.doctrine-help {
  margin: 12px 0 16px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.doctrine-help summary {
  cursor: pointer;
  font-weight: var(--fw-medium);
  color: var(--text);
  user-select: none;
}

.doctrine-help[open] summary {
  margin-bottom: 10px;
}

.doctrine-help-lead {
  margin: 0 0 12px;
  line-height: 1.5;
}

.doctrine-help-examples {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}

@media (min-width: 720px) {
  .doctrine-help-examples {
    grid-template-columns: 1fr 1fr;
  }
}

.doctrine-help-example {
  min-width: 0;
}

.doctrine-help-label {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
}

.doctrine-help-code {
  margin: 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.45;
  overflow-x: auto;
  white-space: pre;
  color: var(--text);
}

.doctrine-help-params {
  margin: 0 0 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.doctrine-help-params dt {
  font-weight: var(--fw-medium);
  color: var(--text);
  margin-bottom: 2px;
}

.doctrine-help-params dd {
  margin: 0;
  line-height: 1.5;
  color: var(--text-secondary);
}

.doctrine-help-note {
  margin: 0 0 8px;
  line-height: 1.5;
}

.doctrine-help-note:last-child {
  margin-bottom: 0;
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
  max-height: min(40vh, 320px);
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding-right: 4px;
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

.doctrine-new-panel {
  margin: 8px 0 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
}

.doctrine-new-label {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  color: var(--text);
}

.doctrine-new-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.doctrine-new-input {
  flex: 1;
  min-width: 200px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, monospace;
  font-size: var(--fs-sm);
}

.doctrine-new-hint {
  margin: 8px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  line-height: 1.45;
}

.doctrine-filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.doctrine-filter-input {
  flex: 1;
  min-width: 200px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text);
  font-size: var(--fs-sm);
}

.doctrine-filter-count {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.doctrine-list {
  display: flex;
  flex-direction: column;
  max-height: min(60vh, 560px);
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding-right: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
}

.doctrine-item {
  border-bottom: 1px solid var(--border);

  &:last-child {
    border-bottom: none;
  }
}

.doctrine-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
}

.doctrine-source {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, monospace;
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doctrine-tags {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 180px;
  overflow: hidden;
}

.doctrine-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-secondary);
  white-space: nowrap;
}

.doctrine-tag-more {
  font-size: 10px;
  color: var(--text-tertiary);
}

.doctrine-badge {
  font-size: 0.8em;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg);
  text-transform: uppercase;
}

.doctrine-chunks {
  font-size: 0.85em;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.doctrine-edit-btn {
  font-size: var(--fs-xs);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.doctrine-edit-btn:hover:not(:disabled),
.doctrine-edit-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}
.doctrine-edit-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.doctrine-export-btn {
  font-size: var(--fs-xs);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.doctrine-export-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.doctrine-export-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-delete {
  font-size: var(--fs-xs);
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.btn-delete:hover {
  border-color: #e74c3c;
  color: #e74c3c;
}

.doctrine-editor {
  margin: 4px 10px 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elev);
}

.doctrine-editor-loading {
  padding: 20px;
  text-align: center;
  color: var(--text-secondary);
  font-size: var(--fs-sm);
}

.doctrine-editor-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.doctrine-tab {
  font-size: var(--fs-xs);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text-secondary);
  cursor: pointer;
}
.doctrine-tab.active {
  border-color: var(--accent);
  color: var(--accent);
}

.doctrine-dirty {
  margin-left: auto;
  font-size: 11px;
  color: #f39c12;
}

.doctrine-textarea {
  width: 100%;
  min-height: 220px;
  max-height: 50vh;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.45;
  resize: vertical;
  box-sizing: border-box;
}

.doctrine-preview {
  min-height: 220px;
  max-height: 50vh;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  font-size: var(--fs-sm);
  line-height: 1.5;
}
.doctrine-preview :deep(h1),
.doctrine-preview :deep(h2),
.doctrine-preview :deep(h3) {
  margin: 0.6em 0 0.3em;
  font-weight: var(--fw-bold);
}
.doctrine-preview :deep(h1) { font-size: 1.25em; }
.doctrine-preview :deep(h2) { font-size: 1.1em; }
.doctrine-preview :deep(p) { margin: 0.4em 0; }
.doctrine-preview :deep(ul) { margin: 0.4em 0; padding-left: 1.4em; }
.doctrine-preview :deep(code) {
  font-family: ui-monospace, monospace;
  font-size: 0.9em;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--bg-elev);
}
.doctrine-preview :deep(pre) {
  margin: 0.5em 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-elev);
  overflow-x: auto;
}
.doctrine-preview :deep(pre code) {
  padding: 0;
  background: transparent;
}
.doctrine-preview :deep(a) {
  color: var(--accent);
}

.doctrine-editor-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.analyzer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.analyzer-hint {
  flex: 1;
  min-width: 200px;
}

.track-tags-table {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.track-tags-dsp {
  display: block;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  font-family: ui-monospace, monospace;
}
.track-tags-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-elev);
}
.track-tags-main {
  flex: 1 1 180px;
  min-width: 140px;
}
.track-tags-name {
  display: block;
  font-weight: 600;
  font-size: 14px;
}
.track-tags-artist {
  font-size: 12px;
  color: var(--text-tertiary);
}
.tag-input {
  width: 90px;
  padding: 4px 8px;
  font-size: 12px;
}
.bumper-flag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
