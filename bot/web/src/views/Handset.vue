<template>
  <div class="handset">
    <header class="head">
      <div>
        <h1 class="title">Handset</h1>
        <p class="sub">
          Mint a one-time pair code for a phone. The phone talks to the bot. This page stays on the
          loopback admin session.
        </p>
      </div>
    </header>

    <p v-if="!session.isAdmin.value" class="err">Handset pairing is limited to admins.</p>

    <template v-else>
      <p v-if="errText" class="err" role="alert">{{ errText }}</p>

      <section class="card">
        <div class="card-head">
          <h2>Pair code</h2>
          <button class="btn primary" type="button" :disabled="minting" @click="mint">
            {{ minting ? 'Minting…' : 'New pair code' }}
          </button>
        </div>
        <p class="hint">
          A disabled listener refuses the mint. Phones already paired stay in the list below.
        </p>

        <template v-if="pair">
          <p class="code">{{ pair.code }}</p>
          <p class="meta">Expires {{ formatMs(pair.expiresAt) }}</p>
          <p class="meta">{{ pair.advertise }}</p>
          <p class="payload">{{ pair.qrPayload }}</p>
          <div class="payload-row">
            <input
              class="input payload-input"
              :value="pair.qrPayload"
              readonly
              aria-label="Pair payload"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button class="btn ghost" type="button" @click="copyPayload">
              {{ copied ? 'Copied' : 'Copy payload' }}
            </button>
          </div>
          <svg
            v-if="qr"
            class="pair-qr"
            :viewBox="`0 0 ${qr.size} ${qr.size}`"
            role="img"
            aria-label="Pair code QR"
          >
            <rect :width="qr.size" :height="qr.size" fill="#ffffff" />
            <path :d="qr.d" fill="#000000" />
          </svg>
        </template>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Devices</h2>
          <button class="btn ghost" type="button" :disabled="listing" @click="loadDevices">
            Refresh
          </button>
        </div>
        <p v-if="!devices.length" class="muted">No devices.</p>
        <ul v-else class="devices">
          <li v-for="device in devices" :key="device.id" class="device">
            <div>
              <div class="label">{{ device.label }}</div>
              <div class="meta">{{ device.id }}</div>
              <div class="meta">Last seen {{ formatMs(device.lastSeenAt) }}</div>
            </div>
            <span v-if="isRevoked(device)" class="meta">Revoked</span>
            <button
              v-else-if="pendingRevoke !== device.id"
              class="btn danger ghost small"
              type="button"
              @click="pendingRevoke = device.id"
            >
              Revoke
            </button>
            <button
              v-else
              class="btn danger small"
              type="button"
              @click="confirmRevoke(device.id)"
            >
              Confirm
            </button>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { encode } from 'uqr';
import { computed, onMounted, ref } from 'vue';
import api from '../api/axios.js';
import { useSession } from '../composables/useSession.js';

interface HandsetDevice {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

interface PairCode {
  code: string;
  expiresAt: number;
  qrPayload: string;
  advertise: string;
}

const session = useSession();
const devices = ref<HandsetDevice[]>([]);
const pair = ref<PairCode | null>(null);
const errText = ref('');
const minting = ref(false);
const listing = ref(false);
const copied = ref(false);
const pendingRevoke = ref<string | null>(null);

const qr = computed(() => {
  const payload = pair.value?.qrPayload;
  if (!payload) return null;
  try {
    return qrDrawing(payload);
  } catch {
    return null;
  }
});

function qrDrawing(payload: string): { d: string; size: number } | null {
  // White quiet zone (border 2) so the code scans against the dark dashboard.
  const result = encode(payload, { ecc: 'M', border: 2 });
  const parts: string[] = [];
  for (let y = 0; y < result.data.length; y++) {
    const row = result.data[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      if (row[x]) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  if (!parts.length) return null;
  return { d: parts.join(''), size: result.size };
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toLocaleString();
}

function isRevoked(device: HandsetDevice): boolean {
  return typeof device.revokedAt === 'number';
}

function errorLine(err: unknown): string {
  const data = (err as { response?: { data?: { error?: unknown; code?: unknown } } })?.response
    ?.data;
  const message = typeof data?.error === 'string' ? data.error : 'Request failed';
  const code = typeof data?.code === 'string' ? data.code : '';
  return code ? `${message} (${code})` : message;
}

async function loadDevices() {
  if (!session.isAdmin.value) return;
  listing.value = true;
  try {
    const res = await api.get<{ devices?: HandsetDevice[] }>('/api/handset/devices');
    devices.value = Array.isArray(res.data?.devices) ? res.data.devices : [];
  } catch (err) {
    errText.value = errorLine(err);
  } finally {
    listing.value = false;
  }
}

async function mint() {
  errText.value = '';
  copied.value = false;
  minting.value = true;
  try {
    const res = await api.post<PairCode>('/api/handset/pair-codes');
    const data = res.data;
    if (!data?.code || !data.qrPayload || !data.advertise || !data.expiresAt) {
      pair.value = null;
      errText.value = 'Request failed';
      return;
    }
    pair.value = {
      code: data.code,
      expiresAt: data.expiresAt,
      qrPayload: data.qrPayload,
      advertise: data.advertise,
    };
  } catch (err) {
    pair.value = null;
    errText.value = errorLine(err);
  } finally {
    minting.value = false;
  }
}

async function confirmRevoke(id: string) {
  errText.value = '';
  try {
    await api.delete(`/api/handset/devices/${encodeURIComponent(id)}`);
    pendingRevoke.value = null;
    await loadDevices();
  } catch (err) {
    errText.value = errorLine(err);
  }
}

async function copyPayload() {
  const text = pair.value?.qrPayload;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

onMounted(() => {
  if (session.isAdmin.value) void loadDevices();
});
</script>

<style scoped>
.handset {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 0 80px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.title {
  margin: 0;
  font-size: 1.4rem;
}
.sub {
  color: var(--text-secondary, #888);
  font-size: 0.9rem;
  margin: 6px 0 0;
  max-width: 52rem;
}
.card {
  border: 1px solid var(--border-color, #333);
  border-radius: 12px;
  padding: 14px 16px;
  background: var(--bg-secondary, #141418);
  margin-bottom: 14px;
}
.card h2 {
  margin: 0;
  font-size: 1rem;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.btn {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #333);
  background: var(--hover-bg, #1a1a20);
  color: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.primary {
  background: var(--color-primary, #6366f1);
  border-color: var(--color-primary, #6366f1);
  color: #fff;
}
.btn.ghost {
  background: transparent;
}
.btn.danger {
  color: #ef4444;
}
.btn.small {
  padding: 5px 10px;
  font-size: 12px;
}
.hint,
.meta {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin: 8px 0 0;
}
.muted {
  color: var(--text-tertiary, #666);
  font-size: 13px;
}
.err {
  color: #f87171;
  font-size: 13px;
  margin: 0 0 8px;
}
.code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 1.8rem;
  letter-spacing: 0.08em;
  margin: 12px 0 0;
}
.payload {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  word-break: break-all;
  user-select: all;
  margin: 8px 0 0;
}
.payload-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}
.input {
  flex: 1 1 220px;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #333);
  background: var(--hover-bg, #1a1a20);
  color: inherit;
  font-size: 12px;
  font-family: var(--font-mono, ui-monospace, monospace);
}
.pair-qr {
  display: block;
  width: 220px;
  height: 220px;
  margin-top: 12px;
  background: #fff;
  border-radius: 8px;
}
.devices {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.device {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--border-color, #333);
  padding-top: 8px;
}
.label {
  font-weight: 600;
}
</style>
