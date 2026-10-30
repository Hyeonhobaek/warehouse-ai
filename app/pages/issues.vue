<script setup lang="ts">
import type { Material, StockUnit, Warehouse } from '#shared/types/inventory'
import type { IssuePreview, TransactionResult } from '#shared/types/transactions'

definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: '불출 관리 · Warehouse AI' })
const { user, fetchWithSession } = useAuth()
const canWrite = computed(() => user.value?.role === 'admin' || user.value?.role === 'operator')
const material = ref<Material | null>(null)
const warehouse = ref<Warehouse | null>(null)
const today = transactionToday()
const form = reactive({ quantity: '', unit: 'kg' as StockUnit, issue_purpose: 'GENERAL' as 'GENERAL' | 'CLEANING', occurred_on: today, production_item: '', production_batch: '', reason: '', notes: '' })
const cleaning = computed(() => form.issue_purpose === 'CLEANING')
watch(material, value => { form.unit = cleaning.value ? 'L' : value?.base_unit ?? 'kg' })
watch(cleaning, value => { form.unit = value ? 'L' : material.value?.base_unit ?? 'kg' })
const cleaningQuantityValid = computed(() => !cleaning.value || (/^\d+(?:\.0{1,6})?$/.test(form.quantity) && Number(form.quantity) > 0 && Number(form.quantity) % 18 === 0))
const cleaningUnitValid = computed(() => !cleaning.value || !material.value || transactionUnits(material.value.base_unit, material.value.density).includes('L'))
const signature = () => ({ ...form, material: material.value?.id, warehouse: warehouse.value?.id })
const { busy, error, result, completed, submit, reset } = useTransactionRequest<TransactionResult>(signature)
const preview = ref<IssuePreview | null>(null)
const previewBusy = ref(false)
const previewError = ref<string | null>(null)
let previewRequest = 0
watch(signature, () => { previewRequest++; preview.value = null; previewError.value = null; previewBusy.value = false }, { deep: true })
const previewReady = computed(() => !!material.value && Number(form.quantity) > 0 && cleaningQuantityValid.value && cleaningUnitValid.value)
const ready = computed(() => previewReady.value && !!form.reason.trim())
async function showPreview() {
  if (!material.value || !previewReady.value) return
  const request = ++previewRequest
  previewBusy.value = true; previewError.value = null; preview.value = null
  try {
    const params = new URLSearchParams({ material_id: material.value.id, quantity: form.quantity, unit: form.unit, issue_purpose: form.issue_purpose, occurred_on: form.occurred_on })
    if (warehouse.value) params.set('warehouse_id', warehouse.value.id)
    const data = await fetchWithSession<IssuePreview>(`/api/transactions/preview?${params}`)
    if (request === previewRequest) preview.value = data
  }
  catch (cause) { if (request === previewRequest) previewError.value = inventoryErrorMessage(cause) }
  finally { if (request === previewRequest) previewBusy.value = false }
}
async function save() {
  if (!canWrite.value || !ready.value) return
  await submit('/api/transactions/issues', { material_id: material.value!.id, warehouse_id: warehouse.value?.id ?? null, ...form })
}
function newEntry() { Object.assign(form, { quantity: '', production_item: '', production_batch: '', reason: '', notes: '' }); reset() }
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4"><div><p class="text-[10px] font-semibold tracking-[.18em] text-slate-400">MATERIAL ISSUE</p><h1 class="mt-2 text-[27px] font-bold text-slate-900">불출 관리</h1><p class="mt-2 text-xs text-slate-500">사용 가능한 재고를 실제 입고일이 빠른 순서로 자동 차감합니다.</p></div><UButton to="/transactions?type=ISSUE" color="neutral" variant="outline" icon="i-lucide-history" class="bg-white">불출 이력</UButton></div>
    <UAlert v-if="!canWrite" color="info" variant="soft" title="불출 처리는 입출고 담당자 또는 관리자가 할 수 있습니다." description="현재 계정에서는 입출고 원장을 조회할 수 있습니다." />
    <template v-else>
      <UAlert color="info" variant="soft" title="같은 제조번호라도 먼저 입고한 사용 가능 재고부터 불출합니다." :description="cleaning ? '세척용은 18L씩 배정합니다. 18L 미만의 잔량은 남겨 두고 다음 입고건에서 이어서 배정합니다. 예: 앞 25L + 다음 100L에서 36L 불출 → 각각 18L 차감, 앞의 7L 유지.' : '한 입고건의 잔량이 부족하면 다음 입고건에서 이어서 차감합니다. 전체 가용재고가 부족하면 어떤 재고도 차감하지 않습니다. 시험대기·부적합·사용보류·반납 검토 중·기한 경과 재고는 제외됩니다.'" />
      <UAlert v-if="error" color="error" variant="soft" title="불출을 완료하지 못했습니다" :description="error" />
      <TransactionsResult v-if="result" :result="result" title="불출을 완료했습니다" />
      <form class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6" @submit.prevent="save">
        <fieldset :disabled="busy || completed" class="grid gap-5 lg:grid-cols-2">
          <UFormField label="불출 용도" required class="lg:col-span-2"><USelect v-model="form.issue_purpose" :items="[{ value: 'GENERAL', label: '일반 불출 · 필요한 수량만큼 배정' }, { value: 'CLEANING', label: '세척 불출 · 18L씩 배정' }]" class="w-full" /></UFormField>
          <UFormField label="불출 원료" required><TransactionsLookup v-model="material" endpoint="/api/materials?active=true" label="불출 원료" :option-label="(row: Material) => `${row.code} · ${row.name}`" :option-detail="(row: Material) => `기본단위 ${row.base_unit}`" :disabled="busy || completed" /></UFormField>
          <UFormField label="불출 창고"><TransactionsLookup v-model="warehouse" endpoint="/api/warehouses" label="불출 창고" placeholder="전체 창고에서 선입선출" :option-label="(row: Warehouse) => `${row.code} · ${row.name}${row.is_active ? '' : ' (운영 중지)'}`" :option-disabled="(row: Warehouse) => !row.is_active" :disabled="busy || completed" /><p class="mt-2 text-[11px] text-slate-500">지정하지 않으면 모든 사용 가능 창고의 재고를 대상으로 합니다.</p></UFormField>
          <UFormField label="불출 수량" required><UInput v-model="form.quantity" type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" maxlength="16" required :placeholder="cleaning ? '예: 18, 36, 54' : '0'" class="w-full" /><p v-if="cleaning" class="mt-2 text-[11px]" :class="form.quantity && !cleaningQuantityValid ? 'text-rose-600' : 'text-slate-500'">18L의 배수로 입력하세요. 18L 미만 잔량을 합쳐 배정하지 않습니다.</p></UFormField>
          <UFormField label="입력 단위" required><USelect v-model="form.unit" :items="cleaning ? ['L'] : transactionUnits(material?.base_unit, material?.density)" :disabled="cleaning" class="w-full" /><p v-if="material" class="mt-2 text-[11px] text-slate-500">재고는 {{ material.base_unit }} 단위로 차감됩니다.<span v-if="material.density"> 질량·부피 변환 시 등록 밀도 {{ material.density }} kg/L를 적용합니다.</span></p><p v-if="!cleaningUnitValid" role="alert" class="mt-2 text-[11px] text-rose-600">이 원료는 L 환산이 불가능합니다. 질량 단위 원료는 관리자가 밀도를 등록해야 합니다.</p></UFormField>
          <UFormField label="불출일" required><UInput v-model="form.occurred_on" type="date" required min="1900-01-01" :max="today" class="w-full" /></UFormField>
          <UFormField label="사용 사유" required><UInput v-model="form.reason" required maxlength="1000" placeholder="예: 세척용 / 생산 투입" class="w-full" /></UFormField>
          <UFormField label="생산 품목"><UInput v-model="form.production_item" maxlength="200" placeholder="예: CP" class="w-full" /></UFormField>
          <UFormField label="생산 제조번호"><UInput v-model="form.production_batch" maxlength="100" placeholder="예: CP01126J010" class="w-full" /></UFormField>
          <UFormField label="비고" class="lg:col-span-2"><UTextarea v-model="form.notes" maxlength="2000" class="w-full" /></UFormField>
        </fieldset>
        <div class="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5"><p class="text-xs text-slate-500">미리보기 이후 재고가 바뀌면 처리 시점의 재고로 다시 배정합니다.</p><UButton v-if="completed" color="neutral" variant="outline" @click="newEntry">새 불출 등록</UButton><div v-else class="flex gap-2"><UButton type="button" color="neutral" variant="outline" :loading="previewBusy" :disabled="!previewReady || busy" @click="showPreview">배정 미리보기</UButton><UButton type="submit" icon="i-lucide-package-minus" :loading="busy" :disabled="!ready">선입선출 불출</UButton></div></div>
      </form>
      <UAlert v-if="previewError" color="error" variant="soft" title="배정 미리보기를 불러오지 못했습니다" :description="previewError" />
      <section v-if="preview && !completed" class="overflow-hidden rounded-xl border border-blue-200 bg-white">
        <div class="p-5"><h2 class="text-sm font-semibold text-slate-800">선입선출 배정 미리보기</h2><p class="mt-2 text-xs text-slate-500">입력 {{ inventoryQuantity(Number(form.quantity)) }} {{ form.unit }} → 재고 차감 {{ inventoryQuantity(preview.quantity) }} {{ preview.base_unit }} · {{ cleaning ? '18L씩 배정 가능한 재고' : '가용재고' }} {{ inventoryQuantity(preview.available) }} {{ preview.base_unit }}</p><p v-if="cleaning" class="mt-2 text-[11px] text-slate-500">입고건별 18L 미만 잔량은 이번 세척 배정에서 제외하고 유지합니다.</p><p v-if="preview.shortage > 0" role="status" class="mt-2 text-xs font-medium text-rose-600">{{ inventoryQuantity(preview.shortage) }} {{ preview.base_unit }} 부족합니다. 이 수량으로는 불출할 수 없습니다.</p></div>
        <div class="overflow-x-auto"><table class="w-full min-w-[650px] text-left text-xs"><caption class="sr-only">입고일 순서의 예상 불출 배정</caption><thead class="border-y border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">시험번호 / LOT</th><th class="px-4 py-3 font-medium">실제 입고일</th><th class="px-4 py-3 font-medium">창고 / 위치</th><th class="px-5 py-3 text-right font-medium">예상 차감</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="line in preview.lines" :key="`${line.batch_id}-${line.location_id}`"><td class="px-5 py-4 font-medium">{{ line.test_number || '시험번호 없음' }}<p class="mt-1 font-normal text-slate-400">{{ line.lot_number }}</p></td><td class="px-4 py-4">{{ inventoryDate(line.received_on) }}</td><td class="px-4 py-4">{{ line.warehouse_code }} / {{ line.location_code }}</td><td class="px-5 py-4 text-right font-semibold tabular-nums text-blue-600">{{ inventoryQuantity(line.quantity) }} {{ preview.base_unit }}</td></tr><tr v-if="!preview.lines.length"><td colspan="4" class="px-5 py-8 text-center text-slate-400">불출 가능한 재고가 없습니다.</td></tr></tbody></table></div>
      </section>
    </template>
  </div>
</template>
