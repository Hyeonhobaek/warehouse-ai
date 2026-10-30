<script setup lang="ts" generic="T extends object">
import type { Paginated } from '#shared/types/inventory'

const props = withDefaults(defineProps<{
  endpoint: string
  label: string
  optionLabel: (item: T) => string
  optionKey?: (item: T) => string
  optionDetail?: (item: T) => string
  optionDisabled?: (item: T) => boolean
  disabled?: boolean
  placeholder?: string
}>(), { disabled: false, placeholder: '검색하여 선택하세요' })
const selected = defineModel<T | null>({ required: true })
const { fetchWithSession } = useAuth()
const open = ref(false)
const search = ref('')
const page = ref(1)
const result = shallowRef<Paginated<T> | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const controlId = useId()
function key(item: T) { return props.optionKey?.(item) ?? String('id' in item ? item.id : '') }
let request = 0
async function load(nextPage = 1) {
  const sequence = ++request
  page.value = nextPage; loading.value = true; error.value = null
  try {
    const params = new URLSearchParams({ q: search.value.trim(), page: String(nextPage), pageSize: '10' })
    const data = await fetchWithSession<Paginated<T>>(`${props.endpoint}${props.endpoint.includes('?') ? '&' : '?'}${params}`)
    if (sequence === request) result.value = data
  }
  catch (cause) { if (sequence === request) { result.value = null; error.value = inventoryErrorMessage(cause) } }
  finally { if (sequence === request) loading.value = false }
}
async function toggle() { open.value = !open.value; if (open.value) await load() }
function choose(item: T) { selected.value = item; open.value = false }
watch(() => props.endpoint, () => { request++; result.value = null; search.value = ''; page.value = 1; if (open.value && !props.disabled) void load() })
watch(() => props.disabled, value => { if (value) { open.value = false; request++; loading.value = false } })
</script>

<template>
  <div class="space-y-2">
    <div class="flex gap-1">
      <button type="button" class="flex min-h-9 w-full items-center justify-between gap-3 rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400" :aria-label="`${label}: ${selected ? optionLabel(selected) : '선택 안 됨'}`" :aria-expanded="open" :aria-controls="controlId" :disabled="disabled" @click="toggle"><span class="break-words" :class="selected ? 'text-slate-800' : 'text-slate-400'">{{ selected ? optionLabel(selected) : placeholder }}</span><UIcon name="i-lucide-chevron-down" class="size-4 shrink-0 text-slate-400" /></button>
      <UButton v-if="selected && !disabled" type="button" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="`${label} 선택 해제`" @click="selected = null" />
    </div>
    <div v-if="open" :id="controlId" class="overflow-hidden rounded-lg border border-blue-200 bg-white shadow-sm" :aria-busy="loading">
      <div class="flex gap-2 p-3"><UInput v-model="search" :aria-label="`${label} 검색어`" placeholder="검색어 입력" icon="i-lucide-search" class="w-full" @keydown.enter.prevent="load()" /><UButton type="button" size="sm" :loading="loading" @click="load()">검색</UButton></div>
      <p v-if="loading" role="status" class="px-3 pb-3 text-xs text-blue-600">목록을 불러오는 중입니다…</p>
      <div v-else-if="error" role="alert" class="px-3 pb-3 text-xs text-rose-600">{{ error }} <UButton type="button" color="error" variant="link" size="xs" @click="load(page)">다시 시도</UButton></div>
      <ul v-else class="max-h-64 overflow-y-auto border-t border-slate-100" :aria-label="`${label} 검색 결과`"><li v-for="item in result?.items" :key="key(item)"><button type="button" class="block w-full border-b border-slate-100 px-3 py-3 text-left hover:bg-blue-50 focus:bg-blue-50 focus:outline-2 focus:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40" :aria-pressed="selected ? key(selected) === key(item) : false" :disabled="optionDisabled?.(item)" @click="choose(item)"><span class="block text-xs font-medium text-slate-800">{{ optionLabel(item) }}</span><span v-if="optionDetail" class="mt-1 block text-[11px] text-slate-500">{{ optionDetail(item) }}</span></button></li><li v-if="!result?.items.length" class="px-3 py-6 text-center text-xs text-slate-400">검색 결과가 없습니다.</li></ul>
      <InventoryPagination v-if="!error" :total="result?.total ?? 0" :page="page" :page-size="10" :busy="loading" @change="load" />
      <div class="border-t border-slate-100 px-3 py-2 text-right"><UButton type="button" size="xs" color="neutral" variant="ghost" @click="open = false">선택창 닫기</UButton></div>
    </div>
  </div>
</template>
