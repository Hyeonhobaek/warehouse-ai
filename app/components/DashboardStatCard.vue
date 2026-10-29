<script setup lang="ts">
defineProps<{ label: string; icon: string; unit: string; description: string; tone?: 'blue' | 'amber' }>()
</script>

<template>
  <article class="rounded-xl border border-slate-200/80 bg-white p-5">
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs font-medium text-slate-500">{{ label }}</p>
      <span class="flex size-9 items-center justify-center rounded-lg" :class="tone === 'amber' ? 'bg-amber-50 text-amber-500' : 'bg-blue-50 text-blue-500'"><UIcon :name="icon" class="size-[18px]" /></span>
    </div>
    <p class="mt-3 flex items-baseline gap-2"><span class="text-3xl font-semibold tracking-tight text-slate-800" aria-label="집계 준비 중">—</span><span class="text-xs text-slate-400">{{ unit }}</span></p>
    <p class="mt-3 border-t border-slate-100 pt-3 text-[10px] text-slate-400">{{ description }}</p>
  </article>
</template>
