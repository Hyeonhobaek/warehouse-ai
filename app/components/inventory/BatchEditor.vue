<script setup lang="ts">
import { qualityLabels, qualityStatuses, type BatchInput, type StockBatch, type QualityStatus } from '#shared/types/inventory'
const props = defineProps<{ batch: StockBatch | null; lotId: string; busy: boolean; error: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ save: [input: BatchInput] }>()
const initial = () => ({ receipt_reference: '', received_on: '', expires_on: '', retest_on: '', test_number: '', quality_status: 'PENDING' as QualityStatus, decision_on: '', quality_reason: '', notes: '' })
const form = reactive(initial())
const qualityItems = qualityStatuses.map(status => ({ value: status, label: qualityLabels[status] }))
watch(open, (value) => {
  if (!value) return
  const row = props.batch
  Object.assign(form, row ? { ...row, expires_on: row.expires_on ?? '', retest_on: row.retest_on ?? '', decision_on: row.decision_on ?? '', quality_reason: '' } : initial())
})
function save() {
  emit('save', { lot_id: props.lotId, receipt_reference: form.receipt_reference.trim(), received_on: form.received_on, expires_on: form.expires_on || null, retest_on: form.retest_on || null, test_number: form.test_number.trim(), quality_status: form.quality_status, decision_on: form.decision_on || null, quality_reason: form.quality_reason.trim(), notes: form.notes.trim() })
}
</script>

<template>
  <UModal v-model:open="open" :title="batch ? '입고건 · 품질정보 수정' : '입고건 정보 등록'" description="입고건은 같은 제조 LOT 안에서도 입고일과 시험정보를 구분하는 기준입니다." :dismissible="!busy" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body><form id="batch-editor" class="grid gap-4 sm:grid-cols-2" @submit.prevent="save">
      <UAlert color="info" variant="soft" title="이 화면에서는 입고건의 기준정보와 품질정보를 관리합니다." description="실제 입고 수량은 입고 관리에서 등록하세요. 이 화면의 저장으로 재고 수량이 증가하지 않습니다." class="sm:col-span-2" />
      <UAlert v-if="error" color="error" variant="soft" :title="error" class="sm:col-span-2" />
      <UFormField label="입고건 식별번호" required><UInput v-model="form.receipt_reference" required maxlength="100" placeholder="예: RC-2026-001" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="입고일" required><UInput v-model="form.received_on" type="date" required min="1900-01-01" max="2199-12-31" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="시험번호"><UInput v-model="form.test_number" maxlength="100" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="품질상태" required><USelect v-model="form.quality_status" :items="qualityItems" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="유효기간"><UInput v-model="form.expires_on" type="date" :min="form.received_on || '1900-01-01'" max="2199-12-31" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="재시험일"><UInput v-model="form.retest_on" type="date" :min="form.received_on || '1900-01-01'" max="2199-12-31" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="판정일"><UInput v-model="form.decision_on" type="date" :min="form.received_on || '1900-01-01'" max="2199-12-31" class="w-full" :disabled="busy" /></UFormField>
      <UFormField :label="batch ? '변경 사유' : '등록 사유'" required><UInput v-model="form.quality_reason" required maxlength="1000" placeholder="품질 판정 또는 정보 변경 근거" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="비고" class="sm:col-span-2"><UTextarea v-model="form.notes" maxlength="2000" class="w-full" :disabled="busy" /></UFormField>
      <p class="text-xs leading-5 text-slate-500 sm:col-span-2">기한 경과는 유효기간으로 계산하며 원래의 품질 판정은 유지합니다. 재시험 결과는 같은 입고건에 저장되어 이력으로 남습니다.</p>
    </form></template>
    <template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :disabled="busy" @click="open = false">취소</UButton><UButton type="submit" form="batch-editor" :loading="busy">저장</UButton></div></template>
  </UModal>
</template>
