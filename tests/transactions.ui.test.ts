import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, reactive, ref, shallowRef, watch, type EffectScope } from 'vue'
import { transactionUnits, useTransactionRequest } from '../app/composables/useTransactionsUi'

describe('transaction form request identity', () => {
  let scope: EffectScope
  const fetch = vi.fn()

  beforeEach(() => {
    scope = effectScope()
    fetch.mockReset()
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('shallowRef', shallowRef)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('inventoryErrorMessage', () => '응답을 확인하지 못했습니다.')
    vi.stubGlobal('crypto', { randomUUID: vi.fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222') })
  })

  afterEach(() => {
    scope.stop()
    vi.unstubAllGlobals()
  })

  it('reuses the failed request key after the same selected record is refreshed', async () => {
    const form = reactive({ quantity: '2', reason: '반납 상태 확인' })
    const selected = ref({ id: 'return-line', releasable: 5 })
    const state = scope.run(() => useTransactionRequest<{ ok: boolean }>(() => ({ ...form, line: selected.value.id })))!
    fetch.mockRejectedValueOnce(new Error('Response lost after the server may have committed'))
      .mockResolvedValueOnce({ ok: true })

    await state.submit('/api/transactions/returns/release', { ...form, return_line_id: selected.value.id })
    expect(state.completed.value).toBe(false)
    expect(state.error.value).toBe('응답을 확인하지 못했습니다.')
    expect(state.busy.value).toBe(false)

    // A refreshed candidate or reopened modal can replace the object while preserving its identity.
    selected.value = { id: 'return-line', releasable: 3 }
    await state.submit('/api/transactions/returns/release', { ...form, return_line_id: selected.value.id })

    const firstBody = fetch.mock.calls[0]![1].body
    const retriedBody = fetch.mock.calls[1]![1].body
    expect(retriedBody).toEqual(firstBody)
    expect(retriedBody.request_key).toBe('11111111-1111-4111-8111-111111111111')
    expect(state.completed.value).toBe(true)
    expect(state.error.value).toBeNull()
    expect(state.result.value).toEqual({ ok: true })

    await state.submit('/api/transactions/returns/release', { ...form, return_line_id: selected.value.id })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('creates a new request only after the submitted content changes', async () => {
    const form = reactive({ quantity: '2', reason: '반납 상태 확인' })
    const state = scope.run(() => useTransactionRequest<{ ok: boolean }>(() => ({ ...form, line: 'return-line' })))!
    fetch.mockResolvedValue({ ok: true })

    await state.submit('/api/transactions/returns/release', { ...form })
    expect(state.completed.value).toBe(true)

    form.quantity = '1'
    expect(state.completed.value).toBe(false)
    expect(state.result.value).toBeNull()
    await state.submit('/api/transactions/returns/release', { ...form })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]![1].body.request_key).toBe('11111111-1111-4111-8111-111111111111')
    expect(fetch.mock.calls[1]![1].body.request_key).toBe('22222222-2222-4222-8222-222222222222')
    expect(fetch.mock.calls[1]![1].body.quantity).toBe('1')
  })

  it('does not dispatch another request while a submission is pending', async () => {
    const state = scope.run(() => useTransactionRequest<{ ok: boolean }>(() => ({ quantity: '2' })))!
    let resolve!: (value: { ok: boolean }) => void
    fetch.mockImplementationOnce(() => new Promise<{ ok: boolean }>((complete) => { resolve = complete }))

    const pending = state.submit('/api/transactions/issues', { quantity: '2' })
    expect(state.busy.value).toBe(true)
    await state.submit('/api/transactions/issues', { quantity: '2' })
    expect(fetch).toHaveBeenCalledTimes(1)
    resolve({ ok: true })
    await pending
    expect(state.busy.value).toBe(false)
    expect(state.completed.value).toBe(true)
  })
})

describe('transaction unit options', () => {
  it('offers volume and mass together only when a usable density exists', () => {
    expect(transactionUnits('kg', 0.8)).toEqual(['kg', 'g', 'L', 'mL'])
    expect(transactionUnits('kg', null)).toEqual(['kg', 'g'])
    expect(transactionUnits('L', 0)).toEqual(['L', 'mL'])
    expect(transactionUnits('EA', 1)).toEqual(['EA'])
  })
})
