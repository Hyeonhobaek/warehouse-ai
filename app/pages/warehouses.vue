<script setup lang="ts">
import type { LocationInput, Paginated, StorageLocation, Warehouse, WarehouseInput } from '#shared/types/inventory'

definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: '창고 · 보관위치 · Warehouse AI' })
const { user, fetchWithSession } = useAuth()
const admin = computed(() => user.value?.role === 'admin')
const route = useRoute()
const router = useRouter()
function queryPage(value: unknown) { return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 1_000_000 ? Number(value) : 1 }
const warehousePage = computed(() => queryPage(route.query.warehouse_page))
const { data: warehouses, error: warehouseError, status: warehouseStatus, refresh: refreshWarehouses } = await useAsyncData('warehouse-list', () => fetchWithSession<Paginated<Warehouse>>(`/api/warehouses?page=${warehousePage.value}`), { watch: [warehousePage] })
const selectedWarehouseId = computed(() => warehouses.value?.items.find(row => row.id === route.query.warehouse_id)?.id ?? warehouses.value?.items[0]?.id ?? '')
const selectedWarehouse = computed(() => warehouses.value?.items.find(row => row.id === selectedWarehouseId.value) ?? null)
const locationPage = computed(() => queryPage(route.query.location_page))
const { data: locations, error: locationError, status: locationStatus, refresh: refreshLocations } = await useAsyncData('location-list', () => selectedWarehouseId.value ? fetchWithSession<Paginated<StorageLocation>>(`/api/locations?warehouse_id=${selectedWarehouseId.value}&page=${locationPage.value}`) : Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }), { watch: [selectedWarehouseId, locationPage] })
async function selectWarehouse(id: string) { await router.push({ query: { ...route.query, warehouse_id: id, location_page: undefined } }) }
async function changeWarehousePage(value: number) { await router.push({ query: { ...route.query, warehouse_page: value > 1 ? String(value) : undefined, warehouse_id: undefined, location_page: undefined } }) }
async function changeLocationPage(value: number) { await router.push({ query: { ...route.query, warehouse_id: selectedWarehouseId.value, location_page: value > 1 ? String(value) : undefined } }) }
const open = ref(false)
const kind = ref<'warehouse' | 'location'>('warehouse')
const editing = ref<Warehouse | StorageLocation | null>(null)
const form = reactive({ code: '', name: '', is_active: true })
const busy = ref(false)
const saveError = ref<string | null>(null)
const notice = ref('')
function edit(type: 'warehouse' | 'location', row: Warehouse | StorageLocation | null) {
  kind.value = type; editing.value = row; saveError.value = null
  Object.assign(form, row ? { code: row.code, name: row.name, is_active: row.is_active } : { code: '', name: '', is_active: true })
  open.value = true
}
async function save() {
  busy.value = true; saveError.value = null
  const input: WarehouseInput | LocationInput = { code: form.code.trim(), name: form.name.trim(), is_active: form.is_active, ...(kind.value === 'location' ? { warehouse_id: selectedWarehouseId.value } : {}) }
  const endpoint = kind.value === 'warehouse' ? '/api/warehouses' : '/api/locations'
  try {
    await $fetch(editing.value ? `${endpoint}/${editing.value.id}` : endpoint, { method: editing.value ? 'PATCH' : 'POST', body: input })
    open.value = false; notice.value = `${kind.value === 'warehouse' ? '창고' : '보관위치'} 정보를 저장했습니다.`
    if (kind.value === 'warehouse') await refreshWarehouses()
    else await refreshLocations()
  }
  catch (cause) { saveError.value = inventoryErrorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4"><div><p class="text-[10px] font-semibold tracking-[.18em] text-slate-400">STORAGE MASTER</p><h1 class="mt-2 text-[27px] font-bold text-slate-900">창고 · 보관위치</h1><p class="mt-2 text-xs text-slate-500">창고를 선택해 선반과 구역 등 세부 보관위치를 관리합니다.</p></div><UButton v-if="admin" icon="i-lucide-plus" @click="edit('warehouse', null)">창고 등록</UButton></div>
    <UAlert v-if="notice" color="success" variant="soft" :title="notice" close @update:open="notice = ''" />
    <div class="grid items-start gap-6 xl:grid-cols-2">
      <section class="overflow-hidden rounded-xl border border-slate-200/80 bg-white" :aria-busy="warehouseStatus === 'pending'">
        <div class="flex items-center gap-2 p-5"><UIcon name="i-lucide-warehouse" class="size-4 text-blue-500" /><h2 class="text-sm font-semibold text-slate-800">창고 목록</h2></div>
        <UAlert v-if="warehouseError" color="error" variant="soft" :title="inventoryErrorMessage(warehouseError)" class="m-5"><template #actions><UButton color="error" variant="outline" @click="refreshWarehouses()">다시 시도</UButton></template></UAlert>
        <p v-if="warehouseStatus === 'pending'" role="status" class="px-5 py-3 text-xs text-blue-600">창고를 불러오는 중입니다…</p>
        <div class="overflow-x-auto"><table class="w-full min-w-[430px] text-left text-xs"><caption class="sr-only">창고 목록</caption><thead class="border-y border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">코드 / 창고명</th><th class="px-4 py-3 font-medium">사용상태</th><th class="px-5 py-3 text-right font-medium">관리</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="warehouse in warehouses?.items" :key="warehouse.id" :class="selectedWarehouseId === warehouse.id ? 'bg-blue-50/70' : 'hover:bg-slate-50'"><td class="px-5 py-4"><button class="font-semibold text-blue-600 hover:underline" :aria-pressed="selectedWarehouseId === warehouse.id" @click="selectWarehouse(warehouse.id)">{{ warehouse.name }}</button><p class="mt-1 text-slate-400">{{ warehouse.code }}<span v-if="selectedWarehouseId === warehouse.id" class="ml-2 text-blue-500">선택됨</span></p></td><td class="px-4 py-4"><UBadge :color="warehouse.is_active ? 'success' : 'neutral'" variant="subtle" size="sm">{{ warehouse.is_active ? '사용 중' : '사용 중지' }}</UBadge></td><td class="px-5 py-4 text-right"><UButton v-if="admin" color="neutral" variant="ghost" size="xs" @click="edit('warehouse', warehouse)">수정</UButton><UButton v-else color="neutral" variant="ghost" size="xs" @click="selectWarehouse(warehouse.id)">위치 보기</UButton></td></tr><tr v-if="!warehouses?.items.length && warehouseStatus !== 'pending'"><td colspan="3" class="px-5 py-16 text-center text-slate-400">등록된 창고가 없습니다.</td></tr></tbody></table></div>
        <InventoryPagination :total="warehouses?.total ?? 0" :page="warehousePage" :page-size="warehouses?.pageSize ?? 20" :busy="warehouseStatus === 'pending'" @change="changeWarehousePage" />
      </section>
      <section class="overflow-hidden rounded-xl border border-slate-200/80 bg-white" :aria-busy="locationStatus === 'pending'">
        <div class="flex flex-wrap items-center justify-between gap-3 p-5"><div><h2 class="text-sm font-semibold text-slate-800">보관위치</h2><p class="mt-1 text-[11px] text-blue-600">{{ selectedWarehouse?.name ?? '창고를 선택해 주세요' }}</p></div><UButton v-if="admin" icon="i-lucide-plus" size="sm" :disabled="!selectedWarehouse" @click="edit('location', null)">위치 등록</UButton></div>
        <UAlert v-if="locationError" color="error" variant="soft" :title="inventoryErrorMessage(locationError)" class="m-5"><template #actions><UButton color="error" variant="outline" @click="refreshLocations()">다시 시도</UButton></template></UAlert>
        <p v-if="locationStatus === 'pending'" role="status" class="px-5 py-3 text-xs text-blue-600">보관위치를 불러오는 중입니다…</p>
        <div class="overflow-x-auto"><table class="w-full min-w-[430px] text-left text-xs"><caption class="sr-only">선택한 창고의 보관위치</caption><thead class="border-y border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">위치코드 / 이름</th><th class="px-4 py-3 font-medium">사용상태</th><th class="px-5 py-3 text-right font-medium">관리</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="location in locations?.items" :key="location.id"><td class="px-5 py-4 font-medium">{{ location.name }}<p class="mt-1 font-normal text-slate-400">{{ location.code }}</p></td><td class="px-4 py-4"><UBadge :color="location.is_active ? 'success' : 'neutral'" variant="subtle" size="sm">{{ location.is_active ? '사용 중' : '사용 중지' }}</UBadge></td><td class="px-5 py-4 text-right"><UButton v-if="admin" color="neutral" variant="ghost" size="xs" @click="edit('location', location)">수정</UButton><UButton v-else :to="`/inventory?warehouse_id=${selectedWarehouseId}&location_id=${location.id}`" color="neutral" variant="ghost" size="xs">재고 조회</UButton></td></tr><tr v-if="!locations?.items.length && locationStatus !== 'pending'"><td colspan="3" class="px-5 py-16 text-center text-slate-400">{{ selectedWarehouse ? '이 창고에 등록된 보관위치가 없습니다.' : '창고를 먼저 등록하거나 선택해 주세요.' }}</td></tr></tbody></table></div>
        <InventoryPagination :total="locations?.total ?? 0" :page="locationPage" :page-size="locations?.pageSize ?? 20" :busy="locationStatus === 'pending'" @change="changeLocationPage" />
      </section>
    </div>
    <div class="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs leading-6 text-slate-500"><UIcon name="i-lucide-info" class="mt-1 size-4 shrink-0" /><p>창고·위치 코드는 해당 기준정보를 식별합니다. 사용하지 않는 창고나 위치는 수정에서 사용 중지로 변경합니다. 기존 재고는 조회할 수 있습니다.</p></div>
    <UModal v-if="admin" v-model:open="open" :title="`${kind === 'warehouse' ? '창고' : '보관위치'} ${editing ? '수정' : '등록'}`" :description="kind === 'warehouse' ? '창고의 코드와 이름을 관리합니다.' : `${selectedWarehouse?.name ?? ''}에 속하는 보관위치를 관리합니다.`" :dismissible="!busy"><template #body><form id="storage-editor" class="space-y-4" @submit.prevent="save"><UAlert v-if="saveError" color="error" variant="soft" :title="saveError" /><UFormField :label="kind === 'warehouse' ? '창고코드' : '위치코드'" required><UInput v-model="form.code" required maxlength="50" class="w-full" :disabled="busy" /></UFormField><UFormField label="이름" required><UInput v-model="form.name" required maxlength="200" class="w-full" :disabled="busy" /></UFormField><UCheckbox v-model="form.is_active" label="사용 중" :disabled="busy" /></form></template><template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :disabled="busy" @click="open = false">취소</UButton><UButton type="submit" form="storage-editor" :loading="busy">저장</UButton></div></template></UModal>
  </div>
</template>
