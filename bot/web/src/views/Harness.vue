<template>
  <div class="harness">
    <header class="harness-header">
      <div>
        <h1 class="harness-title">Harness</h1>
        <p class="harness-sub">
          Admin cockpit — grounded asks with sources, tools, and errors (H1/H2/H5).
        </p>
      </div>
      <div class="harness-mode">
        <label class="mode-label">
          <input v-model="mode" type="radio" value="ask" /> Ask
        </label>
        <label class="mode-label">
          <input v-model="mode" type="radio" value="intent" /> Intent + tools
        </label>
        <label v-if="mode === 'intent'" class="mode-label" title="Do not execute tools — only record dry-run results">
          <input v-model="dryRun" type="checkbox" /> Dry-run tools
        </label>
      </div>
    </header>

    <form class="ask-form" @submit.prevent="submit">
      <textarea
        v-model="question"
        class="ask-input"
        rows="3"
        placeholder="Ask Moneypenny (doctrine-grounded)…"
        :disabled="busy"
      />
      <div class="ask-actions">
        <button type="submit" class="ask-btn" :disabled="busy || !question.trim()">
          {{ busy ? 'Thinking…' : mode === 'intent' ? 'Run intent' : 'Ask' }}
        </button>
        <button type="button" class="ghost-btn" :disabled="busy" @click="refreshTurns">
          Refresh
        </button>
        <button type="button" class="ghost-btn" :disabled="busy" @click="loadOps">
          Ops status
        </button>
        <button type="button" class="ghost-btn" :disabled="busy" @click="runUnderMusic">
          Under-music check
        </button>
        <button type="button" class="ghost-btn" :disabled="busy" @click="runEval">
          RAG eval
        </button>
      </div>
    </form>

    <p v-if="formError" class="form-error">{{ formError }}</p>
    <pre v-if="opsText" class="ops-box">{{ opsText }}</pre>
    <pre v-if="voiceCheckText" class="ops-box">{{ voiceCheckText }}</pre>
    <pre v-if="evalText" class="ops-box">{{ evalText }}</pre>

    <section class="scopes">
      <h2 class="section-title">Memory scopes</h2>
      <p class="hint isolation">{{ isolationRule }}</p>
      <div class="scope-grid">
        <div class="scope-card private">
          <h3>Private (per-user)</h3>
          <p class="badge never">Never broadcast</p>
          <p class="hint">
            <code>!remember</code> / <code>!recall</code> / <code>!forget</code> — only that member’s
            <code>!ask</code>. Not used for radio memory bumpers.
          </p>
          <div class="seed-row">
            <input v-model="privateUid" class="seed-input" placeholder="TS uid to inspect" />
            <button type="button" class="ghost-btn" :disabled="busy || !privateUid.trim()" @click="loadPrivate">
              List
            </button>
          </div>
          <ul v-if="privateFacts.length" class="fact-list">
            <li v-for="f in privateFacts" :key="f.id">{{ f.fact }}</li>
          </ul>
          <p v-else-if="privateMsg" class="seed-msg">{{ privateMsg }}</p>
        </div>
        <div class="scope-card org">
          <h3>Org knowledge graph</h3>
          <p class="badge ok">Broadcast only if “Org memory on air”</p>
          <p class="hint">
            <code>!kg remember</code> / <code>!diary</code> / seed below — org-wide. Radio memory bumper
            uses this path only.
          </p>
          <div class="seed-row">
            <input v-model="orgFact" class="seed-input" placeholder="FC is Alice until 2026-12-31" />
            <button type="button" class="ask-btn" :disabled="busy || !orgFact.trim()" @click="seedOrg">
              Seed org
            </button>
          </div>
          <p v-if="seedMsg" class="seed-msg">{{ seedMsg }}</p>
          <ul v-if="orgFacts.length" class="fact-list">
            <li v-for="f in orgFacts" :key="f.id">{{ f.fact }}</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="turns">
      <h2 class="section-title">Turns</h2>
      <div v-if="turns.length === 0" class="empty">No turns yet — ask something above.</div>
      <article v-for="t in turns" :key="t.id" class="turn" :class="{ errored: !!t.error }">
        <div class="turn-meta">
          <span class="turn-mode">{{ t.mode }}</span>
          <span class="turn-time">{{ formatTime(t.at) }}</span>
          <span v-if="t.error" class="turn-err-badge">error</span>
        </div>
        <div class="turn-user"><strong>You:</strong> {{ t.user }}</div>
        <div v-if="t.error" class="turn-error">{{ t.error }}</div>
        <div v-if="t.reply" class="turn-reply"><strong>Moneypenny:</strong> {{ t.reply }}</div>

        <div v-if="t.sources?.length" class="turn-block">
          <h3>Sources</h3>
          <ul>
            <li v-for="(s, i) in t.sources" :key="i">
              <code>{{ s.source }}</code>
              <span v-if="s.classification" class="cls">{{ s.classification }}</span>
              <span v-if="s.score != null" class="score">{{ s.score.toFixed(2) }}</span>
              <div v-if="s.text" class="src-text">{{ s.text }}</div>
            </li>
          </ul>
        </div>

        <div v-if="t.tools?.length" class="turn-block">
          <h3>Tools</h3>
          <ul>
            <li v-for="(tool, i) in t.tools" :key="i" :class="{ fail: !tool.ok }">
              <code>{{ tool.name }}</code>
              <span class="tool-ok">{{ tool.ok ? 'ok' : 'fail' }}</span>
              <pre class="tool-args">{{ JSON.stringify(tool.args, null, 0) }}</pre>
              <div v-if="tool.result" class="tool-result">{{ tool.result }}</div>
              <div v-if="tool.error" class="tool-error">{{ tool.error }}</div>
            </li>
          </ul>
        </div>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import api from '../api/axios.js';

