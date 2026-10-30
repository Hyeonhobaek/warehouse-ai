import { createApp, createError, createRouter, toWebHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  batchInputSchema, inventoryQuerySchema, isCalendarDate, locationInputSchema,
  lotInputSchema, materialInputSchema, materialQuerySchema, summaryQuerySchema,
} from '../shared/schemas/inventory'
import type { BatchInput, MaterialInput } from '../shared/types/inventory'
import {
  buildCsv, collectExportRows, csvCell, inventoryCreateHandler, inventoryDeleteHandler,
  inventoryListHandler, inventoryUpdateHandler, listInventory, listMaterials,
  literalSearch, parseInventoryInput, throwInventoryError,
} from '../server/services/inventory'
import { requirePermission } from '../server/services/auth'
import { createSupabaseServerClient, type SupabaseServerClient } from '../server/utils/supabase'

vi.mock('../server/services/auth', () => ({ requirePermission: vi.fn() }))
vi.mock('../server/utils/supabase', () => ({ createSupabaseServerClient: vi.fn() }))

const id = '11111111-1111-4111-8111-111111111111'
const material: MaterialInput = {
  code: '001234', name: 'Acetone', aliases: ['AC'], specification: '99%', manufacturer: '',
  base_unit: 'kg', min_stock: 20, storage_condition: '', package_size: 20, package_unit: 'L',
  density: 0.79, is_active: true,
}
const batch: BatchInput = {
  lot_id: id, receipt_reference: 'REC-001', received_on: '2026-10-01', expires_on: '2027-10-01',
  retest_on: '2027-01-01', test_number: 'RP26-001', quality_status: 'PENDING', decision_on: null,
  quality_reason: '최초 등록', notes: '',
}

describe('inventory input validation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-30T14:59:59Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('preserves leading-zero identifiers and normalizes optional blank fields', () => {
    const parsed = materialInputSchema.parse({ ...material, code: ' 001234 ', name: ' Acetone ', package_size: ' ', package_unit: '', density: '', aliases: [' AC ', 'AC'] })
    expect(parsed).toMatchObject({ code: '001234', name: 'Acetone', package_size: null, package_unit: null, density: null, aliases: ['AC'] })
    expect(lotInputSchema.parse({ material_id: id, lot_number: '000045', manufacturer: '', manufactured_on: ' ', notes: '' }).lot_number).toBe('000045')
  })

  it.each(['2025-02-29', '2024-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-1', '2200-01-01', '1899-12-31', '2026-01-01T12:00:00Z'])('rejects invalid calendar date %s', (value) => {
    expect(isCalendarDate(value)).toBe(false)
    expect(batchInputSchema.safeParse({ ...batch, received_on: value }).success).toBe(false)
  })

  it.each(['2024-02-29', '1900-01-01', '2199-12-31'])('accepts real supported calendar date %s', (value) => {
    expect(isCalendarDate(value)).toBe(true)
  })

  it.each(['expires_on', 'retest_on', 'decision_on'])('rejects %s before receipt date', (field) => {
    expect(batchInputSchema.safeParse({ ...batch, [field]: '2026-09-30' }).success).toBe(false)
  })

  it.each(['received_on', 'decision_on'] as const)('rejects future %s using the Seoul calendar day', (field) => {
    const parsed = batchInputSchema.safeParse({ ...batch, [field]: '2026-10-31' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues.some(issue => issue.path[0] === field)).toBe(true)
    // The UTC day is unchanged, but it is now midnight on October 31 in Korea.
    vi.setSystemTime(new Date('2026-10-30T15:00:00Z'))
    expect(batchInputSchema.safeParse({ ...batch, [field]: '2026-10-31' }).success).toBe(true)
  })

  it('allows current receipt/decision dates, future expiry/retest dates and blank decision dates', () => {
    expect(batchInputSchema.safeParse({ ...batch, received_on: '2026-10-30', decision_on: '2026-10-30', expires_on: '2028-10-30', retest_on: '2027-10-30' }).success).toBe(true)
    expect(batchInputSchema.parse({ ...batch, decision_on: '' }).decision_on).toBeNull()
  })

  it.each([-1, NaN, Infinity, 1_000_000_000, 0.0000001, 12.1234567, '', true, '1e3', '1,000'])('rejects an invalid quantity %s', (value) => {
    expect(materialInputSchema.safeParse({ ...material, min_stock: value }).success).toBe(false)
  })

  it.each([0, 0.000001, 100.123456, 999_999_999, '0.790000'])('accepts supported decimal quantities %s', (value) => {
    expect(materialInputSchema.safeParse({ ...material, min_stock: value }).success).toBe(true)
  })

  it('requires matching package quantity/unit and positive density', () => {
    expect(materialInputSchema.safeParse({ ...material, package_unit: null }).success).toBe(false)
    expect(materialInputSchema.safeParse({ ...material, package_size: null }).success).toBe(false)
    expect(materialInputSchema.safeParse({ ...material, density: 0 }).success).toBe(false)
    expect(materialInputSchema.safeParse({ ...material, base_unit: 'ton' }).success).toBe(false)
  })

  it('rejects incomplete updates, invalid parent references, unknown properties and direct balance changes', () => {
    expect(materialInputSchema.safeParse({ name: 'Changed' }).success).toBe(false)
    expect(materialInputSchema.safeParse({ ...material, on_hand: 200 }).success).toBe(false)
    expect(batchInputSchema.safeParse({ ...batch, quality_status: 'EXPIRED' }).success).toBe(false)
    expect(batchInputSchema.safeParse({ ...batch, quality_reason: ' ' }).success).toBe(false)
    expect(locationInputSchema.safeParse({ warehouse_id: 'arbitrary', code: 'A-01', name: '선반', is_active: true }).success).toBe(false)
  })
})

