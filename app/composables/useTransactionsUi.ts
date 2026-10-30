import type { StockUnit } from '#shared/types/inventory'

export function transactionToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function transactionUnits(base: StockUnit | undefined, density?: number | null): StockUnit[] {
  if (base && base !== 'EA' && density && density > 0) return ['kg', 'g', 'L', 'mL']
  if (base === 'kg' || base === 'g') return ['kg', 'g']
  if (base === 'L' || base === 'mL') return ['L', 'mL']
  return base ? [base] : ['kg', 'g', 'L', 'mL', 'EA']
}

/** A retry keeps its request key; editing or starting a new entry creates a new request. */
export function useTransactionRequest<T>(signature: () => unknown) {
  const busy = ref(false)
  const error = ref<string | null>(null)
  const result = shallowRef<T | null>(null)
  const completed = ref(false)
  let requestKey: string | null = null
  function reset() { requestKey = null; error.value = null; result.value = null; completed.value = false }
  // Replacing a refreshed selection object with the same fields is not a new request.
  watch(() => JSON.stringify(signature()), reset, { flush: 'sync' })
  async function submit(endpoint: string, payload: Record<string, unknown>) {
    if (busy.value || completed.value) return
    requestKey ??= crypto.randomUUID()
    busy.value = true; error.value = null
    try {
      result.value = await $fetch<T>(endpoint, { method: 'POST', body: { ...payload, request_key: requestKey } })
      completed.value = true
    }
    catch (cause) { error.value = inventoryErrorMessage(cause) }
    finally { busy.value = false }
  }
  return { busy, error, result, completed, submit, reset }
}
