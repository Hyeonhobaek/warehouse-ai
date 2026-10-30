<script setup lang="ts">
import type { DashboardResponse } from '#shared/types/dashboard'
import { roleLabels } from '#shared/utils/permissions'

definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: '대시보드 · Warehouse AI' })

const { user, fetchWithSession, refreshSession } = useAuth()
const refreshing = ref(false)
const updatedLabel = ref('방금 확인')
const { data: dashboard, error: dashboardError, refresh } = await useAsyncData('dashboard', () => fetchWithSession<DashboardResponse>('/api/dashboard'))

const stats = [
  { label: '등록 원료', icon: 'i-lucide-flask-conical', unit: '개', description: '대시보드 통계 연결 예정', tone: 'blue' as const },
  { label: '전체 LOT', icon: 'i-lucide-boxes', unit: '개', description: '대시보드 통계 연결 예정', tone: 'blue' as const },
  { label: '재고 부족 원료', icon: 'i-lucide-chart-no-axes-column-decreasing', unit: '개', description: '최소재고 기준 집계 예정', tone: 'amber' as const },
  { label: '재시험 예정', icon: 'i-lucide-calendar-clock', unit: '개', description: '재시험일 기준 집계 예정', tone: 'amber' as const },
]

const roleScope = computed(() => {
  if (user.value?.role === 'admin') return '조회 · 입출고 · 마스터 관리 · 사용자 관리'
  if (user.value?.role === 'operator') return '조회 · 입출고'
  return '조회'
})

