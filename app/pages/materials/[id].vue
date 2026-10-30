<script setup lang="ts">
import { qualityLabels, type BatchInput, type LotInput, type Material, type MaterialInput, type MaterialLot, type Paginated, type QualityHistory, type StockBatch } from '#shared/types/inventory'

definePageMeta({ middleware: 'auth' })
const route = useRoute()
const router = useRouter()
function queryPage(value: unknown) { return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 1_000_000 ? Number(value) : 1 }
const materialId = computed(() => String(route.params.id))
const { user, fetchWithSession } = useAuth()
const admin = computed(() => user.value?.role === 'admin')
const { data: material, error: materialError, refresh: refreshMaterial } = await useAsyncData(`material-${materialId.value}`, () => fetchWithSession<Material>(`/api/materials/${materialId.value}`))
useSeoMeta({ title: () => `${material.value?.name ?? '원료 상세'} · Warehouse AI` })
const lotPage = computed(() => queryPage(route.query.lot_page))
const lotQuery = computed(() => typeof route.query.lot_q === 'string' ? route.query.lot_q : '')
const lotSearch = ref(lotQuery.value)
watch(lotQuery, value => { lotSearch.value = value })
const { data: lots, error: lotError, status: lotStatus, refresh: refreshLots } = await useAsyncData(`material-lots-${materialId.value}`, () => fetchWithSession<Paginated<MaterialLot>>(`/api/lots?${new URLSearchParams({ material_id: materialId.value, page: String(lotPage.value), q: lotQuery.value })}`), { watch: [lotPage, lotQuery] })
const selectedLotId = computed(() => lots.value?.items.find(lot => lot.id === route.query.lot_id)?.id ?? lots.value?.items[0]?.id ?? '')
const selectedLot = computed(() => lots.value?.items.find(lot => lot.id === selectedLotId.value) ?? null)
const batchPage = computed(() => queryPage(route.query.batch_page))
const { data: batches, error: batchError, status: batchStatus, refresh: refreshBatches } = await useAsyncData(`material-batches-${materialId.value}`, () => selectedLotId.value ? fetchWithSession<Paginated<StockBatch>>(`/api/batches?${new URLSearchParams({ lot_id: selectedLotId.value, page: String(batchPage.value) })}`) : Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }), { watch: [selectedLotId, batchPage] })
const materialOpen = ref(false)
const lotOpen = ref(false)
const batchOpen = ref(false)
const editingLot = ref<MaterialLot | null>(null)
const editingBatch = ref<StockBatch | null>(null)
const busy = ref(false)
const saveError = ref<string | null>(null)
const notice = ref('')
function editMaterial() { saveError.value = null; materialOpen.value = true }
function editLot(lot: MaterialLot | null) { editingLot.value = lot; saveError.value = null; lotOpen.value = true }
function editBatch(batch: StockBatch | null) { editingBatch.value = batch; saveError.value = null; batchOpen.value = true }
async function saveMaterial(input: MaterialInput) {
  busy.value = true; saveError.value = null
  try { await $fetch<Material>(`/api/materials/${materialId.value}`, { method: 'PATCH', body: input }); materialOpen.value = false; notice.value = '원료 정보를 저장했습니다.'; await refreshMaterial() }
  catch (cause) { saveError.value = inventoryErrorMessage(cause) }
  finally { busy.value = false }
}
async function saveLot(input: LotInput) {
  busy.value = true; saveError.value = null
  try { await $fetch(editingLot.value ? `/api/lots/${editingLot.value.id}` : '/api/lots', { method: editingLot.value ? 'PATCH' : 'POST', body: input }); lotOpen.value = false; notice.value = '제조 LOT를 저장했습니다.'; await refreshLots() }
  catch (cause) { saveError.value = inventoryErrorMessage(cause) }
  finally { busy.value = false }
}
async function saveBatch(input: BatchInput) {
  busy.value = true; saveError.value = null
  try { await $fetch(editingBatch.value ? `/api/batches/${editingBatch.value.id}` : '/api/batches', { method: editingBatch.value ? 'PATCH' : 'POST', body: input }); batchOpen.value = false; notice.value = '입고건 정보를 저장했습니다. 재고 수량은 변경되지 않았습니다.'; await refreshBatches() }
  catch (cause) { saveError.value = inventoryErrorMessage(cause) }
  finally { busy.value = false }
}
async function searchLots() { await router.push({ query: { ...route.query, lot_q: lotSearch.value.trim() || undefined, lot_page: undefined, lot_id: undefined, batch_page: undefined } }) }
async function selectLot(id: string) { await router.push({ query: { ...route.query, lot_id: id, batch_page: undefined } }) }
async function changeLotPage(value: number) { await router.push({ query: { ...route.query, lot_page: value > 1 ? String(value) : undefined, lot_id: undefined, batch_page: undefined } }) }
async function changeBatchPage(value: number) { await router.push({ query: { ...route.query, lot_id: selectedLotId.value, batch_page: value > 1 ? String(value) : undefined } }) }
const historyOpen = ref(false)
const historyBatch = ref<StockBatch | null>(null)
const history = ref<QualityHistory[]>([])
const historyLoading = ref(false)
const historyError = ref<string | null>(null)
async function showHistory(batch: StockBatch) {
  historyBatch.value = batch; history.value = []; historyError.value = null; historyOpen.value = true; historyLoading.value = true
  try { history.value = await fetchWithSession<QualityHistory[]>(`/api/batches/${batch.id}/history`) }
  catch (cause) { historyError.value = inventoryErrorMessage(cause) }
  finally { historyLoading.value = false }
}
</script>

