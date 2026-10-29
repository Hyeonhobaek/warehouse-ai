<script setup lang="ts">
withDefaults(defineProps<{ inverse?: boolean; compact?: boolean }>(), {
  inverse: false,
  compact: false,
})
</script>

<template>
  <div class="flex items-center gap-3" :class="inverse ? 'text-white' : 'text-slate-900'">
    <span class="flex size-10 shrink-0 items-center justify-center rounded-xl" :class="inverse ? 'bg-white/10 text-blue-300 ring-1 ring-white/15' : 'bg-blue-600 text-white shadow-sm shadow-blue-600/20'">
      <UIcon name="i-lucide-boxes" class="size-6" />
    </span>
    <div v-if="!compact">
      <p class="text-[17px] font-bold leading-5 tracking-tight">Warehouse<span :class="inverse ? 'text-blue-300' : 'text-blue-600'"> AI</span></p>
      <p class="mt-1 text-[10px] font-medium tracking-[.15em]" :class="inverse ? 'text-slate-400' : 'text-slate-400'">MATERIAL MANAGEMENT</p>
    </div>
  </div>
</template>