interface HarnessSource {
  source: string;
  text?: string;
  classification?: string;
  score?: number;
}
interface HarnessTool {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: string;
  error?: string;
}
interface HarnessTurn {
  id: string;
  at: number;
  user: string;
  reply: string;
  sources: HarnessSource[];
  tools: HarnessTool[];
  error?: string;
  mode: string;
}

const question = ref('');
const mode = ref<'ask' | 'intent'>('ask');
const dryRun = ref(false);
const busy = ref(false);
const formError = ref('');
const turns = ref<HarnessTurn[]>([]);
const orgFact = ref('');
const seedMsg = ref('');
const opsText = ref('');
const voiceCheckText = ref('');
const evalText = ref('');
const isolationRule = ref(
  'Private !remember rooms never feed radio memory bumpers. Org KG only (opt-in).',
);
const privateUid = ref('');
const privateFacts = ref<Array<{ id: number; fact: string }>>([]);
const privateMsg = ref('');
const orgFacts = ref<Array<{ id: number; fact: string }>>([]);

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString();
  } catch {
    return String(at);
  }
}

async function refreshTurns() {
  try {
    const res = await api.get('/api/bot/harness/turns');
    turns.value = res.data.turns ?? [];
  } catch {
    /* ignore */
  }
}

async function submit() {
  formError.value = '';
  busy.value = true;
  try {
    const res = await api.post('/api/bot/harness/ask', {
      question: question.value.trim(),
      mode: mode.value,
      dryRun: mode.value === 'intent' && dryRun.value,
    });
    const turn = res.data.turn as HarnessTurn;
    if (turn) {
      turns.value = [turn, ...turns.value.filter((t) => t.id !== turn.id)].slice(0, 40);
    }
    if (turn?.error && !turn.reply) formError.value = turn.error;
  } catch (err: unknown) {
    const e = err as {
      response?: { data?: { error?: string; turn?: HarnessTurn } };
      message?: string;
    };
    if (e.response?.data?.turn) {
      turns.value = [e.response.data.turn, ...turns.value].slice(0, 40);
    }
    formError.value = e.response?.data?.error ?? e.message ?? 'Ask failed';
  } finally {
    busy.value = false;
  }
}

