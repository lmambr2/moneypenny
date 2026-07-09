<template>
  <div class="rec">
    <h1 class="title">Recordings</h1>
    <p class="sub">
      Admin dashboard capture/upload. Off by default — enable in Settings. Files stay under data/recordings;
      never auto-broadcast to radio or private memory.
    </p>

    <p v-if="!enabled" class="warn">Recordings disabled. Turn on <strong>Recordings</strong> in Settings and Save.</p>

    <section v-else class="card">
      <h2>Capture / upload</h2>
      <div class="row">
        <button class="btn" :disabled="busy || recording" @click="startCapture">
          {{ recording ? 'Recording…' : 'Record from mic' }}
        </button>
        <button v-if="recording" class="btn danger" @click="stopCapture">Stop &amp; save</button>
        <label class="btn ghost">
          Upload file
          <input type="file" accept="audio/*,.webm,.ogg,.wav,.mp3,.m4a,.opus" hidden @change="onFile" />
        </label>
      </div>
      <p v-if="msg" class="msg">{{ msg }}</p>
    </section>

    <section class="card">
      <h2>Library</h2>
      <button class="btn ghost" :disabled="busy" @click="load">Refresh</button>
      <ul v-if="items.length" class="list">
        <li v-for="r in items" :key="r.id">
          <span>{{ r.filename }}</span>
          <span class="meta">{{ (r.bytes / 1024).toFixed(1) }} KB</span>
          <a class="link" :href="downloadUrl(r.filename)" @click.prevent="download(r.filename)">Download</a>
          <button class="link danger" @click="remove(r.filename)">Delete</button>
        </li>
      </ul>
      <p v-else class="muted">No recordings yet.</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import api from '../api/axios.js';

const enabled = ref(false);
const items = ref<Array<{ id: string; filename: string; bytes: number }>>([]);
const busy = ref(false);
const msg = ref('');
const recording = ref(false);
let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

async function load() {
  busy.value = true;
  msg.value = '';
  try {
    const settings = await api.get('/api/bot/settings');
    enabled.value = !!settings.data.recordingsEnabled;
    const res = await api.get('/api/bot/recordings');
    enabled.value = res.data.enabled !== false && enabled.value;
    items.value = res.data.recordings ?? [];
  } catch (e: unknown) {
    const x = e as { response?: { data?: { error?: string } }; message?: string };
    msg.value = x.response?.data?.error ?? x.message ?? 'Load failed';
  } finally {
    busy.value = false;
  }
}

async function uploadBlob(filename: string, blob: Blob, mime?: string) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const dataBase64 = btoa(binary);
  await api.post('/api/bot/recordings', { filename, dataBase64, mime });
  await load();
}

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  msg.value = '';
  try {
    await uploadBlob(file.name, file, file.type);
    msg.value = `Uploaded ${file.name}`;
  } catch (e: unknown) {
    const x = e as { response?: { data?: { error?: string } }; message?: string };
    msg.value = x.response?.data?.error ?? x.message ?? 'Upload failed';
  }
  input.value = '';
}

async function startCapture() {
  msg.value = '';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    mediaRecorder.start();
    recording.value = true;
  } catch (e: unknown) {
    msg.value = e instanceof Error ? e.message : 'Mic capture failed';
  }
}

async function stopCapture() {
  if (!mediaRecorder) return;
  const rec = mediaRecorder;
  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.stop();
  });
  recording.value = false;
  rec.stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
  const name = `capture-${Date.now()}.webm`;
  try {
    await uploadBlob(name, blob, blob.type);
    msg.value = `Saved ${name}`;
  } catch (e: unknown) {
    const x = e as { response?: { data?: { error?: string } }; message?: string };
    msg.value = x.response?.data?.error ?? x.message ?? 'Save failed';
  }
  mediaRecorder = null;
  chunks = [];
}

function downloadUrl(name: string) {
  return `/api/bot/recordings/${encodeURIComponent(name)}`;
}

async function download(name: string) {
  const res = await api.get(`/api/bot/recordings/${encodeURIComponent(name)}`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function remove(name: string) {
  if (!confirm(`Delete ${name}?`)) return;
  await api.delete(`/api/bot/recordings/${encodeURIComponent(name)}`);
  await load();
}

onMounted(load);
onUnmounted(() => {
  if (mediaRecorder && recording.value) {
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    mediaRecorder.stop();
  }
});
</script>

<style scoped>
.rec { max-width: 720px; margin: 0 auto; padding: 20px 16px 80px; }
.title { margin: 0; }
.sub { color: var(--text-muted, #888); font-size: 0.9rem; }
.warn { color: #c90; }
.card {
  border: 1px solid var(--border, #333);
  border-radius: 12px;
  padding: 14px;
  margin: 14px 0;
  background: var(--surface, #141418);
}
.row { display: flex; flex-wrap: wrap; gap: 8px; }
.btn {
  border: none; border-radius: 8px; padding: 8px 12px;
  background: var(--accent, #6c8cff); color: #fff; cursor: pointer; font: inherit;
}
.btn.ghost { background: transparent; border: 1px solid var(--border, #333); color: inherit; }
.btn.danger { background: #a33; }
.list { list-style: none; padding: 0; margin: 10px 0 0; }
.list li {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  padding: 8px 0; border-bottom: 1px solid var(--border, #333);
}
.meta { opacity: 0.7; font-size: 0.85rem; }
.link { background: none; border: none; color: var(--accent, #6c8cff); cursor: pointer; font: inherit; text-decoration: underline; }
.link.danger { color: #f66; }
.msg { margin-top: 8px; font-size: 0.9rem; }
.muted { opacity: 0.7; }
h2 { margin: 0 0 8px; font-size: 1rem; }
</style>
