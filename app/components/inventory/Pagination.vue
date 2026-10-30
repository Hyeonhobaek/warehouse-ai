<script setup lang="ts">
const props = withDefaults(defineProps<{ total: number; page: number; pageSize?: number; busy?: boolean }>(), { pageSize: 20, busy: false })
defineEmits<{ change: [page: number] }>()
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 text-xs text-slate-500">
    <span>전체 {{ total.toLocaleString('ko-KR') }}건</span>
    <div class="flex items-center gap-3">
      <UButton aria-label="이전 페이지" icon="i-lucide-chevron-left" color="neutral" variant="outline" size="xs" :disabled="page <= 1 || busy" @click="$emit('change', page - 1)" />
      <span>{{ page }} / {{ pages }}</span>
      <UButton aria-label="다음 페이지" icon="i-lucide-chevron-right" color="neutral" variant="outline" size="xs" :disabled="page >= pages || busy" @click="$emit('change', page + 1)" />
    </div>
  </div>
</template>
