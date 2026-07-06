<template>
  <div class="star-rating" :class="{ readonly }" role="group" :aria-label="`Rating ${modelValue ?? 0} of 5`">
    <button
      v-for="n in 5"
      :key="n"
      type="button"
      class="star-btn"
      :class="{ filled: (hover || modelValue || 0) >= n }"
      :disabled="readonly || busy"
      :title="readonly ? undefined : `Rate ${n}`"
      @mouseenter="!readonly && (hover = n)"
      @mouseleave="hover = 0"
      @click="!readonly && pick(n)"
    >
      ★
    </button>
    <span v-if="aggregate" class="agg">{{ aggregate }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  modelValue?: number | null;
  readonly?: boolean;
  busy?: boolean;
  aggregate?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [number | null]; rate: [number]; unrate: [] }>();

const hover = ref(0);

function pick(n: number) {
  if (props.modelValue === n) {
    emit('unrate');
    emit('update:modelValue', null);
  } else {
    emit('rate', n);
    emit('update:modelValue', n);
  }
}
</script>

<style scoped lang="scss">
.star-rating {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.star-btn {
  border: none;
  background: none;
  padding: 0 1px;
  font-size: 16px;
  line-height: 1;
  color: var(--text-tertiary);
  cursor: pointer;
  &.filled { color: #f5c542; }
  &:disabled { cursor: default; }
}
.readonly .star-btn { cursor: default; }
.agg {
  margin-left: 6px;
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>