async function seedOrg() {
  seedMsg.value = '';
  busy.value = true;
  try {
    const res = await api.post('/api/bot/org-kg', { fact: orgFact.value.trim() });
    seedMsg.value = res.data.message ?? 'Recorded.';
    if (res.data.syncedToMemPalace) seedMsg.value += ' (MemPalace synced)';
    orgFact.value = '';
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    seedMsg.value = e.response?.data?.error ?? e.message ?? 'Seed failed';
  } finally {
    busy.value = false;
  }
}

async function loadOps() {
  opsText.value = '';
  try {
    const res = await api.get('/api/bot/ops/status');
    opsText.value = res.data.text ?? '';
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    opsText.value = e.response?.data?.error ?? e.message ?? 'Ops failed';
  }
}

async function loadScopes() {
  try {
    const res = await api.get('/api/bot/memory/scopes');
    if (res.data.isolationRule) isolationRule.value = res.data.isolationRule;
  } catch {
    /* ignore */
  }
  try {
    const res = await api.get('/api/bot/org-kg');
    orgFacts.value = (res.data.facts ?? []).slice(0, 12);
  } catch {
    /* ignore */
  }
}

async function loadPrivate() {
  privateMsg.value = '';
  privateFacts.value = [];
  busy.value = true;
  try {
    const res = await api.get('/api/bot/memory/private', {
      params: { uid: privateUid.value.trim() },
    });
    privateFacts.value = res.data.facts ?? [];
    privateMsg.value =
      privateFacts.value.length === 0 ? 'No private facts for that uid.' : (res.data.warning ?? '');
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    privateMsg.value = e.response?.data?.error ?? e.message ?? 'Load failed';
  } finally {
    busy.value = false;
  }
}

async function runUnderMusic() {
  voiceCheckText.value = '';
  try {
    const res = await api.get('/api/bot/voice/under-music-check');
    const r = res.data;
    const lines = [
      `Under-music check: ${r.ok ? 'PASS' : 'FAIL'}`,
      ...(r.plan?.notes ?? []),
      ...((r.results ?? []) as Array<{ id: string; pass: boolean; reason?: string }>).map(
        (x) => `${x.pass ? '✓' : '✗'} ${x.id}${x.reason ? ` — ${x.reason}` : ''}`,
      ),
    ];
    voiceCheckText.value = lines.join('\n');
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    voiceCheckText.value = e.response?.data?.error ?? e.message ?? 'Check failed';
  }
}

async function runEval() {
  evalText.value = '';
  try {
    const res = await api.post('/api/bot/rag/eval', {});
    const r = res.data;
    const lines = [
      `RAG eval: ${r.ok ? 'PASS' : 'FAIL'} (${r.passed}/${r.passed + r.failed})`,
      ...(
        (r.results ?? []) as Array<{
          id: string;
          pass: boolean;
          reason?: string;
          doctrineHits: number;
          orgHits: number;
        }>
      ).map(
        (x) =>
          `${x.pass ? '✓' : '✗'} ${x.id} doc=${x.doctrineHits} org=${x.orgHits}${
            x.reason ? ` — ${x.reason}` : ''
          }`,
      ),
    ];
    evalText.value = lines.join('\n');
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    evalText.value = e.response?.data?.error ?? e.message ?? 'Eval failed';
  }
}

onMounted(() => {
  refreshTurns();
  loadScopes();
});
</script>