async function refreshDashboard() {
  refreshing.value = true
  try {
    const session = await refreshSession()
    if (!session.user) {
      await navigateTo('/login', { replace: true })
      return
    }
    await refresh()
    updatedLabel.value = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date()) + ' 확인'
  }
  catch { await navigateTo('/login', { replace: true }) }
  finally { refreshing.value = false }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div class="mb-2 flex items-center gap-2"><p class="text-[10px] font-semibold tracking-[.18em] text-slate-400">WORKSPACE OVERVIEW</p><span class="rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold text-blue-600">PHASE 2</span></div>
        <h1 class="text-[27px] font-bold tracking-tight text-slate-900">대시보드</h1>
        <p class="mt-2 text-xs text-slate-500">{{ user?.displayName }}님, 안녕하세요. 원료·자재 관리 워크스페이스입니다.</p>
      </div>
      <div class="flex items-center gap-3 pt-1">
        <span class="text-[10px] text-slate-400">{{ updatedLabel }}</span>
        <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" size="sm" :loading="refreshing" class="bg-white" @click="refreshDashboard">새로고침</UButton>
      </div>
    </div>

    <UAlert v-if="dashboardError" color="error" variant="soft" icon="i-lucide-circle-alert" title="워크스페이스 상태를 불러오지 못했습니다" description="연결 상태를 확인한 후 새로고침을 눌러 다시 시도해 주세요." />

    <div class="flex flex-col gap-3 rounded-xl border border-blue-100 bg-[#edf4ff] px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
      <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-blue-600"><UIcon name="i-lucide-panel-top" class="size-5" /></span>
      <div class="flex-1"><p class="text-xs font-semibold text-blue-900">원료와 제조번호별 재고를 확인하세요</p><p class="mt-1 text-[11px] leading-5 text-blue-700/70">원료·LOT·입고건과 창고를 관리하고, 품질상태·재시험일·보관위치로 재고를 검색할 수 있습니다.</p></div>
      <UButton to="/inventory" size="sm" trailing-icon="i-lucide-arrow-right">재고 조회</UButton>
    </div>

    <div class="grid gap-4 md:grid-cols-3">
      <NuxtLink to="/materials" class="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-blue-300"><UIcon name="i-lucide-flask-conical" class="size-5 text-blue-600" /><h2 class="mt-3 text-sm font-semibold text-slate-800">원료 · LOT 관리</h2><p class="mt-2 text-xs leading-5 text-slate-500">원료 검색, 제조번호와 입고건별 시험정보 확인</p></NuxtLink>
      <NuxtLink to="/inventory" class="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-blue-300"><UIcon name="i-lucide-boxes" class="size-5 text-blue-600" /><h2 class="mt-3 text-sm font-semibold text-slate-800">재고 조회</h2><p class="mt-2 text-xs leading-5 text-slate-500">원료 합계와 LOT·위치별 현재고 및 가용재고 확인</p></NuxtLink>
      <NuxtLink to="/warehouses" class="rounded-xl border border-slate-200 bg-white p-5 transition hover:border-blue-300"><UIcon name="i-lucide-warehouse" class="size-5 text-blue-600" /><h2 class="mt-3 text-sm font-semibold text-slate-800">창고 · 보관위치</h2><p class="mt-2 text-xs leading-5 text-slate-500">창고와 세부 위치 기준정보 확인</p></NuxtLink>
    </div>

    <section aria-label="재고 요약 준비 화면" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <DashboardStatCard v-for="stat in stats" :key="stat.label" v-bind="stat" />
    </section>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <section class="overflow-hidden rounded-xl border border-slate-200/80 bg-white" aria-labelledby="recent-transactions-title">
        <div class="flex items-center justify-between gap-3 px-5 py-5">
          <div><h2 id="recent-transactions-title" class="text-sm font-semibold text-slate-800">최근 입출고 내역</h2><p class="mt-1.5 text-[11px] text-slate-400">원료의 이동 내역을 확인하는 공간입니다.</p></div>
          <UBadge color="neutral" variant="subtle" size="sm">준비 중</UBadge>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[520px] text-left text-[11px]">
            <caption class="sr-only">입출고 기능은 Phase 3에서 제공되며 현재 거래 데이터는 없습니다.</caption>
            <thead class="border-y border-slate-100 bg-slate-50/80 text-slate-400"><tr><th class="px-5 py-3 font-medium">처리일시</th><th class="px-3 py-3 font-medium">구분</th><th class="px-3 py-3 font-medium">원료명 / LOT</th><th class="px-3 py-3 font-medium">수량</th><th class="px-5 py-3 font-medium">작업자</th></tr></thead>
            <tbody><tr><td colspan="5" class="px-5 py-12 text-center">
              <span class="mx-auto flex size-14 items-center justify-center rounded-2xl border border-slate-100 bg-slate-50 text-slate-300"><UIcon name="i-lucide-package-open" class="size-7" /></span>
              <p class="mt-4 text-xs font-medium text-slate-600">입출고 기록을 위한 공간이 준비되었습니다</p>
              <p class="mt-2 text-[11px] leading-5 text-slate-400">입고·불출·반납 기능이 연결되면<br>이곳에서 최근 거래를 확인할 수 있습니다.</p>
            </td></tr></tbody>
          </table>
        </div>
        <div class="flex items-center gap-1.5 border-t border-slate-100 px-5 py-3 text-[10px] text-slate-400"><UIcon name="i-lucide-info" class="size-3" />현재 화면은 집계 데이터가 없는 기본 화면입니다.</div>
      </section>

      <aside class="space-y-4" aria-label="워크스페이스 정보">
        <section class="rounded-xl border border-slate-200/80 bg-white p-5">
          <div class="flex items-center justify-between"><h2 class="text-sm font-semibold text-slate-800">워크스페이스 상태</h2><UIcon name="i-lucide-radio-tower" class="size-4 text-slate-400" /></div>
          <div class="mt-5 space-y-4 text-[11px]">
            <div class="flex justify-between gap-3"><span class="text-slate-500">인증 및 프로필</span><span :class="dashboard ? 'text-emerald-600' : 'text-amber-600'" class="flex items-center gap-1.5 font-medium"><span class="size-1.5 rounded-full" :class="dashboard ? 'bg-emerald-500' : 'bg-amber-500'" />{{ dashboard ? '연결 확인' : '확인 필요' }}</span></div>
            <div class="flex justify-between gap-3"><span class="text-slate-500">접근 권한</span><span class="font-medium text-slate-700">{{ user ? roleLabels[user.role] : '확인 중' }}</span></div>
            <div class="flex justify-between gap-3"><span class="text-slate-500">데이터 환경</span><span class="font-medium text-slate-700">가상 데이터 전용</span></div>
          </div>
          <div class="mt-5 rounded-lg bg-slate-50 p-3"><p class="text-[10px] leading-5 text-slate-500">사용자 인증과 역할을 서버에서 확인한 후 워크스페이스에 접근합니다.</p></div>
        </section>
        <section class="rounded-xl border border-slate-200/80 bg-white p-5">
          <div class="flex items-center gap-2"><UIcon name="i-lucide-badge-check" class="size-4 text-blue-500" /><h2 class="text-xs font-semibold text-slate-800">내 계정 권한</h2></div>
          <p class="mt-3 text-[11px] font-medium leading-6 text-slate-600">{{ roleScope }}</p>
          <p class="mt-2 text-[10px] leading-5 text-slate-400">역할에 따른 권한 범위입니다.<br>각 업무 기능은 해당 개발 단계에서 제공됩니다.</p>
        </section>
      </aside>
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <section class="flex items-center gap-4 rounded-xl border border-slate-200/80 bg-white px-5 py-4"><span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-500"><UIcon name="i-lucide-calendar-range" class="size-5" /></span><div class="flex-1"><h2 class="text-xs font-medium text-slate-600">유효기간 임박 원료</h2><p class="mt-1 text-[10px] text-slate-400">유효기간 기준 집계 예정</p></div><span aria-label="집계 준비 중" class="text-2xl text-slate-700">—</span></section>
      <section class="flex items-center gap-4 rounded-xl border border-slate-200/80 bg-white px-5 py-4"><span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-500"><UIcon name="i-lucide-arrow-left-right" class="size-5" /></span><div class="flex-1"><h2 class="text-xs font-medium text-slate-600">금일 입고 · 불출</h2><p class="mt-1 text-[10px] text-slate-400">거래 이력 연결 후 제공</p></div><span aria-label="집계 준비 중" class="text-2xl text-slate-700">— <span class="px-1 text-base text-slate-300">/</span> —</span></section>
    </div>
  </div>
</template>
