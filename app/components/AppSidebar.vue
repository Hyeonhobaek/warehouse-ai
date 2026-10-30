<script setup lang="ts">
defineEmits<{ navigate: [] }>()

const route = useRoute()
function isCurrent(path: string) {
  return path === '/' ? route.path === '/' : route.path === path || route.path.startsWith(`${path}/`)
}

const menuGroups = [
  { label: '워크스페이스', items: [
    { label: '대시보드', icon: 'i-lucide-layout-dashboard', to: '/' },
    { label: '원료 관리', icon: 'i-lucide-flask-conical', to: '/materials' },
    { label: '재고 조회', icon: 'i-lucide-boxes', to: '/inventory' },
    { label: '창고 · 보관위치', icon: 'i-lucide-warehouse', to: '/warehouses' },
  ] },
  { label: '재고 업무', items: [
    { label: 'BOM 관리', icon: 'i-lucide-list-tree', to: '/boms' },
    { label: '생산일정 · 예정 불출', icon: 'i-lucide-calendar-days', to: '/production' },
    { label: '입고 관리', icon: 'i-lucide-package-plus', to: '/receipts' },
    { label: '불출 관리', icon: 'i-lucide-package-minus', to: '/issues' },
    { label: '반납 관리', icon: 'i-lucide-undo-2', to: '/returns' },
    { label: '시험번호별 원장', icon: 'i-lucide-history', to: '/transactions' },
  ] },
  { label: '분석 및 관리', items: [
    { label: 'AI 분석', icon: 'i-lucide-sparkles', to: null },
    { label: '관리자 설정', icon: 'i-lucide-settings-2', to: null },
  ] },
]
</script>

<template>
  <aside class="flex h-full flex-col border-r border-slate-200/80 bg-white">
    <div class="flex h-20 shrink-0 items-center px-6">
      <NuxtLink to="/" aria-label="Warehouse AI 대시보드" @click="$emit('navigate')"><BrandLogo /></NuxtLink>
    </div>
    <div class="mx-5 mb-5 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      <span class="size-1.5 rounded-full bg-blue-500" />
      <span class="text-xs font-medium text-slate-600">개발 워크스페이스</span>
      <span class="ml-auto text-[10px] font-semibold tracking-wide text-slate-400">V0.3</span>
    </div>
    <nav aria-label="주 메뉴" class="flex-1 space-y-6 overflow-y-auto px-3">
      <div v-for="group in menuGroups" :key="group.label">
        <p class="mb-2 px-3 text-[10px] font-semibold tracking-wider text-slate-400">{{ group.label }}</p>
        <div class="space-y-1">
          <template v-for="item in group.items" :key="item.label">
            <NuxtLink v-if="item.to" :to="item.to" :aria-current="isCurrent(item.to) ? 'page' : undefined" class="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm" :class="isCurrent(item.to) ? 'bg-blue-50 font-semibold text-blue-600' : 'text-slate-600 hover:bg-slate-50'" @click="$emit('navigate')">
              <UIcon :name="item.icon" class="size-[18px]" />
              {{ item.label }}
              <span v-if="isCurrent(item.to)" class="ml-auto size-1.5 rounded-full bg-blue-500" />
            </NuxtLink>
            <button v-else type="button" disabled :aria-label="`${item.label} · 준비 중`" class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-slate-400">
              <UIcon :name="item.icon" class="size-[18px]" />
              {{ item.label }}
              <span class="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-400">준비 중</span>
            </button>
          </template>
        </div>
      </div>
    </nav>
    <div class="m-4 mt-8 rounded-xl border border-blue-100 bg-blue-50/50 p-4">
      <div class="mb-2 flex items-center gap-2 text-xs font-semibold text-blue-700"><UIcon name="i-lucide-shield-check" class="size-4" />안전한 개발 환경</div>
      <p class="text-[11px] leading-relaxed text-slate-500">가상 데이터로 검증하는 공간입니다.<br>실제 회사 정보는 사용하지 마세요.</p>
    </div>
    <div class="border-t border-slate-100 px-6 py-4 text-[10px] text-slate-400">Warehouse AI · 원료 재고관리</div>
  </aside>
</template>
