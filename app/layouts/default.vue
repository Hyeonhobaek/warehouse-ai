<script setup lang="ts">
import { roleLabels } from '#shared/utils/permissions'

const { user, logout } = useAuth()
const mobileMenuOpen = ref(false)
const loggingOut = ref(false)
const logoutError = ref<string | null>(null)
const initial = computed(() => user.value?.displayName.slice(0, 1) || 'U')

async function handleLogout() {
  loggingOut.value = true
  logoutError.value = null
  try { await logout() }
  catch { logoutError.value = '로그아웃을 완료하지 못했습니다. 다시 시도해 주세요.' }
  finally { loggingOut.value = false }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') mobileMenuOpen.value = false
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="min-h-screen bg-[#f5f7fb]">
    <a href="#main-content" class="sr-only fixed z-50 m-3 rounded bg-white px-4 py-2 text-blue-700 focus:not-sr-only">본문으로 건너뛰기</a>
    <div class="fixed inset-y-0 left-0 z-30 hidden w-[248px] lg:block"><AppSidebar /></div>
    <div v-if="mobileMenuOpen" class="fixed inset-0 z-40 lg:hidden">
      <button class="absolute inset-0 bg-slate-900/40" aria-label="메뉴 닫기" @click="mobileMenuOpen = false" />
      <div id="mobile-navigation" class="absolute inset-y-0 left-0 w-[270px]"><AppSidebar @navigate="mobileMenuOpen = false" /></div>
      <UButton icon="i-lucide-x" color="neutral" variant="solid" class="absolute left-[278px] top-5" aria-label="메뉴 닫기" @click="mobileMenuOpen = false" />
    </div>
    <div class="lg:pl-[248px]">
      <header class="flex h-20 items-center justify-between gap-4 border-b border-slate-200/80 bg-white px-5 sm:px-8">
        <div class="flex items-center gap-3">
          <UButton icon="i-lucide-menu" color="neutral" variant="ghost" class="lg:hidden" aria-label="주 메뉴 열기" :aria-expanded="mobileMenuOpen" aria-controls="mobile-navigation" @click="mobileMenuOpen = true" />
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <span class="hidden sm:inline">워크스페이스</span>
            <UIcon name="i-lucide-chevron-right" class="hidden size-3 sm:block" />
            <span class="font-medium text-slate-700">대시보드</span>
          </div>
        </div>
        <div class="flex items-center gap-3 sm:gap-5">
          <div class="hidden items-center gap-1.5 border-r border-slate-200 pr-5 text-[11px] text-slate-500 xl:flex">
            <UIcon name="i-lucide-lock-keyhole" class="size-3.5 text-slate-400" />보호된 워크스페이스
          </div>
          <div v-if="user" class="flex items-center gap-2.5">
            <span class="flex size-9 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-600 ring-1 ring-slate-200">{{ initial }}</span>
            <div class="hidden sm:block">
              <p class="max-w-40 truncate text-xs font-semibold text-slate-800">{{ user.displayName }}</p>
              <p class="mt-0.5 text-[10px] text-slate-400">{{ roleLabels[user.role] }}</p>
            </div>
          </div>
          <UButton color="neutral" variant="ghost" icon="i-lucide-log-out" size="sm" :loading="loggingOut" aria-label="로그아웃" @click="handleLogout"><span class="hidden sm:inline">로그아웃</span></UButton>
        </div>
      </header>
      <div v-if="logoutError" role="alert" class="border-b border-red-100 bg-red-50 px-8 py-3 text-sm text-red-700">{{ logoutError }}</div>
      <main id="main-content" class="mx-auto max-w-[1600px] px-5 py-7 sm:px-8 sm:py-8">
        <slot />
      </main>
      <footer class="mx-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/80 py-5 text-[10px] text-slate-400 sm:mx-8">
        <p>Warehouse AI · 원료·자재 재고관리 시스템</p>
        <p>시범 개발용 · 정식 업무 적용 전 검증 필요</p>
      </footer>
    </div>
  </div>
</template>
