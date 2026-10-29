<script setup lang="ts">
import { loginSchema } from '#shared/schemas/auth'

definePageMeta({ layout: false, middleware: 'guest' })
useSeoMeta({ title: '로그인 · Warehouse AI', description: 'Warehouse AI 원료·자재 관리 워크스페이스 로그인' })

const { configured, sessionError, logoutNotice, login, refreshSession } = useAuth()
const state = reactive({ email: '', password: '' })
const passwordVisible = ref(false)
const submitting = ref(false)
const checking = ref(false)
const loginError = ref<string | null>(null)

async function onSubmit() {
  submitting.value = true
  loginError.value = null
  try {
    await login({ email: state.email, password: state.password })
    state.password = ''
    await navigateTo('/', { replace: true })
  }
  catch (error) { loginError.value = authErrorMessage(error) }
  finally { submitting.value = false }
}

async function checkConnection() {
  checking.value = true
  try {
    const session = await refreshSession()
    if (session.user) await navigateTo('/', { replace: true })
  }
  catch { /* The shared session error is rendered below. */ }
  finally { checking.value = false }
}
</script>

<template>
  <div class="flex min-h-screen bg-white">
    <section class="login-grid relative hidden w-[46%] flex-col overflow-hidden bg-[#101e35] p-12 text-white lg:flex xl:p-16">
      <div class="absolute -right-40 top-40 size-[500px] rounded-full bg-blue-500/10 blur-[100px]" />
      <BrandLogo inverse />
      <div class="relative my-auto py-20">
        <span class="inline-flex items-center gap-2 rounded-full border border-blue-300/20 bg-blue-400/10 px-3 py-1.5 text-[11px] font-medium text-blue-200"><span class="size-1.5 rounded-full bg-blue-300" />원료·자재 관리 워크스페이스</span>
        <h1 class="mt-7 text-4xl font-semibold leading-[1.45] tracking-tight xl:text-[44px]">재고 관리의 시작,<br><span class="text-blue-300">정확한 연결부터.</span></h1>
        <p class="mt-6 max-w-sm text-sm leading-7 text-slate-400">원료와 자재, 그리고 업무를 하나로.<br>팀을 위한 체계적인 재고관리 환경을 준비합니다.</p>
        <div class="mt-12 space-y-5">
          <div class="flex items-center gap-3"><span class="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/5"><UIcon name="i-lucide-shield-check" class="size-4 text-blue-300" /></span><span class="text-xs text-slate-300">사용자별 역할과 접근 권한</span></div>
          <div class="flex items-center gap-3"><span class="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/5"><UIcon name="i-lucide-panels-top-left" class="size-4 text-blue-300" /></span><span class="text-xs text-slate-300">한눈에 확인하는 업무 워크스페이스</span></div>
          <div class="flex items-center gap-3"><span class="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/5"><UIcon name="i-lucide-network" class="size-4 text-blue-300" /></span><span class="text-xs text-slate-300">단계적으로 확장하는 관리 시스템</span></div>
        </div>
      </div>
      <div class="relative flex items-center justify-between border-t border-white/10 pt-6 text-[10px] text-slate-500"><span>WAREHOUSE AI</span><span>Phase 1 · Foundation</span></div>
    </section>

    <main class="flex min-h-screen flex-1 flex-col items-center justify-center px-6 py-12 sm:px-12">
      <div class="w-full max-w-[390px]">
        <div class="mb-12 lg:hidden"><BrandLogo /></div>
        <div class="mb-8">
          <span class="text-[11px] font-semibold tracking-[.16em] text-blue-600">WELCOME BACK</span>
          <h2 class="mt-3 text-[28px] font-bold tracking-tight text-slate-900">워크스페이스 로그인</h2>
          <p class="mt-3 text-sm leading-6 text-slate-500">발급받은 계정으로 로그인해 주세요.</p>
        </div>

        <UAlert v-if="logoutNotice" icon="i-lucide-info" color="warning" variant="soft" title="로그아웃 안내" :description="logoutNotice" class="mb-6" />
        <UAlert v-if="!configured" icon="i-lucide-plug-zap" color="warning" variant="soft" title="Supabase 연결 설정이 필요합니다" description="README의 실행 가이드에 따라 환경변수를 설정하고 개발 서버를 다시 시작해 주세요." class="mb-6" />
        <UAlert v-else-if="sessionError && !loginError" icon="i-lucide-circle-alert" color="error" variant="soft" title="로그인 상태를 확인하지 못했습니다" :description="sessionError" class="mb-6" />
        <UAlert v-if="loginError" icon="i-lucide-circle-alert" color="error" variant="soft" title="로그인을 완료하지 못했습니다" :description="loginError" class="mb-6" />

        <UForm :schema="loginSchema" :state="state" class="space-y-5" @submit="onSubmit">
          <UFormField label="이메일" name="email" required>
            <UInput v-model="state.email" type="email" autocomplete="username" placeholder="name@example.com" icon="i-lucide-mail" size="xl" class="w-full" :disabled="submitting || !configured" />
          </UFormField>
          <UFormField label="비밀번호" name="password" required>
            <UInput v-model="state.password" :type="passwordVisible ? 'text' : 'password'" autocomplete="current-password" placeholder="비밀번호를 입력하세요" icon="i-lucide-lock-keyhole" size="xl" class="w-full" :disabled="submitting || !configured" :ui="{ trailing: 'pe-1' }">
              <template #trailing>
                <UButton :icon="passwordVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'" color="neutral" variant="link" size="sm" :aria-label="passwordVisible ? '비밀번호 숨기기' : '비밀번호 보기'" :aria-pressed="passwordVisible" :disabled="submitting || !configured" @click="passwordVisible = !passwordVisible" />
              </template>
            </UInput>
          </UFormField>
          <UButton type="submit" size="xl" block :loading="submitting" :disabled="!configured" trailing-icon="i-lucide-arrow-right" class="mt-2 justify-center font-semibold">로그인</UButton>
        </UForm>

        <UButton v-if="!configured || sessionError" color="neutral" variant="ghost" block class="mt-3" :loading="checking" icon="i-lucide-refresh-cw" @click="checkConnection">연결 상태 다시 확인</UButton>
        <p class="mt-6 text-center text-xs leading-6 text-slate-400">계정 또는 권한이 필요한 경우 관리자에게 문의해 주세요.</p>
        <div class="mt-10 flex items-start gap-2.5 rounded-lg border border-slate-200/80 bg-slate-50 p-4">
          <UIcon name="i-lucide-info" class="mt-0.5 size-4 shrink-0 text-slate-400" />
          <p class="text-[11px] leading-5 text-slate-500">현재 시범 개발 환경입니다.<br>실제 회사 정보 대신 가상 계정과 데이터를 사용합니다.</p>
        </div>
      </div>
      <p class="mt-12 text-[10px] text-slate-400">Warehouse AI · 원료·자재 재고관리 시스템</p>
    </main>
  </div>
</template>
