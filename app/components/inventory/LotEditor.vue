<script setup lang="ts">
import type { LotInput, MaterialLot } from '#shared/types/inventory'
const props = defineProps<{ lot: MaterialLot | null; materialId: string; manufacturer: string; busy: boolean; error: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ save: [input: LotInput] }>()
const form = reactive({ lot_number: '', manufacturer: '', manufactured_on: '', notes: '' })
watch(open, (value) => {
  if (value) Object.assign(form, props.lot ? { ...props.lot, manufactured_on: props.lot.manufactured_on ?? '' } : { lot_number: '', manufacturer: props.manufacturer, manufactured_on: '', notes: '' })
})
function save() { emit('save', { material_id: props.materialId, lot_number: form.lot_number.trim(), manufacturer: form.manufacturer.trim(), manufactured_on: form.manufactured_on || null, notes: form.notes.trim() }) }
</script>

<template>
  <UModal v-model:open="open" :title="lot ? '제조 LOT 수정' : '제조 LOT 등록'" description="제조번호는 원료 내에서 중복될 수 없습니다. 앞자리 0을 포함해 그대로 입력해 주세요." :dismissible="!busy">
    <template #body><form id="lot-editor" class="space-y-4" @submit.prevent="save">
      <UAlert v-if="error" color="error" variant="soft" :title="error" />
      <UFormField label="제조번호 (LOT)" required><UInput v-model="form.lot_number" required maxlength="100" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="제조사"><UInput v-model="form.manufacturer" maxlength="200" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="제조일"><UInput v-model="form.manufactured_on" type="date" min="1900-01-01" max="2199-12-31" class="w-full" :disabled="busy" /></UFormField>
      <UFormField label="비고"><UTextarea v-model="form.notes" maxlength="2000" class="w-full" :disabled="busy" /></UFormField>
    </form></template>
    <template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :disabled="busy" @click="open = false">취소</UButton><UButton type="submit" form="lot-editor" :loading="busy">저장</UButton></div></template>
  </UModal>
</template>
