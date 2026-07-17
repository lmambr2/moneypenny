<template>
  <div class="live">
    <h1 class="title">Live</h1>
    <p class="sub">
      Station snapshot for all members: now playing, queue, radio, voice/RAG feedback.
    </p>

    <section class="card">
      <div class="row">
        <span class="label">Bot</span>
        <span :class="live.connected ? 'ok' : 'off'">{{ live.connected ? 'Connected' : 'Offline' }}</span>
      </div>
      <div class="row">
        <span class="label">Scope</span>
        <span>{{ scopeLine }}</span>
      </div>
      <div class="row">
        <span class="label">Now</span>
        <span v-if="live.nowPlaying">
          {{ live.nowPlaying.name
          }}<template v-if="live.nowPlaying.artist"> — {{ live.nowPlaying.artist }}</template>
        </span>
        <span v-else class="muted">Nothing playing</span>
      </div>
      <div v-if="live.radio" class="row">
        <span class="label">Radio</span>
        <span>
          {{ live.radio.enabled ? `On · ${live.radio.activeProfile}` : 'Off' }}
          <span class="muted"> — {{ live.radio.nextBumperHint }}</span>
        </span>
      </div>
      <div v-if="live.voice" class="row">
        <span class="label">Voice</span>
        <span>
          {{ live.voice.enabled ? 'On' : 'Off' }}
          <span v-if="live.voice.enabled" class="muted">
            — duck {{ live.voice.duckOnSpeech ? 'yes' : 'no' }}
          </span>
        </span>
      </div>
      <div v-if="live.rag" class="row">
        <span class="label">RAG</span>
        <span>{{ live.rag.enabled ? 'Doctrine on' : 'Off' }}</span>
      </div>
    </section>

    <section v-if="live.feedback?.length" class="card feedback">
      <h2>Station feedback</h2>
      <ul>
        <li v-for="(line, i) in live.feedback" :key="i">{{ line }}</li>
      </ul>
    </section>

    <section class="card">
      <h2>Queue</h2>
      <ol v-if="live.queue?.length" class="queue">
        <li v-for="(s, i) in live.queue" :key="i">
          {{ s.name }}<template v-if="s.artist"> — {{ s.artist }}</template>
        </li>
      </ol>
      <p v-else class="muted">Queue empty</p>
    </section>

    <button class="btn" :disabled="busy" @click="refresh">
      {{ busy ? 'Refreshing…' : 'Refresh' }}
    </button>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import api from '../api/axios.js';

const live = ref<{
  connected: boolean;
  nowPlaying: { name: string; artist?: string } | null;
  queue: Array<{ name: string; artist?: string }>;
  radio: {
    enabled: boolean;
    activeProfile: string;
    nextBumperHint: string;
  } | null;
  voice?: { enabled: boolean; duckOnSpeech: boolean };
  rag?: { enabled: boolean };
  feedback?: string[];
  scope?: { serverLabel?: string; channelHint?: string | null; channelPinned?: boolean };
}>({
  connected: false,
  nowPlaying: null,
  queue: [],
  radio: null,
});
const busy = ref(false);
const err = ref('');
let timer: ReturnType<typeof setInterval> | null = null;

const scopeLine = computed(() => {
  const s = live.value.scope;
  if (!s) return 'default';
  const ch = s.channelPinned && s.channelHint ? s.channelHint : 'current channel';
  return `${s.serverLabel || 'default'} · ${ch}`;
});

async function refresh() {
  busy.value = true;
  err.value = '';
  try {
    const res = await api.get('/api/bot/live');
    live.value = res.data;
  } catch (e: unknown) {
    const x = e as { response?: { data?: { error?: string } }; message?: string };
    err.value = x.response?.data?.error ?? x.message ?? 'Failed to load';
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    void refresh();
  }, 12_000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.live {
  max-width: 640px;
  margin: 0 auto;
  padding: 20px 16px 80px;
}
.title {
  margin: 0;
  font-size: 1.4rem;
}
.sub {
  color: var(--text-muted, #888);
  font-size: 0.9rem;
  margin: 6px 0 16px;
}
.card {
  border: 1px solid var(--border, #333);
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 14px;
  background: var(--surface, #141418);
}
.row {
  display: flex;
  gap: 12px;
  margin: 6px 0;
  font-size: 0.95rem;
}
.label {
  min-width: 64px;
  color: var(--text-muted, #888);
}
.ok {
  color: #6c6;
}
.off {
  color: #c66;
}
.muted {
  opacity: 0.7;
}
.queue {
  margin: 0;
  padding-left: 1.2rem;
}
.feedback ul {
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.92rem;
}
.btn {
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  background: var(--accent, #6c8cff);
  color: #fff;
  cursor: pointer;
}
.err {
  color: #f66;
  margin-top: 10px;
}
h2 {
  margin: 0 0 8px;
  font-size: 1rem;
}
</style>
