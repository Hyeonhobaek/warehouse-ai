<script setup lang="ts">
import type { Material, MaterialLot, StockUnit, StorageLocation, Warehouse } from '#shared/types/inventory'
import type { TransactionResult } from '#shared/types/transactions'

definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: '입고 관리 · Warehouse AI' })
const { user } = useAuth()
const canWrite = computed(() => user.value?.role === 'admin' || user.value?.role === 'operator')
const material = ref<Material | null>(null)
const lot = ref<MaterialLot | null>(null)
const newLot = ref(false)
const lotForm = reactive({ lot_number: '', manufacturer: '', manufactured_on: '' })
const warehouse = ref<Warehouse | null>(null)
const location = ref<StorageLocation | null>(null)
const today = transactionToday()
const form = reactive({ receipt_reference: '', received_on: today, expires_on: '', retest_on: '', test_number: '', quantity: '', unit: 'kg' as StockUnit, reason: '', notes: '' })
watch(material, value => { lot.value = null; form.unit = value?.base_unit ?? 'kg'; Object.assign(lotForm, { lot_number: '', manufacturer: value?.manufacturer ?? '', manufactured_on: '' }) })
watch(warehouse, () => { location.value = null })
const { busy, error, completed, submit, reset } = useTransactionRequest<TransactionResult>(() => ({ ...form, ...lotForm, newLot: newLot.value, material: material.value?.id, lot: lot.value?.id, location: location.value?.id }))
const ready = computed(() => !!material.value && (newLot.value ? !!lotForm.lot_number.trim() : !!lot.value) && !!location.value && !!form.receipt_reference.trim() && !!form.reason.trim() && Number(form.quantity) > 0)
async function save() {
  if (!canWrite.value || !ready.value) return
  await submit('/api/transactions/receipts', { material_id: material.value!.id, lot_number: newLot.value ? lotForm.lot_number : lot.value!.lot_number, manufacturer: newLot.value ? lotForm.manufacturer : lot.value!.manufacturer, manufactured_on: newLot.value ? lotForm.manufactured_on || null : lot.value!.manufactured_on, location_id: location.value!.id, ...form, expires_on: form.expires_on || null, retest_on: form.retest_on || null })
}
function newEntry() { Object.assign(form, { receipt_reference: '', test_number: '', quantity: '', reason: '', notes: '' }); reset() }
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4"><div><p class="text-[10px] font-semibold tracking-[.18em] text-slate-400">GOODS RECEIPT</p><h1 class="mt-2 text-[27px] font-bold text-slate-900">입고 관리</h1><p class="mt-2 text-xs text-slate-500">실제 입고한 수량과 시험번호를 등록합니다.</p></div><UButton to="/transactions?type=RECEIPT" color="neutral" variant="outline" icon="i-lucide-history" class="bg-white">입고 이력</UButton></div>
    <UAlert v-if="!canWrite" color="info" variant="soft" title="입고 등록은 입출고 담당자 또는 관리자가 할 수 있습니다." description="현재 계정에서는 입출고 원장을 조회할 수 있습니다." />
    <template v-else>
      <UAlert color="info" variant="soft" title="새 입고 재고는 시험대기로 등록됩니다." description="관리자가 품질정보를 확인하여 적합 판정을 등록한 뒤 불출할 수 있습니다. 같은 제조 LOT라도 실제 입고가 다르면 별도의 입고건으로 등록하세요." />
      <UAlert v-if="error" color="error" variant="soft" title="입고를 완료하지 못했습니다" :description="error" />
      <UAlert v-if="completed" color="success" variant="soft" title="입고를 등록했습니다." description="등록한 수량은 현재고에 반영되며, 적합 판정 전까지 가용재고에서는 제외됩니다."><template #actions><UButton color="success" variant="outline" to="/transactions?type=RECEIPT">원장 보기</UButton><UButton color="success" variant="outline" @click="newEntry">새 입고 등록</UButton></template></UAlert>
      <form class="rounded-xl border border-slate-200 bg-white p-5 sm:p-6" @submit.prevent="save">
        <fieldset :disabled="busy || completed" class="grid gap-5 lg:grid-cols-2">
          <div class="lg:col-span-2"><h2 class="text-sm font-semibold text-slate-800">입고 원료와 보관위치</h2><p class="mt-1 text-xs text-slate-500">원료와 제조 LOT를 선택한 후 입고 수량을 입력하세요.</p></div>
          <UFormField label="원료" required><TransactionsLookup v-model="material" endpoint="/api/materials?active=true" label="원료" :option-label="(row: Material) => `${row.code} · ${row.name}`" :option-detail="(row: Material) => `기본단위 ${row.base_unit} · ${row.manufacturer || '제조사 미등록'}`" :disabled="busy || completed" /></UFormField>
          <UFormField label="제조 LOT" required><UCheckbox v-model="newLot" label="새 제조 LOT로 입고" :disabled="busy || completed || !material" class="mb-3" /><UInput v-if="newLot" v-model="lotForm.lot_number" required maxlength="100" placeholder="제조번호를 그대로 입력하세요" class="w-full" /><TransactionsLookup v-else v-model="lot" :endpoint="`/api/lots?material_id=${material?.id ?? ''}`" label="제조 LOT" :option-label="(row: MaterialLot) => row.lot_number" :option-detail="(row: MaterialLot) => `${row.manufacturer || '제조사 미등록'} · 제조일 ${inventoryDate(row.manufactured_on)}`" :disabled="!material || busy || completed" /></UFormField>
          <UFormField v-if="newLot" label="제조사"><UInput v-model="lotForm.manufacturer" maxlength="200" class="w-full" /></UFormField>
          <UFormField v-if="newLot" label="제조일"><UInput v-model="lotForm.manufactured_on" type="date" min="1900-01-01" :max="form.received_on" class="w-full" /></UFormField>
          <UFormField label="창고" required><TransactionsLookup v-model="warehouse" endpoint="/api/warehouses" label="창고" :option-label="(row: Warehouse) => `${row.code} · ${row.name}${row.is_active ? '' : ' (운영 중지)'}`" :option-disabled="(row: Warehouse) => !row.is_active" :disabled="busy || completed" /></UFormField>
          <UFormField label="보관위치" required><TransactionsLookup v-model="location" :endpoint="`/api/locations?warehouse_id=${warehouse?.id ?? ''}`" label="보관위치" :option-label="(row: StorageLocation) => `${row.code} · ${row.name}${row.is_active ? '' : ' (사용 중지)'}`" :option-disabled="(row: StorageLocation) => !row.is_active" :disabled="!warehouse || busy || completed" /></UFormField>
          <div class="border-t border-slate-100 pt-5 lg:col-span-2"><h2 class="text-sm font-semibold text-slate-800">입고 정보</h2></div>
          <UFormField label="입고건 식별번호" required><UInput v-model="form.receipt_reference" required maxlength="100" placeholder="예: RC-2026-001" class="w-full" /></UFormField>
          <UFormField label="실제 입고일" required><UInput v-model="form.received_on" type="date" required min="1900-01-01" :max="today" class="w-full" /></UFormField>
          <UFormField label="입고 수량" required><UInput v-model="form.quantity" type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" maxlength="16" required placeholder="0" class="w-full" /></UFormField>
          <UFormField label="입력 단위" required><USelect v-model="form.unit" :items="transactionUnits(material?.base_unit, material?.density)" class="w-full" /><p v-if="material" class="mt-2 text-[11px] text-slate-500">재고는 {{ material.base_unit }} 단위로 반영됩니다.<span v-if="material.density"> 질량·부피 변환 시 등록 밀도 {{ material.density }} kg/L를 적용합니다.</span></p></UFormField>
          <UFormField label="시험번호"><UInput v-model="form.test_number" maxlength="100" placeholder="예: RP26-0593" class="w-full" /></UFormField>
          <UFormField label="유효기간"><UInput v-model="form.expires_on" type="date" :min="form.received_on" max="2199-12-31" class="w-full" /></UFormField>
          <UFormField label="재시험일"><UInput v-model="form.retest_on" type="date" :min="form.received_on" max="2199-12-31" class="w-full" /></UFormField>
          <UFormField label="입고 사유" required><UInput v-model="form.reason" required maxlength="1000" placeholder="예: 구매 원료 입고" class="w-full" /></UFormField>
          <UFormField label="비고" class="lg:col-span-2"><UTextarea v-model="form.notes" maxlength="2000" class="w-full" /></UFormField>
        </fieldset>
        <div class="mt-6 flex justify-end border-t border-slate-100 pt-5"><UButton type="submit" icon="i-lucide-package-plus" :loading="busy" :disabled="!ready || completed">입고 등록</UButton></div>
      </form>
    </template>
  </div>
</template>
