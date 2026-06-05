<template>
  <AvatarUpload v-model="avatarDataUrl" />
</template>

<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue';
import axios from 'axios';
import AvatarUpload from './AvatarUpload.vue';

const props = defineProps<{ botId: string }>();
const avatarDataUrl = ref<string | null>(null);
// Stays true until the watcher queued by the load-time assignment has run,
// so the initial null → loaded-data-url transition does not fire a redundant
// PUT echoing the just-fetched bytes back to the server.
let initializing = true;

async function loadCurrent() {
  try {
    const res = await axios.get(`/api/bot/${props.botId}/avatar`, { responseType: 'blob' });
    const blob = res.data as Blob;
    avatarDataUrl.value = await blobToDataUrl(blob);
  } catch (err: any) {
    if (err?.response?.status !== 404) {
      console.warn('failed to load avatar', err);
    }
    avatarDataUrl.value = null;
  } finally {
    // Wait for the watcher's flush queue to drain (it'll see initializing=true
    // and bail), then release for real user-driven changes.
    await nextTick();
    initializing = false;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

watch(avatarDataUrl, async (newVal, oldVal) => {
  if (initializing) return;
  if (newVal === oldVal) return;
  try {
    if (newVal && newVal.startsWith('data:')) {
      await axios.put(`/api/bot/${props.botId}/avatar`, { dataUrl: newVal });
    } else if (newVal === null) {
      await axios.delete(`/api/bot/${props.botId}/avatar`);
    }
  } catch (err) {
    console.warn('avatar update failed', err);
  }
});

onMounted(loadCurrent);
</script>