describe('inventory query validation and safe search', () => {
  it('defaults filters and validates one-based pagination', () => {
    expect(materialQuerySchema.parse({})).toEqual({ q: '', active: 'all', page: 1, pageSize: 20 })
    expect(inventoryQuerySchema.parse({ retest: 'true', expiry: 'false', status: 'EXPIRED', material_id: '' })).toMatchObject({ retest: true, expiry: false, low_stock: false, status: 'EXPIRED', material_id: undefined })
    expect(summaryQuerySchema.parse({ low_stock: 'true' }).low_stock).toBe(true)
  })

  it.each([{ page: '0' }, { page: '-1' }, { page: '1.2' }, { pageSize: '101' }, { page: ['1', '2'] }, { page: '1e2' }, { unexpected: 'value' }, { active: 'yes' }])('rejects ambiguous or unsupported query inputs %s', (input) => {
    expect(materialQuerySchema.safeParse(input).success).toBe(false)
  })

  it('treats search metacharacters as literal text', () => {
    expect(literalSearch('50%_\\,(id.eq.1)')).toBe('%50\\%\\_\\\\,(id.eq.1)%')
  })

  it('returns only safe validation metadata', () => {
    expect(() => parseInventoryInput(materialInputSchema, { ...material, on_hand: 100 })).toThrow('입력값을 확인해 주세요.')
  })

  it('applies filters directly and uses a stable page range', async () => {
    const request = {
      select: vi.fn().mockReturnThis(), ilike: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(), range: vi.fn().mockResolvedValue({ data: [], count: 25, error: null }),
    }
    const client = { from: vi.fn().mockReturnValue(request) } as unknown as SupabaseServerClient
    const response = await listMaterials(client, materialQuerySchema.parse({ q: 'AC,(id.eq.1)%', active: 'false', page: '2', pageSize: '10' }))
    expect(request.ilike).toHaveBeenCalledWith('search_text', '%AC,(id.eq.1)\\%%')
    expect(request.eq).toHaveBeenCalledWith('is_active', false)
    expect(request.range).toHaveBeenCalledWith(10, 19)
    expect(request.order.mock.calls).toEqual([['code'], ['id']])
    expect(response).toEqual({ items: [], total: 25, page: 2, pageSize: 10 })

    await listInventory(client, inventoryQuerySchema.parse({ material_id: id, warehouse_id: id, location_id: id, status: 'EXPIRED', retest: 'true', expiry: 'true', low_stock: 'true', manufacturer: 'A%' }))
    expect(request.eq).toHaveBeenCalledWith('effective_status', 'EXPIRED')
    expect(request.eq).toHaveBeenCalledWith('material_id', id)
    expect(request.eq).toHaveBeenCalledWith('warehouse_id', id)
    expect(request.eq).toHaveBeenCalledWith('location_id', id)
    expect(request.eq).toHaveBeenCalledWith('retest_due', true)
    expect(request.eq).toHaveBeenCalledWith('expiry_due', true)
    expect(request.eq).toHaveBeenCalledWith('is_low_stock', true)
    expect(request.ilike).toHaveBeenCalledWith('manufacturer', '%A\\%%')
  })
})

