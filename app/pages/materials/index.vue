<script setup lang="ts">
import type { Material, MaterialInput, Paginated } from '#shared/types/inventory'

definePageMeta({ middleware: 'auth' })
useSeoMeta({ title: '원료 관리 · Warehouse AI' })
const { user, fetchWithSession } = useAuth()
const admin = computed(() => user.value?.role === 'admin')
const { route, filters, page, queryString, apply, reset, setPage } = useInventoryQuery({ q: '', active: 'all' })
const { data, error, status, refresh } = await useAsyncData('materials-list', () => fetchWithSession<Paginated<Material>>(`/api/materials?${queryString()}`), { watch: [() => route.fullPath] })
const editorOpen = ref(false)
const editing = ref<Material | null>(null)
const deleting = ref<Material | null>(null)
const deleteOpen = ref(false)
const busy = ref(false)
const saveError = ref<string | null>(null)
const notice = ref('')
function edit(material: Material | null) { editing.value = material; saveError.value = null; editorOpen.value = true }
function confirmDelete(material: Material) { deleting.value = material; saveError.value = null; deleteOpen.value = true }
async function save(input: MaterialInput) {
  busy.value = true; saveError.value = null
  try {
    await $fetch<Material>(editing.value ? `/api/materials/${editing.value.id}` : '/api/materials', { method: editing.value ? 'PATCH' : 'POST', body: input })
    editorOpen.value = false; notice.value = '원료 정보를 저장했습니다.'; await refresh()
  }
  catch (cause) { saveError.value = inventoryErrorMessage(cause) }
  finally { busy.value = false }
}
async function remove() {
  if (!deleting.value) return
  busy.value = true; saveError.value = null
  try {
    await $fetch<{ ok: true }>(`/api/materials/${deleting.value.id}`, { method: 'DELETE' })
    deleteOpen.value = false; notice.value = '원료를 삭제했습니다.'
    if (data.value?.items.length === 1 && page.value > 1) await setPage(page.value - 1)
    else await refresh()
  }
  catch (cause) { saveError.value = inventoryErrorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div><p class="text-[10px] font-semibold tracking-[.18em] text-slate-400">MATERIAL MASTER</p><h1 class="mt-2 text-[27px] font-bold text-slate-900">원료 관리</h1><p class="mt-2 text-xs text-slate-500">원료 기준정보와 제조 LOT, 입고건의 품질정보를 관리합니다.</p></div>
      <div class="flex gap-2"><UButton :href="`/api/materials/export?${queryString()}`" external color="neutral" variant="outline" icon="i-lucide-download" class="bg-white">CSV 내려받기</UButton><UButton v-if="admin" icon="i-lucide-plus" @click="edit(null)">원료 등록</UButton></div>
    </div>
    <UAlert v-if="notice" color="success" variant="soft" :title="notice" close @update:open="notice = ''" />
    <form class="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200/80 bg-white p-5" @submit.prevent="apply">
      <UFormField label="원료 검색" class="min-w-56 flex-1"><UInput v-model="filters.q" placeholder="원료코드, 원료명, 약어, 제조사" icon="i-lucide-search" class="w-full" /></UFormField>
      <UFormField label="사용상태"><USelect v-model="filters.active" :items="[{ label: '전체', value: 'all' }, { label: '사용 중', value: 'true' }, { label: '사용 중지', value: 'false' }]" class="w-32" /></UFormField>
      <UButton type="submit">검색</UButton><UButton color="neutral" variant="ghost" @click="reset">초기화</UButton>
    </form>
    <UAlert v-if="error" color="error" variant="soft" title="원료를 불러오지 못했습니다" :description="inventoryErrorMessage(error)"><template #actions><UButton color="error" variant="outline" @click="refresh()">다시 시도</UButton></template></UAlert>
    <section class="overflow-hidden rounded-xl border border-slate-200/80 bg-white" :aria-busy="status === 'pending'">
      <div v-if="status === 'pending'" role="status" class="px-5 py-3 text-xs text-blue-600">원료를 불러오는 중입니다…</div>
      <div class="overflow-x-auto"><table class="w-full min-w-[850px] text-left text-xs"><caption class="sr-only">원료 목록</caption>
        <thead class="border-b border-slate-100 bg-slate-50 text-slate-500"><tr><th class="px-5 py-3 font-medium">원료코드 / 원료명</th><th class="px-4 py-3 font-medium">규격 · 제조사</th><th class="px-4 py-3 font-medium">기본단위</th><th class="px-4 py-3 text-right font-medium">최소재고</th><th class="px-4 py-3 font-medium">사용상태</th><th class="px-5 py-3 text-right font-medium">관리</th></tr></thead>
        <tbody class="divide-y divide-slate-100"><tr v-for="row in data?.items" :key="row.id" class="hover:bg-slate-50/60">
          <td class="px-5 py-4"><NuxtLink :to="`/materials/${row.id}`" class="font-semibold text-blue-600 hover:underline">{{ row.name }}</NuxtLink><p class="mt-1 text-[11px] text-slate-400">{{ row.code }}<span v-if="row.aliases.length"> · {{ row.aliases.join(', ') }}</span></p></td>
          <td class="px-4 py-4">{{ row.specification || '—' }}<p class="mt-1 text-[11px] text-slate-400">{{ row.manufacturer || '제조사 미등록' }}</p></td><td class="px-4 py-4">{{ row.base_unit }}</td><td class="px-4 py-4 text-right tabular-nums">{{ inventoryQuantity(row.min_stock) }}</td><td class="px-4 py-4"><UBadge :color="row.is_active ? 'success' : 'neutral'" variant="subtle" size="sm">{{ row.is_active ? '사용 중' : '사용 중지' }}</UBadge></td>
          <td class="px-5 py-4"><div class="flex justify-end gap-1"><UButton :to="`/materials/${row.id}`" color="neutral" variant="ghost" size="xs">상세</UButton><template v-if="admin"><UButton color="neutral" variant="ghost" size="xs" @click="edit(row)">수정</UButton><UButton color="error" variant="ghost" size="xs" @click="confirmDelete(row)">삭제</UButton></template></div></td>
        </tr><tr v-if="!data?.items.length && status !== 'pending'"><td colspan="6" class="px-5 py-16 text-center text-slate-400"><UIcon name="i-lucide-flask-conical" class="mx-auto mb-3 block size-8 text-slate-300" />조건에 맞는 원료가 없습니다.</td></tr></tbody>
      </table></div>
      <InventoryPagination :total="data?.total ?? 0" :page="page" :page-size="data?.pageSize ?? 20" :busy="status === 'pending'" @change="setPage" />
    </section>
    <p class="text-[11px] text-slate-400">LOT 또는 입출고 이력이 연결된 원료는 삭제할 수 없습니다. 원료 수정에서 사용 중지로 변경해 주세요.</p>
    <InventoryMaterialEditor v-if="admin" v-model:open="editorOpen" :material="editing" :busy="busy" :error="saveError" @save="save" />
    <UModal v-model:open="deleteOpen" title="원료 삭제" :description="`${deleting?.name ?? ''} 원료를 삭제하시겠습니까? 연결된 LOT 또는 재고 이력이 있으면 삭제할 수 없습니다.`" :dismissible="!busy"><template #body><UAlert v-if="saveError" color="error" variant="soft" :title="saveError" /><p class="text-sm text-slate-500">삭제한 원료는 복구할 수 없습니다.</p></template><template #footer><div class="flex w-full justify-end gap-2"><UButton color="neutral" variant="outline" :disabled="busy" @click="deleteOpen = false">취소</UButton><UButton color="error" :loading="busy" @click="remove">삭제</UButton></div></template></UModal>
  </div>
</template>
