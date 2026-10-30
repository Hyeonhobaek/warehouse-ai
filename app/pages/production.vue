<script setup lang="ts">
import type { Paginated, Warehouse } from '#shared/types/inventory'
import type { BomRecipe, IssuePlanRow, ScheduleResult, ScheduleRow } from '#shared/types/planning'
import type { IssuePreview, TransactionResult } from '#shared/types/transactions'
import { scheduleInputSchema } from '#shared/schemas/planning'

definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: '생산일정 · 예정 불출 · Warehouse AI' })
const { user, fetchWithSession } = useAuth()
const canWrite = computed(() => user.value?.role === 'admin' || user.value?.role === 'operator')
const today = transactionToday()
const { route, filters, page, queryString, apply, reset, setPage } = useInventoryQuery({ q: '', status: '' })
const scheduleStatus = computed({ get: () => filters.status || 'all', set: (value: string) => { filters.status = value === 'all' ? '' : value } })
const { data: schedules, error: schedulesError, status: schedulesStatus, refresh: refreshSchedules } = await useAsyncData('production-schedules', () => fetchWithSession<Paginated<ScheduleRow>>(`/api/production/schedules?${queryString()}`), { watch: [() => route.fullPath] })
const selectedSchedule = ref<ScheduleRow | null>(null)
const planSearch = ref('')
const planStatusFilter = ref('PLANNED')
const planPage = ref(1)
const planQuery = ref(new URLSearchParams({ status: 'PLANNED', page: '1' }).toString())
const { data: plans, error: plansError, status: plansStatus, refresh: refreshPlans } = await useAsyncData('production-plans', () => fetchWithSession<Paginated<IssuePlanRow>>(`/api/production/plans?${planQuery.value}`), { watch: [planQuery] })
function applyPlans(nextPage = 1) {
  planPage.value = nextPage
  const params = new URLSearchParams({ q: planSearch.value.trim(), page: String(nextPage) })
  if (planStatusFilter.value !== 'all') params.set('status', planStatusFilter.value)
  if (selectedSchedule.value) params.set('schedule_id', selectedSchedule.value.id)
  planQuery.value = params.toString()
}
function showPlans(row: ScheduleRow) { selectedSchedule.value = row; planStatusFilter.value = 'all'; applyPlans(); document.getElementById('planned-issues')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
function clearPlans() { selectedSchedule.value = null; planSearch.value = ''; planStatusFilter.value = 'PLANNED'; applyPlans() }
async function refresh() { await Promise.all([refreshSchedules(), refreshPlans()]) }
const notice = ref('')
const editorOpen = ref(false)
const editing = ref<ScheduleRow | null>(null)
const selectedBom = ref<BomRecipe | null>(null)
const loading = ref(false)
const busy = ref(false)
const saveError = ref<string | null>(null)
const form = reactive({ code: '', scheduled_on: today, multiplier: '1', production_batch: '', notes: '', status: 'ACTIVE' as 'ACTIVE' | 'CANCELLED', reason: '' })
let editorRequest = 0
async function edit(row: ScheduleRow | null) {
  const request = ++editorRequest
  editing.value = row; selectedBom.value = null; saveError.value = null; loading.value = !!row
  Object.assign(form, { code: row?.code ?? '', scheduled_on: row?.scheduled_on ?? today, multiplier: String(row?.multiplier ?? 1), production_batch: row?.production_batch ?? '', notes: row?.notes ?? '', status: row?.status ?? 'ACTIVE', reason: '' })
  editorOpen.value = true
  if (!row) return
  try { const bom = await fetchWithSession<BomRecipe>(`/api/boms/${row.bom_id}`); if (request === editorRequest) selectedBom.value = bom }
  catch (cause) { if (request === editorRequest) saveError.value = inventoryErrorMessage(cause) }
  finally { if (request === editorRequest) loading.value = false }
}
async function save() {
  if (!canWrite.value || busy.value || loading.value) return
  const parsed = scheduleInputSchema.safeParse({ id: editing.value?.id ?? null, expected_revision: editing.value?.revision ?? null, bom_id: selectedBom.value?.id, ...form })
  if (!parsed.success) { saveError.value = parsed.error.issues[0]?.message ?? '일정 입력 내용을 확인해 주세요.'; return }
  busy.value = true; saveError.value = null
  try {
    await $fetch<ScheduleResult>('/api/production/schedules', { method: 'POST', body: parsed.data })
    editorOpen.value = false; notice.value = form.status === 'CANCELLED' ? '일정을 취소하고 미출고 예정 내역을 취소했습니다. 이미 출고한 내역은 유지됩니다.' : '생산일정과 미출고 예정 내역을 저장했습니다. 이미 출고한 내역은 유지됩니다.'
    await refresh()
  }
  catch (cause) { saveError.value = inventoryErrorMessage(cause) }
  finally { busy.value = false }
}
const issueOpen = ref(false)
const selectedPlan = ref<IssuePlanRow | null>(null)
const warehouse = ref<Warehouse | null>(null)
const issueForm = reactive({ occurred_on: today, reason: '', notes: '' })
const issueSignature = () => ({ plan: selectedPlan.value?.id, revision: selectedPlan.value?.revision, warehouse: warehouse.value?.id, ...issueForm })
const { busy: issueBusy, error: issueError, result: issueResult, completed, submit, reset: resetIssue } = useTransactionRequest<TransactionResult>(issueSignature)
const preview = ref<IssuePreview | null>(null)
const previewBusy = ref(false)
const previewError = ref<string | null>(null)
let previewRequest = 0
watch(issueSignature, () => { previewRequest++; preview.value = null; previewError.value = null; previewBusy.value = false }, { deep: true, flush: 'sync' })
const issueReady = computed(() => !!selectedPlan.value && selectedPlan.value.status === 'PLANNED' && issueForm.occurred_on >= selectedPlan.value.planned_on && issueForm.occurred_on <= today && !!issueForm.reason.trim())
function openIssue(plan: IssuePlanRow) {
  selectedPlan.value = plan; warehouse.value = null
  Object.assign(issueForm, { occurred_on: today, reason: 'BOM 생산일정에 따른 불출', notes: '' })
  resetIssue(); issueOpen.value = true
  void showPreview()
}
async function showPreview() {
  const plan = selectedPlan.value
  if (!plan) return
  const request = ++previewRequest
  preview.value = null; previewBusy.value = true; previewError.value = null
  try {
    const params = new URLSearchParams({ material_id: plan.material_id, quantity: String(plan.quantity), unit: plan.unit, issue_purpose: plan.issue_purpose, occurred_on: issueForm.occurred_on })
    if (warehouse.value) params.set('warehouse_id', warehouse.value.id)
    const result = await fetchWithSession<IssuePreview>(`/api/transactions/preview?${params}`)
    if (request === previewRequest) preview.value = result
  }
  catch (cause) { if (request === previewRequest) previewError.value = inventoryErrorMessage(cause) }
  finally { if (request === previewRequest) previewBusy.value = false }
}
async function issue() {
  if (!canWrite.value || !issueReady.value || !selectedPlan.value) return
  await submit('/api/production/plans/issue', { plan_id: selectedPlan.value.id, expected_revision: selectedPlan.value.revision, warehouse_id: warehouse.value?.id ?? null, ...issueForm })
  if (completed.value) await refresh()
}
function planLabel(status: IssuePlanRow['status']) { return ({ PLANNED: '불출 예정', ISSUED: '불출 완료', CANCELLED: '취소' } as const)[status] }
function planColor(status: IssuePlanRow['status']) { return ({ PLANNED: 'primary', ISSUED: 'success', CANCELLED: 'neutral' } as const)[status] }
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4"><div><p class="text-[10px] font-semibold tracking-[.18em] text-slate-400">PRODUCTION PLANNING</p><h1 class="mt-2 text-[27px] font-bold text-slate-900">생산일정 · 예정 불출</h1><p class="mt-2 text-xs text-slate-500">웹에서 일정을 등록하고 BOM 기준으로 원료 불출을 준비합니다.</p></div><div class="flex gap-2"><UButton to="/boms" color="neutral" variant="outline" class="bg-white">BOM 관리</UButton><UButton v-if="canWrite" icon="i-lucide-plus" @click="edit(null)">생산일정 등록</UButton></div></div>
    <UAlert color="info" variant="soft" title="일정이 바뀌면 아직 불출하지 않은 예정 내역만 자동 변경됩니다." description="예정 내역은 재고를 차감하거나 예약하지 않습니다. 예정일 이후 ‘실제 불출’로 확정하면 당시 가용재고에서 선입선출합니다. 이미 불출한 내역은 유지되며 정정이 필요하면 반납 또는 수기 추가 불출로 처리하세요." />
    <UAlert v-if="notice" color="success" variant="soft" :title="notice" close @update:open="notice = ''" />
    <p v-if="!canWrite" class="text-xs text-slate-500">현재 계정에서는 일정과 예정 내역을 조회할 수 있습니다. 등록·수정·불출은 입출고 담당자 또는 관리자가 처리합니다.</p>
    <form class="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-5" @submit.prevent="apply"><UFormField label="생산일정 검색" class="min-w-56 flex-1"><UInput v-model="filters.q" placeholder="일정 코드, BOM, 생산 제조번호" icon="i-lucide-search" class="w-full" /></UFormField><UFormField label="일정 상태"><USelect v-model="scheduleStatus" :items="[{ value: 'all', label: '전체' }, { value: 'ACTIVE', label: '진행' }, { value: 'CANCELLED', label: '취소' }]" class="w-28" /></UFormField><UButton type="submit">검색</UButton><UButton color="neutral" variant="ghost" @click="reset">초기화</UButton><UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" aria-label="생산일정과 예정 내역 새로고침" @click="refresh()" /></form>
    <UAlert v-if="schedulesError" color="error" variant="soft" title="생산일정을 불러오지 못했습니다" :description="inventoryErrorMessage(schedulesError)"><template #actions><UButton color="error" variant="outline" @click="refreshSchedules()">다시 시도</UButton></template></UAlert>
    <section class="overflow-hidden rounded-xl border border-slate-200 bg-white" :aria-busy="schedulesStatus === 'pending'">
      <h2 class="p-5 text-sm font-semibold text-slate-800">생산일정</h2><p v-if="schedulesStatus === 'pending'" role="status" class="px-5 pb-3 text-xs text-blue-600">일정을 불러오는 중입니다…</p>
      <div class="overflow-x-auto"><table class="w-full min-w-[1000px] text-left text-xs"><caption class="sr-only">생산일정 목록</caption><thead class="border-y border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">생산 예정일</th><th class="px-4 py-3 font-medium">일정 코드</th><th class="px-4 py-3 font-medium">생산 품목 / 제조번호</th><th class="px-4 py-3 font-medium">BOM</th><th class="px-4 py-3 text-right font-medium">생산 배수</th><th class="px-4 py-3 font-medium">상태</th><th class="px-5 py-3 text-right font-medium">관리</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="row in schedulesError ? [] : schedules?.items" :key="row.id"><td class="px-5 py-4 font-medium">{{ inventoryDate(row.scheduled_on) }}</td><td class="px-4 py-4">{{ row.code }}</td><td class="px-4 py-4">{{ row.product_name }}<p class="mt-1 text-slate-400">{{ row.production_batch }}</p></td><td class="px-4 py-4">{{ row.bom_name }}<p class="mt-1 text-slate-400">{{ row.bom_code }} · 버전 {{ row.bom_revision }}</p></td><td class="px-4 py-4 text-right tabular-nums">× {{ inventoryQuantity(row.multiplier) }}</td><td class="px-4 py-4"><UBadge :color="row.status === 'ACTIVE' ? 'primary' : 'neutral'" variant="subtle">{{ row.status === 'ACTIVE' ? '진행' : '취소' }}</UBadge></td><td class="px-5 py-4"><div class="flex justify-end gap-1"><UButton color="neutral" variant="ghost" size="xs" @click="showPlans(row)">예정 내역</UButton><UButton v-if="canWrite" color="neutral" variant="ghost" size="xs" @click="edit(row)">일정 수정</UButton></div></td></tr><tr v-if="!schedulesError && !schedules?.items.length && schedulesStatus !== 'pending'"><td colspan="7" class="px-5 py-14 text-center text-slate-400">생산일정이 없습니다. BOM을 선택하여 일정을 등록하세요.</td></tr></tbody></table></div>
      <InventoryPagination v-if="!schedulesError" :total="schedules?.total ?? 0" :page="page" :page-size="schedules?.pageSize ?? 20" :busy="schedulesStatus === 'pending'" @change="setPage" />
    </section>

    <section id="planned-issues" class="scroll-mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white" :aria-busy="plansStatus === 'pending'">
      <div class="flex flex-wrap items-center justify-between gap-3 p-5"><div><h2 class="text-sm font-semibold text-slate-800">예정 불출</h2><p class="mt-1 text-[11px] text-slate-400">원료별 사용량을 확인하고 실제 불출을 확정하세요.</p></div><UButton to="/issues" size="sm" color="neutral" variant="outline">수기 추가 불출</UButton></div>
      <form class="grid items-end gap-3 border-y border-slate-100 bg-slate-50/60 p-5 lg:grid-cols-4" @submit.prevent="applyPlans()"><UFormField label="생산일정"><TransactionsLookup v-model="selectedSchedule" endpoint="/api/production/schedules" label="예정 불출의 생산일정" placeholder="전체 생산일정" :option-label="(row: ScheduleRow) => `${row.code} · ${row.product_name}`" :option-detail="(row: ScheduleRow) => `${inventoryDate(row.scheduled_on)} · ${row.production_batch}`" /></UFormField><UFormField label="검색"><UInput v-model="planSearch" placeholder="원료, 일정 코드, 생산 제조번호" class="w-full" /></UFormField><UFormField label="불출 상태"><USelect v-model="planStatusFilter" :items="[{ value: 'all', label: '전체' }, { value: 'PLANNED', label: '불출 예정' }, { value: 'ISSUED', label: '불출 완료' }, { value: 'CANCELLED', label: '취소' }]" class="w-full" /></UFormField><div class="flex gap-2"><UButton type="submit">조회</UButton><UButton color="neutral" variant="ghost" @click="clearPlans">초기화</UButton></div></form>
      <div v-if="plansError" class="p-5"><UAlert color="error" variant="soft" title="예정 불출을 불러오지 못했습니다" :description="inventoryErrorMessage(plansError)"><template #actions><UButton color="error" variant="outline" @click="refreshPlans()">다시 시도</UButton></template></UAlert></div>
      <p v-if="plansStatus === 'pending'" role="status" class="px-5 py-3 text-xs text-blue-600">예정 내역을 불러오는 중입니다…</p>
      <div class="overflow-x-auto"><table class="w-full min-w-[1100px] text-left text-xs"><caption class="sr-only">BOM에서 생성한 원료별 예정 불출 목록</caption><thead class="border-b border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">예정일 / 일정</th><th class="px-4 py-3 font-medium">원료</th><th class="px-4 py-3 font-medium">용도</th><th class="px-4 py-3 text-right font-medium">예정 사용량</th><th class="px-4 py-3 font-medium">생산 품목 / 제조번호</th><th class="px-4 py-3 font-medium">상태</th><th class="px-5 py-3 text-right font-medium">처리</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="row in plansError ? [] : plans?.items" :key="row.id"><td class="px-5 py-4">{{ inventoryDate(row.planned_on) }}<p class="mt-1 text-slate-400">{{ row.schedule_code }}</p></td><td class="px-4 py-4"><NuxtLink :to="`/materials/${row.material_id}`" class="font-medium text-blue-600 hover:underline">{{ row.material_name }}</NuxtLink><p class="mt-1 text-slate-400">{{ row.material_code }}</p></td><td class="px-4 py-4">{{ row.issue_purpose === 'CLEANING' ? '세척 · 18L씩' : '일반 불출' }}</td><td class="px-4 py-4 text-right font-medium tabular-nums">{{ inventoryQuantity(row.quantity) }} {{ row.unit }}<p v-if="row.unit !== row.base_unit" class="mt-1 text-[10px] font-normal text-slate-400">재고 차감 시 {{ row.base_unit }} 환산</p></td><td class="px-4 py-4">{{ row.production_item }}<p class="mt-1 text-slate-400">{{ row.production_batch }}</p></td><td class="px-4 py-4"><UBadge :color="planColor(row.status)" variant="subtle">{{ planLabel(row.status) }}</UBadge></td><td class="px-5 py-4 text-right"><template v-if="row.status === 'PLANNED'"><UButton v-if="canWrite" size="xs" :disabled="row.planned_on > today" @click="openIssue(row)">실제 불출</UButton><p v-if="row.planned_on > today" class="mt-1 text-[10px] text-slate-400">예정일부터 처리 가능</p></template><UButton v-else-if="row.status === 'ISSUED'" :to="`/transactions?material_id=${row.material_id}&q=${encodeURIComponent(row.production_batch)}`" color="neutral" variant="ghost" size="xs">불출 원장</UButton></td></tr><tr v-if="!plansError && !plans?.items.length && plansStatus !== 'pending'"><td colspan="7" class="px-5 py-14 text-center text-slate-400">조건에 맞는 예정 내역이 없습니다.</td></tr></tbody></table></div>
      <InventoryPagination v-if="!plansError" :total="plans?.total ?? 0" :page="planPage" :page-size="plans?.pageSize ?? 20" :busy="plansStatus === 'pending'" @change="applyPlans" />
    </section>

    <UModal v-model:open="editorOpen" :title="editing ? `생산일정 수정 · ${editing.code}` : '생산일정 등록'" description="BOM과 생산 배수를 기준으로 원료별 예정 불출 내역을 생성합니다." :dismissible="!busy" :ui="{ content: 'sm:max-w-2xl' }"><template #body><form id="schedule-editor" class="space-y-5" @submit.prevent="save"><UAlert v-if="saveError" color="error" variant="soft" title="일정을 저장하지 못했습니다" :description="saveError" /><p v-if="loading" role="status" class="text-xs text-blue-600">BOM을 불러오는 중입니다…</p><fieldset :disabled="busy || loading" class="grid gap-4 sm:grid-cols-2"><UFormField label="일정 코드" required><UInput v-model="form.code" required maxlength="80" placeholder="예: SCH-2026-001" class="w-full" /></UFormField><UFormField label="생산 예정일" required><UInput v-model="form.scheduled_on" type="date" required min="1900-01-01" max="2199-12-31" class="w-full" /></UFormField><UFormField label="BOM" required class="sm:col-span-2"><TransactionsLookup v-model="selectedBom" endpoint="/api/boms" label="생산일정 BOM" :option-label="(bom: BomRecipe) => `${bom.code} · ${bom.name}${bom.is_active ? '' : ' (사용 중지)'}`" :option-detail="(bom: BomRecipe) => `${bom.product_name} · ${bom.components.length}개 원료 · 버전 ${bom.revision}`" :option-disabled="(bom: BomRecipe) => !bom.is_active" :disabled="busy || loading" /></UFormField><UFormField label="생산 배수" required><UInput v-model="form.multiplier" required type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" maxlength="16" placeholder="1" class="w-full" /><p class="mt-2 text-[11px] text-slate-500">BOM 1단위 사용량에 곱합니다. 세척 최종 사용량은 18L의 배수여야 합니다.</p></UFormField><UFormField label="생산 제조번호" required><UInput v-model="form.production_batch" required maxlength="100" placeholder="예: CP01126J010" class="w-full" /></UFormField><UFormField label="상태"><USelect v-model="form.status" :items="[{ value: 'ACTIVE', label: '진행' }, { value: 'CANCELLED', label: '일정 취소' }]" class="w-full" /></UFormField><UFormField label="등록 · 변경 사유" required><UInput v-model="form.reason" required maxlength="1000" placeholder="예: 생산일 변경" class="w-full" /></UFormField><UFormField label="비고" class="sm:col-span-2"><UTextarea v-model="form.notes" maxlength="2000" class="w-full" /></UFormField></fieldset><UAlert v-if="editing" color="warning" variant="soft" title="미출고 예정 내역에만 변경을 반영합니다." description="이미 실제 불출한 수량과 이력은 그대로 유지합니다. 사용량을 추가해야 하면 수기 추가 불출을 등록하세요." /></form></template><template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :disabled="busy" @click="editorOpen = false">취소</UButton><UButton type="submit" form="schedule-editor" :loading="busy" :disabled="loading || !selectedBom">일정 저장</UButton></div></template></UModal>

    <UModal v-model:open="issueOpen" title="예정 내역 실제 불출" description="확정하면 현재 가용재고를 선입선출하여 차감합니다." :dismissible="!issueBusy" :ui="{ content: 'sm:max-w-4xl' }"><template #body><div v-if="selectedPlan" class="space-y-5"><div class="rounded-lg bg-slate-50 p-4 text-sm"><p class="font-semibold text-slate-800">{{ selectedPlan.material_code }} · {{ selectedPlan.material_name }}</p><p class="mt-2 text-xs text-slate-500">{{ selectedPlan.schedule_code }} · {{ selectedPlan.production_batch }} · {{ selectedPlan.issue_purpose === 'CLEANING' ? '세척용 18L씩 배정' : '일반 불출' }}</p><p class="mt-2 font-semibold text-blue-700">예정 사용량 {{ inventoryQuantity(selectedPlan.quantity) }} {{ selectedPlan.unit }}</p></div><UAlert v-if="issueError" color="error" variant="soft" title="불출을 완료하지 못했습니다" :description="issueError" /><TransactionsResult v-if="issueResult" :result="issueResult" title="예정 내역의 실제 불출을 완료했습니다" /><form id="planned-issue-editor" @submit.prevent="issue"><fieldset :disabled="issueBusy || completed" class="grid gap-4 sm:grid-cols-2"><UFormField label="실제 불출일" required><UInput v-model="issueForm.occurred_on" required type="date" :min="selectedPlan.planned_on" :max="today" class="w-full" /></UFormField><UFormField label="불출 창고"><TransactionsLookup v-model="warehouse" endpoint="/api/warehouses" label="예정 불출 창고" placeholder="전체 창고에서 선입선출" :option-label="(row: Warehouse) => `${row.code} · ${row.name}${row.is_active ? '' : ' (운영 중지)'}`" :option-disabled="(row: Warehouse) => !row.is_active" :disabled="issueBusy || completed" /></UFormField><UFormField label="불출 사유" required class="sm:col-span-2"><UInput v-model="issueForm.reason" required maxlength="1000" class="w-full" /></UFormField><UFormField label="비고" class="sm:col-span-2"><UTextarea v-model="issueForm.notes" maxlength="2000" class="w-full" /></UFormField></fieldset></form><template v-if="!completed"><div class="flex items-center justify-between gap-3"><p class="text-xs text-slate-500">처리 시점의 재고로 최종 배정하며, 예정 내용이 변경되면 새로 불러와야 합니다.</p><UButton color="neutral" variant="outline" size="sm" :loading="previewBusy" :disabled="issueBusy" @click="showPreview">배정 미리보기</UButton></div><UAlert v-if="previewError" color="error" variant="soft" title="배정 미리보기를 불러오지 못했습니다" :description="previewError" /><div v-if="preview" class="overflow-hidden rounded-lg border border-slate-200"><div class="p-4 text-xs"><p class="font-medium text-slate-800">{{ inventoryQuantity(preview.input_quantity) }} {{ preview.input_unit }} → 재고 차감 {{ inventoryQuantity(preview.quantity) }} {{ preview.base_unit }}</p><p v-if="preview.density_snapshot" class="mt-2 text-slate-500">적용 밀도 {{ inventoryQuantity(preview.density_snapshot) }} kg/L</p><p v-if="preview.shortage > 0" role="status" class="mt-2 text-rose-600">배정 가능한 재고가 {{ inventoryQuantity(preview.shortage) }} {{ preview.base_unit }} 부족합니다. 불출 시 어떤 재고도 차감되지 않습니다.</p></div><div class="overflow-x-auto"><table class="w-full min-w-[550px] text-left text-xs"><caption class="sr-only">예정 불출의 입고건별 예상 배정</caption><thead class="bg-slate-50 text-slate-500"><tr><th class="px-4 py-3 font-medium">시험번호 / LOT</th><th class="px-4 py-3 font-medium">입고일</th><th class="px-4 py-3 font-medium">창고 / 위치</th><th class="px-4 py-3 text-right font-medium">차감량</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="line in preview.lines" :key="`${line.batch_id}-${line.location_id}`"><td class="px-4 py-3">{{ line.test_number || '시험번호 없음' }}<p class="mt-1 text-slate-400">{{ line.lot_number }}</p></td><td class="px-4 py-3">{{ inventoryDate(line.received_on) }}</td><td class="px-4 py-3">{{ line.warehouse_code }} / {{ line.location_code }}</td><td class="px-4 py-3 text-right tabular-nums">{{ inventoryQuantity(line.quantity) }} {{ preview.base_unit }}</td></tr><tr v-if="!preview.lines.length"><td colspan="4" class="px-4 py-6 text-center text-slate-400">배정할 수 있는 재고가 없습니다.</td></tr></tbody></table></div></div></template></div></template><template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :disabled="issueBusy" @click="issueOpen = false">닫기</UButton><UButton v-if="!completed" type="submit" form="planned-issue-editor" :loading="issueBusy" :disabled="!issueReady || (preview !== null && !preview.sufficient)">실제 불출 확정</UButton></div></template></UModal>
  </div>
</template>
