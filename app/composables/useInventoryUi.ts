import type { EffectiveQualityStatus } from '#shared/types/inventory'

export function inventoryErrorMessage(error: unknown): string {
  const value = error as { data?: { message?: string; statusMessage?: string }; statusMessage?: string; message?: string }
  return value.data?.message || value.data?.statusMessage || value.statusMessage || value.message || '요청을 처리하지 못했습니다. 다시 시도해 주세요.'
}

export function inventoryQuantity(value: number | null | undefined): string {
  return value == null ? '—' : new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 }).format(value)
}

export function inventoryDate(value: string | null | undefined): string {
  if (!value) return '—'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll('-', '.')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replaceAll('-', '.')
}

export function inventoryStatusColor(status: EffectiveQualityStatus) {
  return ({ APPROVED: 'success', PENDING: 'warning', REJECTED: 'error', HOLD: 'neutral', EXPIRED: 'error' } as const)[status]
}

export function useInventoryQuery(defaults: Record<string, string>) {
  const route = useRoute()
  const router = useRouter()
  const filters = reactive({ ...defaults })
  const page = computed(() => Math.max(1, Number(route.query.page) || 1))
  watch(() => route.query, (query) => {
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = query[key]
      filters[key] = typeof value === 'string' ? value : fallback
    }
  }, { immediate: true })
  function queryString(extra: Record<string, string> = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...route.query, ...extra })) {
      if (typeof value === 'string' && value) params.set(key, value)
    }
    return params.toString()
  }
  async function apply() {
    const query: Record<string, string> = {}
    for (const [key, value] of Object.entries(filters)) if (value && value !== defaults[key]) query[key] = value
    await router.push({ query })
  }
  async function reset() { await router.push({ query: {} }) }
  async function setPage(value: number) { await router.push({ query: { ...route.query, page: value > 1 ? String(value) : undefined } }) }
  return { route, filters, page, queryString, apply, reset, setPage }
}
