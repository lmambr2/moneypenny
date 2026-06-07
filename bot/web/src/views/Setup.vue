<template>
  <div class="setup-wizard">
    <div class="steps">
      <div v-for="(label, i) in stepLabels" :key="i" class="step" :class="{ active: currentStep === i, done: currentStep > i }">
        <div class="step-dot">{{ currentStep > i ? '✓' : i + 1 }}</div>
        <div class="step-label">{{ label }}</div>
      </div>
    </div>

    <div v-if="currentStep === 0" class="step-content">
      <h2>Welcome to Moneypenny</h2>
      <p class="subtitle">Set an administrator password to protect the WebUI</p>
      <div class="form-group">
        <label>Admin Password</label>
        <input type="password" v-model="adminPassword" placeholder="Choose a password" class="input" minlength="8" />
      </div>
      <div class="form-group">
        <label>Theme</label>
        <select v-model="theme" class="input">
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
      <button class="btn-primary" @click="currentStep = 1">Next</button>
    </div>

    <div v-if="currentStep === 1" class="step-content">
      <h2>Connect to TeamSpeak Server</h2>
      <div class="form-group">
        <label>Server Address</label>
        <input v-model="serverAddress" placeholder="ts.example.com" class="input" />
      </div>
      <div class="form-group">
        <label>Port</label>
        <input v-model.number="serverPort" type="number" placeholder="9987" class="input" />
      </div>
      <div class="form-group">
        <label>Bot Nickname</label>
        <input v-model="nickname" placeholder="MusicBot" class="input" />
      </div>
      <div class="form-group">
        <label>Default Channel (optional)</label>
        <input v-model="defaultChannel" placeholder="Music channel" class="input" />
      </div>
      <div class="btn-row">
        <button class="btn-secondary" @click="currentStep = 0">Back</button>
        <button class="btn-primary" @click="createBotAndNext">Next</button>
      </div>
    </div>

    <div v-if="currentStep === 2" class="step-content">
      <h2>Music Sources</h2>
      <p class="subtitle">Local Music Library is the primary source (configure MUSIC_DIR on the server). YouTube and Stream sources are also available — no account login required for core playback.</p>
      <div class="btn-row">
        <button class="btn-secondary" @click="currentStep = 1">Back</button>
        <button class="btn-primary" @click="currentStep = 3">Continue</button>
      </div>
    </div>

    <div v-if="currentStep === 3" class="step-content done-step">
      <h2>Setup Complete!</h2>
      <p class="subtitle">Moneypenny is ready to use.</p>
      <button class="btn-primary" @click="$router.push('/')">Get Started</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';

const currentStep = ref(0);
const stepLabels = ['Welcome', 'TeamSpeak', 'Music Sources', 'Done'];

const adminPassword = ref('');
const theme = ref('dark');
const serverAddress = ref('');
const serverPort = ref(9987);
const nickname = ref('MusicBot');
const defaultChannel = ref('');

async function createBotAndNext() {
  try {
    await axios.post('/api/bot', {
      name: `Bot - ${serverAddress.value}`,
      serverAddress: serverAddress.value,
      serverPort: serverPort.value,
      nickname: nickname.value,
      defaultChannel: defaultChannel.value,
      autoStart: true,
    });
    currentStep.value = 2;
  } catch (err: any) {
    const playerStore = usePlayerStore();
    const msg = err?.response?.data?.message || err?.response?.data?.error || 'Failed to create bot during setup';
    playerStore.notify(msg, 'error');
  }
}
</script>

<style lang="scss" scoped>
.setup-wizard {
  max-width: 560px;
  margin: 0 auto;
  padding-top: 40px;
}

.steps {
  display: flex;
  justify-content: space-between;
  margin-bottom: 48px;
}

.step {
  text-align: center;
  flex: 1;
}

.step-dot {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  background: var(--hover-bg);
  margin-bottom: 8px;
  opacity: 0.5;
}

.step.active .step-dot {
  background: var(--color-primary);
  color: white;
  opacity: 1;
}

.step.done .step-dot {
  background: var(--color-primary);
  color: white;
  opacity: 0.7;
}

.step-label {
  font-size: 12px;
  opacity: 0.5;
}

.step.active .step-label { opacity: 1; color: var(--color-primary); }

.step-content h2 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 8px;
}

.subtitle {
  color: var(--text-secondary);
  margin-bottom: 32px;
}

.form-group {
  margin-bottom: 20px;

  label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 6px;
    opacity: 0.8;
  }
}

.input {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: 14px;
  color: var(--text-primary);
  outline: none;
  font-family: inherit;

  &:focus {
    border-color: var(--color-primary);
  }
}

.btn-primary {
  padding: 10px 32px;
  background: var(--color-primary);
  color: white;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
  transition: transform var(--transition-fast);

  &:hover { transform: scale(1.04); }
  &:active { transform: scale(0.96); }
}

.btn-secondary {
  padding: 10px 32px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 600;
}

.btn-row {
  display: flex;
  gap: 12px;
  margin-top: 32px;
}

.done-step {
  text-align: center;
  padding-top: 60px;
}
</style>
