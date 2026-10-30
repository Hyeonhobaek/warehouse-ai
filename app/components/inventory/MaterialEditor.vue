<script setup lang="ts">
import { stockUnits, type Material, type MaterialInput, type StockUnit } from '#shared/types/inventory'

const props = defineProps<{ material: Material | null; busy: boolean; error: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ save: [input: MaterialInput] }>()
const initial = () => ({ code: '', name: '', aliases: '', specification: '', manufacturer: '', base_unit: 'kg' as StockUnit, min_stock: '0', storage_condition: '', package_size: '', package_unit: '' as StockUnit | '', density: '', is_active: true })
const form = reactive(initial())
watch(open, (value) => {
  if (!value) return
  const row = props.material
  Object.assign(form, row ? { ...row, aliases: row.aliases.join(', '), min_stock: String(row.min_stock), package_size: row.package_size == null ? '' : String(row.package_size), package_unit: row.package_unit ?? '', density: row.density == null ? '' : String(row.density) } : initial())
})
function save() {
  emit('save', { code: form.code.trim(), name: form.name.trim(), aliases: [...new Set(form.aliases.split(',').map(s => s.trim()).filter(Boolean))], specification: form.specification.trim(), manufacturer: form.manufacturer.trim(), base_unit: form.base_unit, min_stock: Number(form.min_stock), storage_condition: form.storage_condition.trim(), package_size: form.package_size === '' ? null : Number(form.package_size), package_unit: form.package_unit || null, density: form.density === '' ? null : Number(form.density), is_active: form.is_active })
}
</script>

<template>
  <UModal v-model:open="open" :title="material ? '원료 수정' : '원료 등록'" description="원료코드와 기본단위는 재고를 식별하는 기준입니다." :dismissible="!busy" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <form id="material-editor" class="grid gap-4 sm:grid-cols-2" @submit.prevent="save">
        <UAlert v-if="error" color="error" variant="soft" :title="error" class="sm:col-span-2" />
        <UFormField label="원료코드" required><UInput v-model="form.code" required maxlength="50" class="w-full" :disabled="busy" placeholder="예: RM-ACETONE" /></UFormField>
        <UFormField label="원료명" required><UInput v-model="form.name" required maxlength="200" class="w-full" :disabled="busy" /></UFormField>
        <UFormField label="약어 · 별칭" hint="쉼표로 구분" class="sm:col-span-2"><UInput v-model="form.aliases" class="w-full" :disabled="busy" placeholder="예: ACE, 아세톤" /></UFormField>
        <UFormField label="규격"><UInput v-model="form.specification" maxlength="200" class="w-full" :disabled="busy" /></UFormField>
        <UFormField label="제조사"><UInput v-model="form.manufacturer" maxlength="200" class="w-full" :disabled="busy" /></UFormField>
        <UFormField label="기본단위" required><USelect v-model="form.base_unit" :items="[...stockUnits]" class="w-full" :disabled="busy" /></UFormField>
        <UFormField label="최소재고" required><UInput v-model="form.min_stock" type="number" min="0" max="999999999" step="0.000001" required class="w-full" :disabled="busy" /></UFormField>
        <UFormField label="포장당 수량"><UInput v-model="form.package_size" type="number" min="0.000001" max="999999999" step="0.000001" class="w-full" :required="!!form.package_unit" :disabled="busy" /></UFormField>
        <UFormField label="포장단위"><select v-model="form.package_unit" class="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-sm" :required="!!form.package_size" :disabled="busy"><option value="">미지정</option><option v-for="unit in stockUnits" :key="unit" :value="unit">{{ unit }}</option></select></UFormField>
        <UFormField label="밀도 (kg/L)" hint="확인된 환산기준만 입력"><UInput v-model="form.density" type="number" min="0.000001" max="999999999" step="0.000001" class="w-full" :disabled="busy" /></UFormField>
        <UFormField label="보관조건"><UInput v-model="form.storage_condition" maxlength="500" class="w-full" :disabled="busy" placeholder="예: 실온, 밀폐 보관" /></UFormField>
        <UCheckbox v-model="form.is_active" label="사용 중인 원료" :disabled="busy" class="sm:col-span-2" />
      </form>
    </template>
    <template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :disabled="busy" @click="open = false">취소</UButton><UButton type="submit" form="material-editor" :loading="busy">저장</UButton></div></template>
  </UModal>
</template>
