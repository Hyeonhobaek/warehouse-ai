import { createApp, createError, createRouter, toWebHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  issueInputSchema, issuePreviewQuerySchema, pendingReturnQuerySchema, receiptInputSchema,
  releaseReturnInputSchema, returnableQuerySchema, returnInputSchema, transactionBatchQuerySchema,
  transactionQuantitySchema, transactionQuerySchema,
} from '../shared/schemas/transactions'
import {
  getTransaction, issueStock, listPendingReturns, listReturnableLines, listTransactionBatches,
  listTransactions, previewIssue, receiveStock, releaseReturnedStock, returnStock,
  throwTransactionError, transactionDetailHandler, transactionListHandler, transactionMutationHandler,
} from '../server/services/transactions'
import { requirePermission } from '../server/services/auth'
import { createSupabaseServerClient, type SupabaseServerClient } from '../server/utils/supabase'
import type { TransactionResult } from '../shared/types/transactions'

vi.mock('../server/services/auth', () => ({ requirePermission: vi.fn() }))
vi.mock('../server/utils/supabase', () => ({ createSupabaseServerClient: vi.fn() }))

const id = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const receipt = {
  request_key: id, material_id: id, lot_number: '000012', location_id: secondId, quantity: '12.500000', unit: 'kg',
  received_on: '2026-10-01', expires_on: '2027-10-01', retest_on: null, manufactured_on: null,
  manufacturer: '', test_number: 'RP26-001', receipt_reference: 'RCPT-001', reason: '원료 입고', notes: '',
}
const issue = { request_key: id, material_id: id, quantity: '15', unit: 'kg', occurred_on: '2026-10-30', reason: '제조 불출' }
const returned = { request_key: id, issue_line_id: secondId, location_id: id, quantity: '1.25', unit: 'kg', occurred_on: '2026-10-30', reason: '미사용 잔량' }
const release = { request_key: id, return_line_id: secondId, quantity: '1.25', unit: 'kg', occurred_on: '2026-10-30', reason: '반납 상태 확인 완료' }
const response = { operation: { id, kind: 'ISSUE' }, lines: [{ id: secondId, quantity: 15 }] } as TransactionResult

describe('transaction validation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T14:59:59Z'))
  })
  afterEach(() => vi.useRealTimers())

  it.each([
    ['00012.500000', '12.5'], ['0.000001', '0.000001'], [25, '25'],
    [0.000001, '0.000001'], ['999999999.123456', '999999999.123456'],
  ])('keeps exact supported quantity %s as %s', (input, expected) => {
    expect(transactionQuantitySchema.parse(input)).toBe(expected)
  })

  it.each([0, -1, NaN, Infinity, 1_000_000_000, '0.000000', '0.0000001', '1.1234567', '1e3', '1,000', '', ' ', true, null, [], {}, '12.'])('rejects unsafe quantity %s', (input) => {
    expect(transactionQuantitySchema.safeParse(input).success).toBe(false)
  })

  it('preserves leading zero LOT and trims text without inventing optional metadata', () => {
    const parsed = receiptInputSchema.parse({ ...receipt, lot_number: ' 000012 ', manufactured_on: ' ', test_number: ' RP26-001 ' })
    expect(parsed).toMatchObject({ lot_number: '000012', manufactured_on: null, test_number: 'RP26-001', quantity: '12.5' })
    expect(issueInputSchema.parse(issue)).toMatchObject({ warehouse_id: null, production_item: '', production_batch: '', notes: '' })
  })

  it('requires a stable idempotency key and explicit reason for every write', () => {
    for (const [schema, input] of [[receiptInputSchema, receipt], [issueInputSchema, issue], [returnInputSchema, returned], [releaseReturnInputSchema, release]] as const) {
      expect(schema.safeParse({ ...input, request_key: undefined }).success).toBe(false)
      expect(schema.safeParse({ ...input, reason: '  ' }).success).toBe(false)
      expect(schema.safeParse({ ...input, on_hand: 100, actor_id: id }).success).toBe(false)
    }
  })

  it('never allows receipt to approve quality or update an existing physical batch', () => {
    expect(receiptInputSchema.safeParse({ ...receipt, quality_status: 'APPROVED' }).success).toBe(false)
    expect(receiptInputSchema.safeParse({ ...receipt, batch_id: secondId }).success).toBe(false)
  })

  it.each(['expires_on', 'retest_on'])('rejects %s before physical receipt', (field) => {
    expect(receiptInputSchema.safeParse({ ...receipt, [field]: '2026-09-30' }).success).toBe(false)
  })

  it('rejects invalid date, future manufacture and future transaction while allowing Seoul midnight', () => {
    expect(receiptInputSchema.safeParse({ ...receipt, received_on: '2026-02-30' }).success).toBe(false)
    expect(receiptInputSchema.safeParse({ ...receipt, manufactured_on: '2026-10-02' }).success).toBe(false)
    expect(issueInputSchema.safeParse({ ...issue, occurred_on: '2026-10-31' }).success).toBe(false)
    vi.setSystemTime(new Date('2026-10-30T15:00:00Z'))
    expect(issueInputSchema.safeParse({ ...issue, occurred_on: '2026-10-31' }).success).toBe(true)
  })

  it('preview requires the same business date and numeric constraints as save', () => {
    expect(issuePreviewQuerySchema.safeParse({ material_id: id, quantity: '15', unit: 'kg' }).success).toBe(false)
    expect(issuePreviewQuerySchema.parse({ material_id: id, quantity: '15.000', unit: 'kg', occurred_on: '2026-10-30' })).toMatchObject({ quantity: '15', warehouse_id: null })
  })

  it('rejects reversed ranges, invalid IDs, arrays and extra filters', () => {
    expect(transactionQuerySchema.safeParse({ from: '2026-10-30', to: '2026-10-01' }).success).toBe(false)
    expect(transactionQuerySchema.safeParse({ batch_id: 'RP26-001' }).success).toBe(false)
    expect(transactionQuerySchema.safeParse({ type: 'ADJUSTMENT' }).success).toBe(false)
    expect(transactionQuerySchema.safeParse({ type: ['ISSUE', 'RETURN'] }).success).toBe(false)
    expect(transactionBatchQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false)
    expect(returnableQuerySchema.safeParse({ request_payload: 'secret' }).success).toBe(false)
  })
})