<style scoped>
.harness {
  max-width: 820px;
  margin: 0 auto;
  padding: 20px 16px 80px;
}
.harness-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}
.harness-title {
  margin: 0;
  font-size: 1.5rem;
}
.harness-sub {
  margin: 4px 0 0;
  color: var(--text-muted, #888);
  font-size: 0.9rem;
}
.harness-mode {
  display: flex;
  gap: 12px;
  font-size: 0.9rem;
}
.mode-label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.ask-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.ask-input,
.seed-input {
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--border, #333);
  background: var(--surface, #1a1a1e);
  color: inherit;
  padding: 10px 12px;
  font: inherit;
  resize: vertical;
}
.ask-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ask-btn,
.ghost-btn {
  border-radius: 8px;
  border: none;
  padding: 8px 14px;
  font: inherit;
  cursor: pointer;
}
.ask-btn {
  background: var(--accent, #6c8cff);
  color: #fff;
}
.ask-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ghost-btn {
  background: transparent;
  border: 1px solid var(--border, #333);
  color: inherit;
}
.form-error {
  color: #f66;
  font-size: 0.9rem;
}
.ops-box {
  background: var(--surface, #1a1a1e);
  border-radius: 8px;
  padding: 10px;
  font-size: 0.85rem;
  white-space: pre-wrap;
  margin: 0 0 16px;
}
.section-title {
  font-size: 1.05rem;
  margin: 0 0 6px;
}
.hint {
  font-size: 0.85rem;
  color: var(--text-muted, #888);
  margin: 0 0 8px;
}
.seed-row {
  display: flex;
  gap: 8px;
}
.scopes {
  margin: 20px 0;
}
.isolation {
  font-weight: 500;
  color: #c9a227;
}
.scope-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 720px) {
  .scope-grid {
    grid-template-columns: 1fr;
  }
}
.scope-card {
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--border, #333);
  background: var(--surface, #141418);
}
.scope-card.private {
  border-color: #664;
}
.scope-card.org {
  border-color: #364;
}
.scope-card h3 {
  margin: 0 0 6px;
  font-size: 1rem;
}
.badge {
  display: inline-block;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  margin-bottom: 8px;
}
.badge.never {
  background: #522;
  color: #fcc;
}
.badge.ok {
  background: #243;
  color: #cfc;
}
.fact-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 0.85rem;
}
.seed-msg {
  font-size: 0.85rem;
  margin: 8px 0 0;
}
.turns {
  margin-top: 24px;
}
.empty {
  color: var(--text-muted, #888);
  font-size: 0.9rem;
}
.turn {
  border: 1px solid var(--border, #333);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: var(--surface, #141418);
}
.turn.errored {
  border-color: #a44;
}
.turn-meta {
  display: flex;
  gap: 10px;
  font-size: 0.75rem;
  color: var(--text-muted, #888);
  margin-bottom: 6px;
}
.turn-mode {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.turn-err-badge {
  color: #f66;
  font-weight: 600;
}
.turn-user,
.turn-reply {
  margin: 4px 0;
  white-space: pre-wrap;
  line-height: 1.45;
}
.turn-error {
  color: #f66;
  margin: 6px 0;
  font-size: 0.9rem;
}
.turn-block {
  margin-top: 10px;
}
.turn-block h3 {
  margin: 0 0 4px;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
}
.turn-block ul {
  margin: 0;
  padding-left: 18px;
}
.turn-block li {
  margin-bottom: 6px;
  font-size: 0.9rem;
}
.cls {
  margin-left: 6px;
  font-size: 0.75rem;
  padding: 1px 6px;
  border-radius: 999px;
  background: #333;
}
.score {
  margin-left: 6px;
  opacity: 0.7;
  font-size: 0.8rem;
}
.src-text {
  margin-top: 2px;
  opacity: 0.85;
  font-size: 0.85rem;
}
.tool-ok {
  margin-left: 6px;
  font-size: 0.75rem;
  text-transform: uppercase;
}
.fail .tool-ok {
  color: #f66;
}
.tool-args,
.tool-result,
.tool-error {
  margin: 2px 0 0;
  font-size: 0.8rem;
  white-space: pre-wrap;
}
.tool-error {
  color: #f66;
}
</style>