describe('safe database errors and CSV exports', () => {
  it('explains why an established material unit cannot change', () => {
    expect(() => throwInventoryError({ code: '23503', message: 'Base unit cannot change after LOT registration' })).toThrow('LOT가 등록된 원료의 기본단위는 변경할 수 없습니다.')
  })
  it.each([['23505', 409], ['23503', 409], ['23001', 409], ['23514', 400], ['42501', 403], ['PGRST116', 404], ['PGRST103', 400], ['connection_error', 503]])('maps database code %s without leaking internal SQL', (code, expectedStatus) => {
    try {
      throwInventoryError({ code, message: 'sensitive database detail' })
    }
    catch (error) {
      expect(error).toMatchObject({ statusCode: expectedStatus })
      expect((error as Error).message).not.toContain('sensitive database detail')
    }
  })

  it.each(['=1+1', '+cmd', '-cmd', '@SUM(A1)', '  =HYPERLINK("bad")', '\tformula', '\rformula', '\nformula'])('neutralizes spreadsheet formula prefix %s', (value) => {
    expect(csvCell(value).startsWith('"\'')).toBe(true)
  })

  it('exports escaped quotes/newlines with UTF-8 BOM and nullable fields', () => {
    expect(buildCsv([{ key: 'name', label: '원료명' }], [{ name: 'A,"B"\nC' }])).toBe('\uFEFF"원료명"\r\n"A,""B""\nC"\r\n')
    expect(csvCell(null)).toBe('""')
  })

  it('fetches every page and rejects excessive or truncated exports', async () => {
    const fetchPage = vi.fn(async (page: number, pageSize: number) => ({ items: Array.from({ length: page === 1 ? 1000 : 1 }, (_, index) => (page - 1) * pageSize + index), total: 1001, page, pageSize }))
    expect(await collectExportRows(fetchPage)).toHaveLength(1001)
    expect(fetchPage.mock.calls).toEqual([[1, 1000], [2, 1000]])
    await expect(collectExportRows(async (page, pageSize) => ({ items: [], total: 10001, page, pageSize }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(collectExportRows(async (page, pageSize) => ({ items: [1], total: 100, page, pageSize }))).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('API authorization and mutation boundaries', () => {
  beforeEach(() => {
    vi.mocked(requirePermission).mockReset()
    vi.mocked(createSupabaseServerClient).mockReset()
  })

  function api() {
    const read = vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 }))
    const create = vi.fn(async (_client: SupabaseServerClient, input: MaterialInput) => input)
    const update = vi.fn(async (_client: SupabaseServerClient, _id: string, input: MaterialInput) => input)
    const remove = vi.fn(async () => ({ ok: true }))
    const router = createRouter()
      .get('/materials', inventoryListHandler(materialQuerySchema, read))
      .post('/materials', inventoryCreateHandler(materialInputSchema, create))
      .patch('/materials/:id', inventoryUpdateHandler(materialInputSchema, update))
      .delete('/materials/:id', inventoryDeleteHandler(remove))
    const handle = toWebHandler(createApp().use(router))
    const request = (path: string, init?: RequestInit) => handle(new Request(`http://localhost${path}`, init))
    return { request, read, create, update, remove }
  }

  it('checks read permission before data access', async () => {
    vi.mocked(requirePermission).mockRejectedValue(createError({ statusCode: 401, message: '로그인이 필요합니다.' }))
    const { request, read } = api()
    expect((await request('/materials')).status).toBe(401)
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), 'inventory:read')
    expect(read).not.toHaveBeenCalled()
    expect(createSupabaseServerClient).not.toHaveBeenCalled()
  })

  it('requires same-origin JSON and administrator permission before creation', async () => {
    const { request, create } = api()
    expect((await request('/materials', { method: 'POST', body: JSON.stringify(material), headers: { 'Content-Type': 'application/json' } })).status).toBe(403)
    expect(requirePermission).not.toHaveBeenCalled()
    vi.mocked(requirePermission).mockRejectedValue(createError({ statusCode: 403, message: '관리자 권한이 필요합니다.' }))
    expect((await request('/materials', { method: 'POST', body: JSON.stringify(material), headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' } })).status).toBe(403)
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), 'materials:manage')
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects unsupported content and partial PATCH without calling a mutation', async () => {
    const { request, create, update } = api()
    expect((await request('/materials', { method: 'POST', body: 'plain', headers: { Origin: 'http://localhost', 'Content-Type': 'text/plain' } })).status).toBe(415)
    expect((await request(`/materials/${id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Only one field' }), headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' } })).status).toBe(400)
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('uses validated fields for allowed creation and rejects cross-site deletion', async () => {
    const { request, create, remove } = api()
    expect((await request('/materials', { method: 'POST', body: JSON.stringify(material), headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' } })).status).toBe(201)
    expect(create).toHaveBeenCalledWith(undefined, material)
    expect((await request(`/materials/${id}`, { method: 'DELETE', headers: { Origin: 'https://foreign.example' } })).status).toBe(403)
    expect(remove).not.toHaveBeenCalled()
  })
})
