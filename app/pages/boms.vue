<script setup lang="ts">
import type { Material, Paginated, StockUnit } from '#shared/types/inventory'
import type { BomRecipe } from '#shared/types/planning'
import type { IssuePurpose } from '#shared/types/transactions'
import { bomInputSchema } from '#shared/schemas/planning'

definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: 'BOM 관리 · Warehouse AI' })
const { user, fetchWithSession } = useAuth()
const admin = computed(() => user.value?.role === 'admin')
const { route, filters, page, queryString, apply, reset, setPage } = useInventoryQuery({ q: '' })
const { data, error, status, refresh } = await useAsyncData('bom-list', () => fetchWithSession<Paginated<BomRecipe>>(`/api/boms?${queryString()}`), { watch: [() => route.fullPath] })
type ComponentDraft = { key: number; material: Material | null; quantity: string; unit: StockUnit; issue_purpose: IssuePurpose }
const form = reactive({ code: '', name: '', product_name: '', is_active: true, reason: '' })
const components = ref<ComponentDraft[]>([])
const editing = ref<BomRecipe | null>(null)
const editorOpen = ref(false)
const loading = ref(false)
const loadFailed = ref(false)
const requestedBom = ref<BomRecipe | null>(null)
const busy = ref(false)
const editorError = ref<string | null>(null)
const notice = ref('')
let nextKey = 0
let editorRequest = 0
function addComponent() { components.value.push({ key: ++nextKey, material: null, quantity: '', unit: 'kg', issue_purpose: 'GENERAL' }) }
function changeMaterial(row: ComponentDraft, material: Material | null) { row.material = material; row.unit = row.issue_purpose === 'CLEANING' ? 'L' : material?.base_unit ?? 'kg' }
function changePurpose(row: ComponentDraft, value: IssuePurpose) { row.issue_purpose = value; row.unit = value === 'CLEANING' ? 'L' : row.material?.base_unit ?? 'kg' }
async function edit(row: BomRecipe | null) {
  const request = ++editorRequest
  requestedBom.value = row; loadFailed.value = false
  editing.value = null; editorError.value = null; components.value = []
  Object.assign(form, { code: '', name: '', product_name: '', is_active: true, reason: '' })
  editorOpen.value = true; loading.value = !!row
  if (!row) { addComponent(); return }
  try {
    const current = await fetchWithSession<BomRecipe>(`/api/boms/${row.id}`)
    const materials = new Map(await Promise.all([...new Set(current.components.map(item => item.material_id))].map(async id => [id, await fetchWithSession<Material>(`/api/materials/${id}`)] as const)))
    if (request !== editorRequest) return
    editing.value = current
    Object.assign(form, { code: current.code, name: current.name, product_name: current.product_name, is_active: current.is_active, reason: '' })
    components.value = current.components.map(item => ({ key: ++nextKey, material: materials.get(item.material_id) ?? null, quantity: String(item.quantity), unit: item.unit, issue_purpose: item.issue_purpose }))
  }
  catch (cause) { if (request === editorRequest) { loadFailed.value = true; editorError.value = inventoryErrorMessage(cause) } }
  finally { if (request === editorRequest) loading.value = false }
}
async function save() {
  if (!admin.value || busy.value || loading.value || loadFailed.value) return
  if (components.value.some(row => !row.material)) { editorError.value = '모든 항목의 원료를 선택해 주세요.'; return }
  const parsed = bomInputSchema.safeParse({ id: editing.value?.id ?? null, expected_revision: editing.value?.revision ?? null, ...form, components: components.value.map(row => ({ material_id: row.material?.id, quantity: row.quantity, unit: row.unit, issue_purpose: row.issue_purpose })) })
  if (!parsed.success) { editorError.value = parsed.error.issues[0]?.message ?? 'BOM 입력 내용을 확인해 주세요.'; return }
  busy.value = true; editorError.value = null
  try {
    await $fetch<BomRecipe>('/api/boms', { method: 'POST', body: parsed.data })
    editorOpen.value = false; notice.value = 'BOM을 저장했습니다. 기존 일정에 새 BOM 내용을 반영하려면 해당 생산일정을 다시 저장해 주세요.'
    await refresh()
  }
  catch (cause) { editorError.value = inventoryErrorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4"><div><p class="text-[10px] font-semibold tracking-[.18em] text-slate-400">BILL OF MATERIALS</p><h1 class="mt-2 text-[27px] font-bold text-slate-900">BOM 관리</h1><p class="mt-2 text-xs text-slate-500">생산 1단위에 필요한 원료와 세척용 사용량을 등록합니다.</p></div><div class="flex gap-2"><UButton to="/production" color="neutral" variant="outline" class="bg-white">생산일정 보기</UButton><UButton v-if="admin" icon="i-lucide-plus" @click="edit(null)">BOM 등록</UButton></div></div>
    <UAlert color="info" variant="soft" title="BOM 수량 × 생산 배수로 예정 불출량을 계산합니다." description="BOM 변경 후 기존 생산일정을 다시 저장하면 새 기준으로 미출고 예정 내역을 갱신합니다. 실제 재고는 생산일정 화면에서 불출을 확정할 때 차감됩니다." />
    <UAlert v-if="notice" color="success" variant="soft" :title="notice" close @update:open="notice = ''" />
    <p v-if="!admin" class="text-xs text-slate-500">BOM 등록·수정은 관리자 계정에서 할 수 있습니다.</p>
    <form class="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-5" @submit.prevent="apply"><UFormField label="BOM 검색" class="min-w-56 flex-1"><UInput v-model="filters.q" placeholder="BOM 코드, 이름, 생산 품목" class="w-full" icon="i-lucide-search" /></UFormField><UButton type="submit">검색</UButton><UButton color="neutral" variant="ghost" @click="reset">초기화</UButton></form>
    <UAlert v-if="error" color="error" variant="soft" title="BOM 목록을 불러오지 못했습니다" :description="inventoryErrorMessage(error)"><template #actions><UButton color="error" variant="outline" @click="refresh()">다시 시도</UButton></template></UAlert>
    <section class="overflow-hidden rounded-xl border border-slate-200 bg-white" :aria-busy="status === 'pending'">
      <p v-if="status === 'pending'" role="status" class="px-5 py-3 text-xs text-blue-600">BOM을 불러오는 중입니다…</p>
      <div class="overflow-x-auto"><table class="w-full min-w-[750px] text-left text-xs"><caption class="sr-only">BOM 목록</caption><thead class="border-b border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">BOM 코드 / 이름</th><th class="px-4 py-3 font-medium">생산 품목</th><th class="px-4 py-3 font-medium">원료 항목</th><th class="px-4 py-3 font-medium">버전</th><th class="px-4 py-3 font-medium">사용 상태</th><th class="px-5 py-3 text-right font-medium">관리</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="row in error ? [] : data?.items" :key="row.id"><td class="px-5 py-4 font-medium text-slate-800">{{ row.name }}<p class="mt-1 font-normal text-slate-400">{{ row.code }}</p></td><td class="px-4 py-4">{{ row.product_name }}</td><td class="px-4 py-4">{{ row.components.length }}개</td><td class="px-4 py-4">{{ row.revision }}</td><td class="px-4 py-4"><UBadge :color="row.is_active ? 'success' : 'neutral'" variant="subtle">{{ row.is_active ? '사용 중' : '사용 중지' }}</UBadge></td><td class="px-5 py-4 text-right"><UButton color="neutral" variant="ghost" size="xs" @click="edit(row)">{{ admin ? '상세 · 수정' : '상세' }}</UButton></td></tr><tr v-if="!error && !data?.items.length && status !== 'pending'"><td colspan="6" class="px-5 py-14 text-center text-slate-400">등록된 BOM이 없습니다. 관리자가 BOM을 등록하면 생산일정에 사용할 수 있습니다.</td></tr></tbody></table></div>
      <InventoryPagination v-if="!error" :total="data?.total ?? 0" :page="page" :page-size="data?.pageSize ?? 20" :busy="status === 'pending'" @change="setPage" />
    </section>
    <UModal v-model:open="editorOpen" :title="editing ? `BOM ${admin ? '수정' : '상세'} · ${editing.code}` : 'BOM 등록'" description="생산 1단위를 기준으로 원료별 사용량을 입력합니다." :dismissible="!busy" :ui="{ content: 'sm:max-w-4xl' }">
      <template #body>
        <p v-if="loading" role="status" class="py-10 text-center text-sm text-slate-400">BOM 상세를 불러오는 중입니다…</p>
        <UAlert v-else-if="loadFailed" color="error" variant="soft" title="BOM 상세를 불러오지 못했습니다" :description="editorError ?? undefined"><template #actions><UButton color="error" variant="outline" @click="edit(requestedBom)">다시 시도</UButton></template></UAlert>
        <form v-else id="bom-editor" class="space-y-5" @submit.prevent="save">
          <UAlert v-if="editorError" color="error" variant="soft" title="BOM 내용을 확인해 주세요" :description="editorError" />
          <fieldset :disabled="busy || !admin" class="grid gap-4 sm:grid-cols-2">
            <UFormField label="BOM 코드" required><UInput v-model="form.code" required maxlength="80" placeholder="예: BOM-CP" class="w-full" /></UFormField><UFormField label="BOM 이름" required><UInput v-model="form.name" required maxlength="200" placeholder="예: CP 생산 및 세척" class="w-full" /></UFormField><UFormField label="생산 품목" required><UInput v-model="form.product_name" required maxlength="200" placeholder="예: CP" class="w-full" /></UFormField><UFormField label="사용 상태"><UCheckbox v-model="form.is_active" label="사용 중" class="py-2" /></UFormField>
          </fieldset>
          <div class="flex items-center justify-between border-t border-slate-100 pt-5"><h3 class="text-sm font-semibold text-slate-800">생산 1단위당 사용 원료</h3><UButton v-if="admin" type="button" size="xs" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="busy || components.length >= 100" @click="addComponent">원료 추가</UButton></div>
          <div v-for="(row, index) in components" :key="row.key" class="rounded-lg border border-slate-200 p-4">
            <div class="mb-3 flex items-center justify-between"><p class="text-xs font-medium text-slate-500">항목 {{ index + 1 }}</p><UButton v-if="admin" type="button" color="error" variant="ghost" size="xs" :disabled="busy || components.length <= 1" :aria-label="`항목 ${index + 1} 삭제`" @click="components.splice(index, 1)">삭제</UButton></div>
            <fieldset :disabled="busy || !admin" class="grid gap-3 sm:grid-cols-2"><UFormField label="원료" required class="sm:col-span-2"><TransactionsLookup :model-value="row.material" endpoint="/api/materials?active=true" :label="`항목 ${index + 1} 원료`" :option-label="(material: Material) => `${material.code} · ${material.name}`" :option-detail="(material: Material) => `재고 단위 ${material.base_unit}${material.density ? ` · 밀도 ${material.density} kg/L` : ''}`" :disabled="busy || !admin" @update:model-value="changeMaterial(row, $event)" /></UFormField><UFormField label="용도" required><USelect :model-value="row.issue_purpose" :items="[{ value: 'GENERAL', label: '일반 불출' }, { value: 'CLEANING', label: '세척 · 18L씩 배정' }]" class="w-full" @update:model-value="changePurpose(row, $event as IssuePurpose)" /></UFormField><UFormField label="1단위당 수량" required><UInput v-model="row.quantity" required type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" maxlength="16" :placeholder="row.issue_purpose === 'CLEANING' ? '18의 배수' : '0'" class="w-full" /></UFormField><UFormField label="사용량 입력 단위" required><USelect v-model="row.unit" :items="row.issue_purpose === 'CLEANING' ? ['L'] : transactionUnits(row.material?.base_unit, row.material?.density)" :disabled="row.issue_purpose === 'CLEANING' || busy || !admin" class="w-full" /></UFormField></fieldset>
            <p v-if="row.issue_purpose === 'CLEANING'" class="mt-3 text-[11px] text-slate-500">세척 사용량은 L로 입력합니다. 일정의 생산 배수를 곱한 최종 수량도 18L의 배수여야 합니다. 재고는 등록 밀도로 환산하여 차감합니다.</p>
          </div>
          <UFormField v-if="admin" label="등록 · 변경 사유" required><UInput v-model="form.reason" required :disabled="busy" maxlength="1000" placeholder="예: 신규 제품 생산 기준 등록" class="w-full" /></UFormField>
        </form>
      </template>
      <template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :disabled="busy" @click="editorOpen = false">닫기</UButton><UButton v-if="admin" type="submit" form="bom-editor" :loading="busy" :disabled="loading || loadFailed || !components.length">BOM 저장</UButton></div></template>
    </UModal>
  </div>
</template>