describe('transaction service boundaries', () => {
  it('delegates each mutation to exactly one atomic PostgreSQL RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: response, error: null })
    const client = { rpc } as unknown as SupabaseServerClient
    const inputs = [receiptInputSchema.parse(receipt), issueInputSchema.parse(issue), returnInputSchema.parse(returned), releaseReturnInputSchema.parse(release)]
    await receiveStock(client, inputs[0] as ReturnType<typeof receiptInputSchema.parse>)
    await issueStock(client, inputs[1] as ReturnType<typeof issueInputSchema.parse>)
    await returnStock(client, inputs[2] as ReturnType<typeof returnInputSchema.parse>)
    await releaseReturnedStock(client, inputs[3] as ReturnType<typeof releaseReturnInputSchema.parse>)
    expect(rpc.mock.calls).toEqual(['stock_receive', 'stock_issue', 'stock_return', 'stock_release_return'].map((name, index) => [name, { p_input: inputs[index] }]))
    expect(inputs[1]?.quantity).toBe('15')
  })

  it('preview calls the read-only RPC with the requested date', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { available: 20, lines: [] }, error: null })
    const input = issuePreviewQuerySchema.parse({ material_id: id, quantity: '15', unit: 'kg', occurred_on: '2026-10-30' })
    await previewIssue({ rpc } as unknown as SupabaseServerClient, input)
    expect(rpc).toHaveBeenCalledWith('stock_preview_issue', { p_input: input })
  })

  function queryClient() {
    const request = {
      select: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(), lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(), range: vi.fn().mockResolvedValue({ data: [], count: 25, error: null }),
    }
    return { request, client: { from: vi.fn().mockReturnValue(request) } as unknown as SupabaseServerClient }
  }

  it('filters historical/current test-number search literally and paginates chronologically', async () => {
    const { request, client } = queryClient()
    const data = await listTransactions(client, transactionQuerySchema.parse({ q: 'RP%_,(id.eq.1)', material_id: id, batch_id: secondId, type: 'ISSUE', from: '2026-10-01', to: '2026-10-30', page: '2', pageSize: '10' }))
    expect(request.ilike).toHaveBeenCalledWith('search_text', '%RP\\%\\_,(id.eq.1)%')
    expect(request.eq.mock.calls).toEqual([['material_id', id], ['batch_id', secondId], ['kind', 'ISSUE']])
    expect(request.gte).toHaveBeenCalledWith('occurred_on', '2026-10-01')
    expect(request.lte).toHaveBeenCalledWith('occurred_on', '2026-10-30')
    expect(request.order.mock.calls).toEqual([['occurred_on'], ['created_at'], ['operation_id'], ['sequence'], ['id']])
    expect(request.range).toHaveBeenCalledWith(10, 19)
    expect(data).toEqual({ items: [], total: 25, page: 2, pageSize: 10 })
  })

  it('reads return and release candidates from remaining quantities, never original totals', async () => {
    const { request, client } = queryClient()
    await listReturnableLines(client, returnableQuerySchema.parse({ material_id: id }))
    expect(request.eq).toHaveBeenCalledWith('kind', 'ISSUE')
    expect(request.gt).toHaveBeenCalledWith('returnable_quantity', 0)
    await listPendingReturns(client, pendingReturnQuerySchema.parse({ q: 'RP26' }))
    expect(request.eq).toHaveBeenCalledWith('kind', 'RETURN')
    expect(request.gt).toHaveBeenCalledWith('releasable_quantity', 0)
    await listTransactionBatches(client, transactionBatchQuerySchema.parse({ material_id: id, batch_id: secondId }))
    expect(client.from).toHaveBeenCalledWith('stock_batch_options')
    expect(request.eq).toHaveBeenCalledWith('batch_id', secondId)
  })

  it('does not expose internal idempotency payload in transaction detail', async () => {
    const operationRequest = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: response.operation, error: null }) }
    const linesRequest = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn() }
    linesRequest.order.mockReturnValueOnce(linesRequest).mockResolvedValueOnce({ data: response.lines, error: null })
    const client = { from: vi.fn().mockReturnValueOnce(operationRequest).mockReturnValueOnce(linesRequest) } as unknown as SupabaseServerClient
    expect(await getTransaction(client, id)).toEqual(response)
    expect(operationRequest.select.mock.calls[0]?.[0]).not.toContain('request_payload')
    expect(operationRequest.select.mock.calls[0]?.[0]).not.toBe('*')
  })

  it.each([['40001', 409], ['40P01', 409], ['55P03', 409], ['57014', 409], ['22023', 400], ['23505', 409], ['42501', 403], ['connection_failure', 503]])('maps %s safely to %s', (code, statusCode) => {
    try { throwTransactionError({ code, message: 'private SQL schema details' }) }
    catch (error) {
      expect(error).toMatchObject({ statusCode })
      expect((error as Error).message).not.toContain('private SQL')
    }
  })

  it('reports shortage as a conflict and does not retry the RPC with a new request key', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'P0001', message: 'Insufficient available stock; entire issue cancelled' } })
    await expect(issueStock({ rpc } as unknown as SupabaseServerClient, issueInputSchema.parse(issue))).rejects.toMatchObject({ statusCode: 409 })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Return exceeds original issued quantity remaining', '22023'],
    ['Release exceeds held return quantity remaining', '22023'],
    ['Request key already used with different input', '23505'],
  ])('maps stable database remaining/conflict message %s to 409', (message, code) => {
    expect(() => throwTransactionError({ message, code })).toThrow(expect.objectContaining({ statusCode: 409 }))
  })
})

