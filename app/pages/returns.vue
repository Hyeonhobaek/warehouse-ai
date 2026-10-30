<script setup lang="ts">
import type { Paginated, StorageLocation, Warehouse } from '#shared/types/inventory'
import type { StockLedgerRow, TransactionResult } from '#shared/types/transactions'

definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: '반납 관리 · Warehouse AI' })
const { user, fetchWithSession } = useAuth()
const canWrite = computed(() => user.value?.role === 'admin' || user.value?.role === 'operator')
const admin = computed(() => user.value?.role === 'admin')
const today = transactionToday()
const original = ref<StockLedgerRow | null>(null)
const warehouse = ref<Warehouse | null>(null)
const location = ref<StorageLocation | null>(null)
const form = reactive({ quantity: '', occurred_on: today, reason: '', notes: '' })
watch(warehouse, () => { location.value = null })
watch(original, () => { form.quantity = '' })
const { busy, error, result, completed, submit, reset } = useTransactionRequest<TransactionResult>(() => ({ ...form, line: original.value?.id, location: location.value?.id }))
const ready = computed(() => !!original.value && !!location.value && Number(form.quantity) > 0 && Number(form.quantity) <= original.value.returnable_quantity && !!form.reason.trim())
const { route, filters, page, queryString, apply, reset: resetQuery, setPage } = useInventoryQuery({ q: '' })
const { data: pending, status: pendingStatus, error: pendingError, refresh: refreshPending } = await useAsyncData('pending-returns', () => fetchWithSession<Paginated<StockLedgerRow>>(`/api/transactions/returns?${queryString()}`), { watch: [() => route.fullPath] })
async function save() {
  if (!canWrite.value || !ready.value) return
  await submit('/api/transactions/returns', { ...form, issue_line_id: original.value!.id, location_id: location.value!.id, unit: original.value!.base_unit })
  if (completed.value) await refreshPending()
}
function newEntry() { original.value = null; Object.assign(form, { quantity: '', reason: '', notes: '' }); reset() }
const releaseOpen = ref(false)
const releasing = ref<StockLedgerRow | null>(null)
const releaseForm = reactive({ quantity: '', occurred_on: today, reason: '', notes: '' })
const releaseRequest = useTransactionRequest<TransactionResult>(() => ({ ...releaseForm, line: releasing.value?.id }))
const { busy: releaseBusy, error: releaseError, result: releaseResult, completed: releaseCompleted } = releaseRequest
function startRelease(row: StockLedgerRow) {
  // Closing an uncertain request is not a new operation. Reopening keeps its payload and retry key.
  if (releasing.value?.id === row.id && !releaseCompleted.value) {
    releasing.value = row
    releaseOpen.value = true
    return
  }
  releasing.value = row
  Object.assign(releaseForm, { quantity: String(row.releasable_quantity), occurred_on: today, reason: '', notes: '' })
  releaseRequest.reset(); releaseOpen.value = true
}
async function release() {
  if (!admin.value || !releasing.value || !releaseForm.reason.trim() || Number(releaseForm.quantity) <= 0 || Number(releaseForm.quantity) > releasing.value.releasable_quantity) return
  await releaseRequest.submit('/api/transactions/returns/release', { ...releaseForm, return_line_id: releasing.value.id, unit: releasing.value.base_unit })
  if (releaseCompleted.value) { releaseOpen.value = false; await refreshPending() }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4"><div><p class="text-[10px] font-semibold tracking-[.18em] text-slate-400">MATERIAL RETURN</p><h1 class="mt-2 text-[27px] font-bold text-slate-900">반납 관리</h1><p class="mt-2 text-xs text-slate-500">불출 내역에 연결하여 남은 원료를 반납하고, 상태 확인 후 사용을 승인합니다.</p></div><UButton to="/transactions?type=RETURN" color="neutral" variant="outline" icon="i-lucide-history" class="bg-white">반납 이력</UButton></div>
    <UAlert color="info" variant="soft" title="반납 재고는 확인 전까지 사용할 수 없습니다." description="원래 불출한 수량 중 아직 반납하지 않은 수량만 등록할 수 있습니다. 관리자가 보류를 해제하고 해당 입고건이 적합·기한 내 상태여야 불출할 수 있습니다." />
    <UAlert v-if="!canWrite" color="info" variant="soft" title="반납 등록은 입출고 담당자 또는 관리자가 할 수 있습니다." description="현재 계정에서는 반납 검토 목록과 원장을 조회할 수 있습니다." />
    <UAlert v-if="error" color="error" variant="soft" title="반납을 완료하지 못했습니다" :description="error" />
    <TransactionsResult v-if="result" :result="result" title="반납을 등록했습니다 · 사용 보류 중" />
    <TransactionsResult v-if="releaseResult" :result="releaseResult" title="반납 재고의 보류를 해제했습니다" />
    <form v-if="canWrite" class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6" @submit.prevent="save">
      <fieldset :disabled="busy || completed" class="grid gap-5 lg:grid-cols-2">
        <UFormField label="원래 불출 내역" required class="lg:col-span-2"><TransactionsLookup v-model="original" endpoint="/api/transactions/returnable" label="원래 불출 내역" :option-label="(row: StockLedgerRow) => `${row.material_code} · ${row.material_name} / ${row.test_number_snapshot || '시험번호 없음'}`" :option-detail="(row: StockLedgerRow) => `${inventoryDate(row.occurred_on)} · LOT ${row.lot_number_snapshot} · ${row.production_batch || row.reason} · 반납 가능 ${inventoryQuantity(row.returnable_quantity)} ${row.base_unit}`" :disabled="busy || completed" /></UFormField>
        <div v-if="original" class="rounded-lg bg-blue-50 p-4 text-xs leading-6 text-blue-900 lg:col-span-2"><p>원래 불출: {{ inventoryQuantity(original.quantity) }} {{ original.base_unit }} · {{ completed ? "이번 등록 전 반납 가능 수량" : "아직 반납 가능한 수량" }}: <strong>{{ inventoryQuantity(original.returnable_quantity) }} {{ original.base_unit }}</strong></p><p>시험번호 {{ original.test_number_snapshot || '없음' }} · LOT {{ original.lot_number_snapshot }} · 불출일 {{ inventoryDate(original.occurred_on) }}</p></div>
        <UFormField label="반납 창고" required><TransactionsLookup v-model="warehouse" endpoint="/api/warehouses" label="반납 창고" :option-label="(row: Warehouse) => `${row.code} · ${row.name}${row.is_active ? '' : ' (운영 중지)'}`" :option-disabled="(row: Warehouse) => !row.is_active" :disabled="busy || completed" /></UFormField>
        <UFormField label="반납 보관위치" required><TransactionsLookup v-model="location" :endpoint="`/api/locations?warehouse_id=${warehouse?.id ?? ''}`" label="반납 보관위치" :option-label="(row: StorageLocation) => `${row.code} · ${row.name}${row.is_active ? '' : ' (사용 중지)'}`" :option-disabled="(row: StorageLocation) => !row.is_active" :disabled="!warehouse || busy || completed" /></UFormField>
        <UFormField :label="`반납 수량${original ? ` (${original.base_unit})` : ''}`" required><UInput v-model="form.quantity" type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" maxlength="16" required placeholder="0" class="w-full" /><p class="mt-2 text-[11px] text-slate-500">반납 수량은 원료의 기본단위로 입력합니다.</p></UFormField>
        <UFormField label="반납일" required><UInput v-model="form.occurred_on" type="date" required :min="original?.occurred_on || '1900-01-01'" :max="today" class="w-full" /></UFormField>
        <UFormField label="반납 사유" required class="lg:col-span-2"><UInput v-model="form.reason" required maxlength="1000" placeholder="미사용 수량과 반납 상태를 적어 주세요" class="w-full" /></UFormField>
        <UFormField label="비고" class="lg:col-span-2"><UTextarea v-model="form.notes" maxlength="2000" class="w-full" /></UFormField>
      </fieldset>
      <div class="mt-6 flex justify-end border-t border-slate-100 pt-5"><UButton v-if="completed" color="neutral" variant="outline" @click="newEntry">새 반납 등록</UButton><UButton v-else type="submit" icon="i-lucide-undo-2" :loading="busy" :disabled="!ready">반납 등록</UButton></div>
    </form>
    <section class="overflow-hidden rounded-xl border border-slate-200 bg-white" :aria-busy="pendingStatus === 'pending'">
      <div class="flex flex-wrap items-start justify-between gap-3 p-5"><div><h2 class="text-sm font-semibold text-slate-800">사용 승인 대기</h2><p class="mt-1 text-xs text-slate-500">{{ admin ? '반납 원료의 상태를 확인한 뒤 보류를 해제하세요.' : '관리자가 검토할 반납 재고입니다.' }}</p></div><UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="pendingStatus === 'pending'" @click="refreshPending()">새로고침</UButton></div>
      <form class="flex flex-wrap gap-2 px-5 pb-4" @submit.prevent="apply"><UInput v-model="filters.q" aria-label="반납 검토 목록 검색" placeholder="원료, 시험번호, 제조번호 검색" class="w-full max-w-md" icon="i-lucide-search" /><UButton type="submit">검색</UButton><UButton color="neutral" variant="ghost" @click="resetQuery">초기화</UButton></form>
      <UAlert v-if="pendingError" color="error" variant="soft" :title="inventoryErrorMessage(pendingError)" class="m-5" />
      <p v-if="pendingStatus === 'pending'" role="status" class="px-5 pb-4 text-xs text-blue-600">반납 검토 목록을 불러오는 중입니다…</p>
      <div class="overflow-x-auto"><table class="w-full min-w-[850px] text-left text-xs"><caption class="sr-only">보류 해제가 필요한 반납 내역</caption><thead class="border-y border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">반납일 / 담당자</th><th class="px-4 py-3 font-medium">원료 / 시험번호</th><th class="px-4 py-3 font-medium">창고 / 위치</th><th class="px-4 py-3 font-medium">반납 사유</th><th class="px-4 py-3 text-right font-medium">승인 대기 수량</th><th class="px-5 py-3 text-right font-medium">관리</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="row in pendingError ? [] : pending?.items" :key="row.id"><td class="px-5 py-4">{{ inventoryDate(row.occurred_on) }}<p class="mt-1 text-slate-400">{{ row.actor_name }}</p></td><td class="px-4 py-4 font-medium">{{ row.material_name }}<p class="mt-1 font-normal text-slate-400">{{ row.test_number_snapshot || '시험번호 없음' }} · {{ row.lot_number_snapshot }}</p></td><td class="px-4 py-4">{{ row.warehouse_code_snapshot }} / {{ row.location_code_snapshot }}</td><td class="max-w-64 whitespace-pre-wrap break-words px-4 py-4 text-slate-500">{{ row.reason }}</td><td class="px-4 py-4 text-right font-semibold tabular-nums text-amber-700">{{ inventoryQuantity(row.releasable_quantity) }} {{ row.base_unit }}</td><td class="px-5 py-4 text-right"><UButton v-if="admin" size="xs" color="neutral" variant="outline" @click="startRelease(row)">보류 해제</UButton><span v-else class="text-slate-400">관리자 검토 중</span></td></tr><tr v-if="pendingError"><td colspan="6" class="px-5 py-12 text-center text-rose-600">반납 검토 목록을 확인하지 못했습니다. 새로고침해 주세요.</td></tr><tr v-if="!pendingError && !pending?.items.length && pendingStatus !== 'pending'"><td colspan="6" class="px-5 py-12 text-center text-slate-400">승인 대기 중인 반납 내역이 없습니다.</td></tr></tbody></table></div>
      <InventoryPagination v-if="!pendingError" :total="pending?.total ?? 0" :page="page" :page-size="pending?.pageSize ?? 20" :busy="pendingStatus === 'pending'" @change="setPage" />
    </section>
    <UModal v-model:open="releaseOpen" title="반납 재고 보류 해제" description="반납 원료의 상태를 확인하고 승인 수량과 근거를 입력하세요." :dismissible="!releaseBusy"><template #body><form id="return-release" class="space-y-4" @submit.prevent="release">
      <UAlert v-if="releaseError" color="error" variant="soft" :title="releaseError" />
      <p class="text-sm font-medium text-slate-700">{{ releasing?.material_name }} · {{ releasing?.test_number_snapshot || '시험번호 없음' }}</p>
      <UFormField :label="`해제 수량 (${releasing?.base_unit ?? ''})`" required><UInput v-model="releaseForm.quantity" type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" maxlength="16" required :disabled="releaseBusy" class="w-full" /></UFormField>
      <UFormField label="확인일" required><UInput v-model="releaseForm.occurred_on" type="date" :min="releasing?.occurred_on || '1900-01-01'" :max="today" required :disabled="releaseBusy" class="w-full" /></UFormField>
      <UFormField label="확인 근거" required><UTextarea v-model="releaseForm.reason" required maxlength="1000" placeholder="예: 포장과 원료 상태 확인 완료" :disabled="releaseBusy" class="w-full" /></UFormField>
      <p class="text-xs leading-5 text-slate-500">보류 해제 후에도 품질상태와 유효기간에 따라 불출 가능 여부가 결정됩니다.</p>
    </form></template><template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :disabled="releaseBusy" @click="releaseOpen = false">취소</UButton><UButton type="submit" form="return-release" :loading="releaseBusy" :disabled="!releaseForm.reason.trim()">보류 해제</UButton></div></template></UModal>
  </div>
</template>