<template>
  <div class="space-y-6">
    <UButton to="/materials" color="neutral" variant="link" icon="i-lucide-arrow-left" class="p-0">원료 목록</UButton>
    <UAlert v-if="materialError" color="error" variant="soft" title="원료 정보를 불러오지 못했습니다" :description="inventoryErrorMessage(materialError)"><template #actions><UButton color="error" variant="outline" @click="refreshMaterial()">다시 시도</UButton></template></UAlert>
    <template v-if="material">
      <div class="flex flex-wrap items-start justify-between gap-4"><div><p class="text-xs font-semibold text-blue-600">{{ material.code }}</p><h1 class="mt-2 text-[27px] font-bold text-slate-900">{{ material.name }}</h1><p class="mt-2 text-xs text-slate-500">{{ material.aliases.join(' · ') || '등록된 별칭 없음' }}</p></div><div class="flex items-center gap-2"><UBadge :color="material.is_active ? 'success' : 'neutral'" variant="subtle">{{ material.is_active ? '사용 중' : '사용 중지' }}</UBadge><UButton v-if="admin" color="neutral" variant="outline" icon="i-lucide-pencil" class="bg-white" @click="editMaterial">원료 수정</UButton></div></div>
      <UAlert v-if="notice" color="success" variant="soft" :title="notice" close @update:open="notice = ''" />
      <dl class="grid grid-cols-2 gap-5 rounded-xl border border-slate-200/80 bg-white p-5 text-xs sm:grid-cols-4"><div><dt class="text-slate-400">규격</dt><dd class="mt-2 font-medium">{{ material.specification || '—' }}</dd></div><div><dt class="text-slate-400">제조사</dt><dd class="mt-2 font-medium">{{ material.manufacturer || '—' }}</dd></div><div><dt class="text-slate-400">기본단위 · 최소재고</dt><dd class="mt-2 font-medium">{{ inventoryQuantity(material.min_stock) }} {{ material.base_unit }}</dd></div><div><dt class="text-slate-400">보관조건</dt><dd class="mt-2 font-medium">{{ material.storage_condition || '—' }}</dd></div><div><dt class="text-slate-400">포장규격</dt><dd class="mt-2 font-medium">{{ material.package_size == null ? '—' : `${inventoryQuantity(material.package_size)} ${material.package_unit}` }}</dd></div><div><dt class="text-slate-400">밀도</dt><dd class="mt-2 font-medium">{{ material.density == null ? '—' : `${inventoryQuantity(material.density)} kg/L` }}</dd></div><div class="col-span-2 flex items-center sm:justify-end"><UButton :to="`/inventory?material_id=${material.id}`" color="primary" variant="soft" icon="i-lucide-boxes">이 원료의 재고 조회</UButton></div></dl>
      <section class="overflow-hidden rounded-xl border border-slate-200/80 bg-white" :aria-busy="lotStatus === 'pending'">
        <div class="flex flex-wrap items-center justify-between gap-3 p-5"><div><h2 class="text-sm font-semibold text-slate-800">제조 LOT</h2><p class="mt-1 text-[11px] text-slate-400">LOT를 선택하면 입고건과 시험정보를 확인할 수 있습니다.</p></div><UButton v-if="admin" icon="i-lucide-plus" size="sm" @click="editLot(null)">LOT 등록</UButton></div>
        <form class="flex gap-2 px-5 pb-4" @submit.prevent="searchLots"><UInput v-model="lotSearch" aria-label="제조번호 검색" placeholder="제조번호 검색" icon="i-lucide-search" class="w-full max-w-sm" /><UButton type="submit" color="neutral" variant="outline">검색</UButton></form>
        <UAlert v-if="lotError" color="error" variant="soft" :title="inventoryErrorMessage(lotError)" class="m-5"><template #actions><UButton color="error" variant="outline" @click="refreshLots()">다시 시도</UButton></template></UAlert>
        <p v-if="lotStatus === 'pending'" role="status" class="px-5 py-3 text-xs text-blue-600">LOT를 불러오는 중입니다…</p>
        <div class="overflow-x-auto"><table class="w-full min-w-[650px] text-left text-xs"><caption class="sr-only">제조 LOT 목록</caption><thead class="border-y border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">제조번호</th><th class="px-4 py-3 font-medium">제조사</th><th class="px-4 py-3 font-medium">제조일</th><th class="px-4 py-3 font-medium">비고</th><th class="px-5 py-3 text-right font-medium">관리</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="lot in lots?.items" :key="lot.id" :class="selectedLotId === lot.id ? 'bg-blue-50/70' : 'hover:bg-slate-50'"><td class="px-5 py-4"><button class="font-semibold text-blue-600 hover:underline" :aria-pressed="selectedLotId === lot.id" @click="selectLot(lot.id)">{{ lot.lot_number }}</button><span v-if="selectedLotId === lot.id" class="ml-2 text-[10px] text-blue-500">선택됨</span></td><td class="px-4 py-4">{{ lot.manufacturer || '—' }}</td><td class="whitespace-nowrap px-4 py-4">{{ inventoryDate(lot.manufactured_on) }}</td><td class="max-w-64 whitespace-pre-wrap break-words px-4 py-4 text-slate-500">{{ lot.notes || '—' }}</td><td class="px-5 py-4 text-right"><UButton v-if="admin" color="neutral" variant="ghost" size="xs" @click="editLot(lot)">수정</UButton><UButton v-else color="neutral" variant="ghost" size="xs" @click="selectLot(lot.id)">입고건 보기</UButton></td></tr><tr v-if="!lots?.items.length && lotStatus !== 'pending'"><td colspan="5" class="px-5 py-12 text-center text-slate-400">등록된 제조 LOT가 없습니다.</td></tr></tbody></table></div>
        <InventoryPagination :total="lots?.total ?? 0" :page="lotPage" :page-size="lots?.pageSize ?? 20" :busy="lotStatus === 'pending'" @change="changeLotPage" />
      </section>
      <section class="overflow-hidden rounded-xl border border-slate-200/80 bg-white" :aria-busy="batchStatus === 'pending'">
        <div class="flex flex-wrap items-center justify-between gap-3 p-5"><div><h2 class="text-sm font-semibold text-slate-800">입고건 · 시험정보 <span v-if="selectedLot" class="ml-2 text-blue-600">{{ selectedLot.lot_number }}</span></h2><p class="mt-1 text-[11px] text-slate-400">동일 LOT의 분할 입고와 재시험 이력을 구분합니다.</p></div><UButton v-if="admin" icon="i-lucide-plus" size="sm" :disabled="!selectedLot" @click="editBatch(null)">입고건 정보 등록</UButton></div>
        <UAlert v-if="batchError" color="error" variant="soft" :title="inventoryErrorMessage(batchError)" class="m-5"><template #actions><UButton color="error" variant="outline" @click="refreshBatches()">다시 시도</UButton></template></UAlert>
        <p v-if="batchStatus === 'pending'" role="status" class="px-5 py-3 text-xs text-blue-600">입고건을 불러오는 중입니다…</p>
        <div class="overflow-x-auto"><table class="w-full min-w-[1000px] text-left text-xs"><caption class="sr-only">선택한 LOT의 입고건</caption><thead class="border-y border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">입고건 / 입고일</th><th class="px-4 py-3 font-medium">시험번호</th><th class="px-4 py-3 font-medium">QC 판정</th><th class="px-4 py-3 font-medium">유효기간</th><th class="px-4 py-3 font-medium">재시험일</th><th class="px-4 py-3 font-medium">판정일</th><th class="px-5 py-3 text-right font-medium">관리</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="batch in batches?.items" :key="batch.id"><td class="px-5 py-4 font-medium">{{ batch.receipt_reference }}<p class="mt-1 font-normal text-slate-400">{{ inventoryDate(batch.received_on) }}</p></td><td class="px-4 py-4">{{ batch.test_number || '—' }}</td><td class="px-4 py-4"><UBadge :color="inventoryStatusColor(batch.quality_status)" variant="subtle" size="sm">{{ qualityLabels[batch.quality_status] }}</UBadge></td><td class="px-4 py-4">{{ inventoryDate(batch.expires_on) }}</td><td class="px-4 py-4">{{ inventoryDate(batch.retest_on) }}</td><td class="px-4 py-4">{{ inventoryDate(batch.decision_on) }}</td><td class="px-5 py-4"><div class="flex justify-end gap-1"><UButton color="neutral" variant="ghost" size="xs" @click="showHistory(batch)">QC 이력</UButton><UButton v-if="admin" color="neutral" variant="ghost" size="xs" @click="editBatch(batch)">수정</UButton></div></td></tr><tr v-if="!batches?.items.length && batchStatus !== 'pending'"><td colspan="7" class="px-5 py-12 text-center text-slate-400">{{ selectedLot ? '이 LOT에 등록된 입고건이 없습니다.' : '제조 LOT를 먼저 등록하거나 선택해 주세요.' }}</td></tr></tbody></table></div>
        <InventoryPagination :total="batches?.total ?? 0" :page="batchPage" :page-size="batches?.pageSize ?? 20" :busy="batchStatus === 'pending'" @change="changeBatchPage" />
        <p class="border-t border-slate-100 px-5 py-3 text-[11px] leading-5 text-slate-400">입고건 등록은 기준정보만 저장하며 재고 수량을 늘리지 않습니다. 실제 입고·불출과 수량 변경은 Phase 3에서 제공합니다.</p>
      </section>
      <template v-if="admin"><InventoryMaterialEditor v-model:open="materialOpen" :material="material" :busy="busy" :error="saveError" @save="saveMaterial" /><InventoryLotEditor v-model:open="lotOpen" :lot="editingLot" :material-id="material.id" :manufacturer="material.manufacturer" :busy="busy" :error="saveError" @save="saveLot" /><InventoryBatchEditor v-model:open="batchOpen" :batch="editingBatch" :lot-id="selectedLotId" :busy="busy" :error="saveError" @save="saveBatch" /></template>
    </template>
    <UModal v-model:open="historyOpen" title="품질 변경 이력" :description="historyBatch?.receipt_reference ?? ''" :ui="{ content: 'sm:max-w-2xl' }"><template #body>
      <p v-if="historyLoading" role="status" class="py-10 text-center text-sm text-slate-400">이력을 불러오는 중입니다…</p>
      <UAlert v-else-if="historyError" color="error" variant="soft" :title="historyError"><template #actions><UButton v-if="historyBatch" color="error" variant="outline" @click="showHistory(historyBatch)">다시 시도</UButton></template></UAlert>
      <div v-else-if="history.length" class="space-y-4"><article v-for="record in history" :key="record.id" class="rounded-lg border border-slate-200 p-4"><div class="flex items-center justify-between gap-3"><UBadge :color="inventoryStatusColor(record.quality_status)" variant="subtle">{{ qualityLabels[record.quality_status] }}</UBadge><time class="text-xs text-slate-400">{{ new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(record.created_at)) }}</time></div><p class="mt-3 whitespace-pre-wrap text-sm text-slate-700">{{ record.reason }}</p><dl class="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500"><div>시험번호: {{ record.test_number || '—' }}</div><div>판정일: {{ inventoryDate(record.decision_on) }}</div><div>유효기간: {{ inventoryDate(record.expires_on) }}</div><div>재시험일: {{ inventoryDate(record.retest_on) }}</div></dl></article></div>
      <p v-else class="py-10 text-center text-sm text-slate-400">등록된 품질 이력이 없습니다.</p>
    </template></UModal>
  </div>
</template>