describe('transaction HTTP authorization', () => {
  beforeEach(() => {
    vi.mocked(requirePermission).mockReset()
    vi.mocked(createSupabaseServerClient).mockReset()
  })

  function api() {
    const mutation = vi.fn(async () => response)
    const read = vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }))
    const router = createRouter()
      .post('/issues', transactionMutationHandler(issueInputSchema, mutation))
      .post('/release', transactionMutationHandler(releaseReturnInputSchema, mutation, 'materials:manage'))
      .get('/transactions', transactionListHandler(transactionQuerySchema, read))
      .get('/transactions/:id', transactionDetailHandler())
    const handle = toWebHandler(createApp().use(router))
    const request = (path: string, init?: RequestInit) => handle(new Request(`http://localhost${path}`, init))
    return { request, mutation, read }
  }

  const write = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', body: JSON.stringify(body), headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...headers } })

  it('rejects cross-site and missing-origin writes before creating a DB client', async () => {
    const { request, mutation } = api()
    expect((await request('/issues', write(issue, { Origin: 'https://other.example' }))).status).toBe(403)
    expect((await request('/issues', { method: 'POST', body: JSON.stringify(issue), headers: { 'Content-Type': 'application/json' } })).status).toBe(403)
    expect(mutation).not.toHaveBeenCalled()
    expect(requirePermission).not.toHaveBeenCalled()
    expect(createSupabaseServerClient).not.toHaveBeenCalled()
  })

  it('requires operator for writes and administrator for release', async () => {
    vi.mocked(requirePermission).mockRejectedValue(createError({ statusCode: 403 }))
    const { request, mutation } = api()
    expect((await request('/issues', write(issue))).status).toBe(403)
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), 'inventory:write')
    expect((await request('/release', write(release))).status).toBe(403)
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), 'materials:manage')
    expect(mutation).not.toHaveBeenCalled()
  })

  it('validates authentication before ledger and transaction detail access', async () => {
    vi.mocked(requirePermission).mockRejectedValue(createError({ statusCode: 401 }))
    const { request, read } = api()
    expect((await request('/transactions')).status).toBe(401)
    expect((await request(`/transactions/${id}`)).status).toBe(401)
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), 'inventory:read')
    expect(read).not.toHaveBeenCalled()
    expect(createSupabaseServerClient).not.toHaveBeenCalled()
  })

  it('rejects missing key, unsupported content and unbounded request body', async () => {
    const { request, mutation } = api()
    expect((await request('/issues', write({ ...issue, request_key: undefined }))).status).toBe(400)
    expect((await request('/issues', write(issue, { 'Content-Type': 'text/plain' }))).status).toBe(415)
    expect((await request('/issues', write(issue, { 'Content-Length': '40000' }))).status).toBe(413)
    expect(mutation).not.toHaveBeenCalled()
  })

  it('keeps caller idempotency key and emits validated decimal strings', async () => {
    const { request, mutation } = api()
    expect((await request('/issues', write({ ...issue, quantity: 15 }))).status).toBe(201)
    expect(mutation).toHaveBeenCalledWith(undefined, { ...issue, quantity: '15', notes: '', production_item: '', production_batch: '', warehouse_id: null, issue_purpose: 'GENERAL' })
  })
})
