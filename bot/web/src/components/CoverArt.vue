<template>
  <div class="cover-art" :style="{ width: size + 'px', height: size + 'px', borderRadius: radius + 'px' }">
    <img
      v-if="url && !errored"
      :src="url"
      alt=""
      class="cover-img"
      :style="{ borderRadius: radius + 'px' }"
      loading="lazy"
      referrerpolicy="no-referrer"
      @load="onImageLoad"
      @error="onImageError"
    />
    <div v-else class="cover-placeholder" :style="{ borderRadius: radius + 'px' }">
      <svg viewBox="0 0 24 24" class="placeholder-icon"><path fill="currentColor" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
    </div>
    <div
      v-if="showShadow && url && !errored"
      class="cover-shadow"
      :style="{
        backgroundImage: `url(${url})`,
        borderRadius: radius + 'px',
      }"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  url: string;
  size?: number;
  radius?: number;
  showShadow?: boolean;
}>(), {
  size: 48,
  radius: 8,
  showShadow: false,
});

const loaded = ref(false);
const errored = ref(false);

// Reset error state when URL changes
watch(() => props.url, () => {
  errored.value = false;
  loaded.value = false;
});

function onImageLoad() {
  loaded.value = true;
}

function onImageError() {
  errored.value = true;
}
</script>

<style lang="scss" scoped>
.cover-art {
  position: relative;
  flex-shrink: 0;
  overflow: hidden;
  background: var(--bg-card);
}

.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  position: relative;
  z-index: 1;
  display: block;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--hover-bg);
}

.placeholder-icon {
  width: 40%;
  height: 40%;
  color: var(--text-tertiary);
  opacity: 0.4;
}

.cover-shadow {
  position: absolute;
  top: 12px;
  left: 0;
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  filter: blur(16px);
  opacity: 0.6;
  transform: scale(0.92);
  z-index: 0;
  transition: opacity 0.3s ease;
}
</style>
