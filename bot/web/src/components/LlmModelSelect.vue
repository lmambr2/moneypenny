<template>
  <div class="llm-model-select">
    <select
      class="input"
      :value="modelValue"
      :disabled="disabled || loading"
      :aria-label="label"
      @change="onSelect"
    >
      <option v-if="!modelValue" value="" disabled>{{ emptyLabel }}</option>
      <option v-for="m in options" :key="m.id" :value="m.id">{{ formatModelLabel(m) }}</option>
      <option v-if="orphan" :value="modelValue">{{ modelValue }} (not in catalog)</option>
      <option value="__custom">Type a model id…</option>
    </select>
    <input
      v-if="custom || (!options.length && !loading)"
      class="input"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onType"
    />
    <button
      type="button"
      class="btn-sm"
      :disabled="disabled || loading || !canReload"
      :title="reloadTitle"
      @click="$emit('reload')"
    >
      {{ loading ? '…' : 'Reload' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatModelLabel, type LlmCatalogModel } from '../api/llm-catalog.js';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    models: LlmCatalogModel[];
    loading?: boolean;
    disabled?: boolean;
    label?: string;
    placeholder?: string;
    canReload?: boolean;
    reloadTitle?: string;
  }>(),
  {
    loading: false,
    disabled: false,
    label: 'Chat model',
    placeholder: 'Qwen3.8',
    canReload: true,
    reloadTitle: 'Reload models from the endpoint',
  },
);

const emit = defineEmits<{
  'update:modelValue': [string];
  reload: [];
}>();

const custom = ref(false);
const options = computed(() => props.models);
const emptyLabel = computed(() => (props.loading ? 'Loading models…' : 'No models listed'));
const orphan = computed(
  () => !!props.modelValue && !props.models.some((m) => m.id === props.modelValue) && !custom.value,
);

watch(
  () => props.models,
  (list) => {
    if (custom.value && list.some((m) => m.id === props.modelValue)) custom.value = false;
  },
);

function onSelect(ev: Event) {
  const v = (ev.target as HTMLSelectElement).value;
  if (v === '__custom') {
    custom.value = true;
    return;
  }
  custom.value = false;
  emit('update:modelValue', v);
}

function onType(ev: Event) {
  emit('update:modelValue', (ev.target as HTMLInputElement).value);
}
</script>

<style scoped>
.llm-model-select {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.llm-model-select .input {
  flex: 1 1 12rem;
  min-width: 10rem;
}
.llm-model-select .btn-sm {
  flex: 0 0 auto;
}
</style>
