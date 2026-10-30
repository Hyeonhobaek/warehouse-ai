import { createError, defineEventHandler, getHeader, getQuery, getRouterParam, readBody, setResponseHeaders, setResponseStatus, type H3Event } from 'h3'
import type { z } from 'zod'
import { inventoryIdSchema, type BatchQuery, type InventoryQuery, type LocationQuery, type LotQuery, type MaterialQuery, type SummaryQuery, type WarehouseQuery } from '../../shared/schemas/inventory'
import type { BatchInput, InventoryResponse, InventoryRow, LocationInput, LotInput, Material, MaterialInput, MaterialLot, MaterialStockSummary, Paginated, QualityHistory, StockBatch, StorageLocation, Warehouse, WarehouseInput } from '../../shared/types/inventory'
import { requirePermission } from './auth'
import { requireSameOrigin } from '../utils/request-security'
import { createSupabaseServerClient, type SupabaseServerClient } from '../utils/supabase'

const materialColumns = 'id,code,name,aliases,specification,manufacturer,base_unit,min_stock,storage_condition,package_size,package_unit,density,is_active,created_at,updated_at'
type DatabaseError = { code?: string; message?: string }

/** Do not expose database constraint names, raw SQL, or connection details to clients. */
export function throwInventoryError(error: DatabaseError): never {
  if (error.code === 'PGRST103') {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '요청한 페이지가 조회 범위를 벗어났습니다. 검색 조건을 다시 적용해 주세요.' })
  }
  if (error.code === '23503' && error.message === 'Base unit cannot change after LOT registration') {
    throw createError({ statusCode: 409, statusMessage: 'Conflict', message: 'LOT가 등록된 원료의 기본단위는 변경할 수 없습니다.' })
  }
  if (error.code === '23505') {
    throw createError({ statusCode: 409, statusMessage: 'Conflict', message: '이미 등록된 코드 또는 번호입니다. 기존 정보를 확인해 주세요.' })
  }
  if (error.code === '23503' || error.code === '23001') {
    throw createError({ statusCode: 409, statusMessage: 'Conflict', message: '연결된 정보가 있거나 대상 정보가 없습니다. 사용 이력이 있는 원료는 사용 중지해 주세요.' })
  }
  if (error.code === '23514' || error.code === 'P0001' || error.code === '22003' || error.code === '22007' || error.code === '22008' || error.code === '22P02') {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '입력 조건을 확인해 주세요. 연결된 원료·LOT·창고는 변경할 수 없으며 날짜·수량·품질 변경 사유가 올바르게 입력되어야 합니다.' })
  }
  if (error.code === '42501') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: '이 작업을 수행할 권한이 없습니다.' })
  }
  if (error.code === 'PGRST116') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found', message: '요청한 정보를 찾을 수 없습니다.' })
  }
  throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: '재고 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' })
}

function result<T>(response: { data: T | null; error: DatabaseError | null }): T {
  if (response.error) throwInventoryError(response.error)
  if (response.data === null) throwInventoryError({ code: 'PGRST116' })
  return response.data
}

function page<T>(response: { data: T[] | null; error: DatabaseError | null; count: number | null }, query: { page: number; pageSize: number }): Paginated<T> {
  return { items: result(response), total: response.count ?? 0, page: query.page, pageSize: query.pageSize }
}

function bounds(query: { page: number; pageSize: number }): [number, number] {
  const start = (query.page - 1) * query.pageSize
  return [start, start + query.pageSize - 1]
}

/** Escape LIKE metacharacters; use .ilike directly, never interpolate into PostgREST .or syntax. */
export function literalSearch(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`
}

export async function listMaterials(client: SupabaseServerClient, query: MaterialQuery): Promise<Paginated<Material>> {
  let request = client.from('materials').select(materialColumns, { count: 'exact' })
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  if (query.active !== 'all') request = request.eq('is_active', query.active === 'true')
  return page(await request.order('code').order('id').range(...bounds(query)), query)
}

export async function getMaterial(client: SupabaseServerClient, id: string): Promise<Material> {
  return result(await client.from('materials').select(materialColumns).eq('id', id).maybeSingle())
}

export async function createMaterial(client: SupabaseServerClient, input: MaterialInput): Promise<Material> {
  return result(await client.from('materials').insert(input).select(materialColumns).single())
}

export async function updateMaterial(client: SupabaseServerClient, id: string, input: MaterialInput): Promise<Material> {
  return result(await client.from('materials').update(input).eq('id', id).select(materialColumns).maybeSingle())
}

export async function deleteMaterial(client: SupabaseServerClient, id: string): Promise<{ ok: true }> {
  result(await client.from('materials').delete().eq('id', id).select('id').maybeSingle())
  return { ok: true }
}

export async function listLots(client: SupabaseServerClient, query: LotQuery): Promise<Paginated<MaterialLot>> {
  let request = client.from('material_lots').select('*', { count: 'exact' })
  if (query.material_id) request = request.eq('material_id', query.material_id)
  if (query.q) request = request.ilike('lot_number', literalSearch(query.q))
  return page(await request.order('lot_number').order('id').range(...bounds(query)), query)
}

export async function createLot(client: SupabaseServerClient, input: LotInput): Promise<MaterialLot> {
  return result(await client.from('material_lots').insert(input).select('*').single())
}

export async function updateLot(client: SupabaseServerClient, id: string, input: LotInput): Promise<MaterialLot> {
  return result(await client.from('material_lots').update(input).eq('id', id).select('*').maybeSingle())
}

export async function listBatches(client: SupabaseServerClient, query: BatchQuery): Promise<Paginated<StockBatch>> {
  let request = client.from('stock_batches').select('*', { count: 'exact' })
  if (query.lot_id) request = request.eq('lot_id', query.lot_id)
  return page(await request.order('received_on', { ascending: false }).order('id').range(...bounds(query)), query)
}

export async function createBatch(client: SupabaseServerClient, input: BatchInput): Promise<StockBatch> {
  return result(await client.from('stock_batches').insert(input).select('*').single())
}

export async function updateBatch(client: SupabaseServerClient, id: string, input: BatchInput): Promise<StockBatch> {
  return result(await client.from('stock_batches').update(input).eq('id', id).select('*').maybeSingle())
}

export async function batchHistory(client: SupabaseServerClient, id: string): Promise<QualityHistory[]> {
  result(await client.from('stock_batches').select('id').eq('id', id).maybeSingle())
  return result(await client.from('stock_batch_quality_history').select('*').eq('batch_id', id).order('created_at', { ascending: false }).order('id'))
}

export async function listWarehouses(client: SupabaseServerClient, query: WarehouseQuery): Promise<Paginated<Warehouse>> {
  let request = client.from('warehouses').select('*', { count: 'exact' })
  if (query.q) request = request.ilike('name', literalSearch(query.q))
  return page(await request.order('code').order('id').range(...bounds(query)), query)
}

export async function createWarehouse(client: SupabaseServerClient, input: WarehouseInput): Promise<Warehouse> {
  return result(await client.from('warehouses').insert(input).select('*').single())
}

export async function updateWarehouse(client: SupabaseServerClient, id: string, input: WarehouseInput): Promise<Warehouse> {
  return result(await client.from('warehouses').update(input).eq('id', id).select('*').maybeSingle())
}

export async function listLocations(client: SupabaseServerClient, query: LocationQuery): Promise<Paginated<StorageLocation>> {
  let request = client.from('storage_locations').select('*', { count: 'exact' })
  if (query.warehouse_id) request = request.eq('warehouse_id', query.warehouse_id)
  if (query.q) request = request.ilike('name', literalSearch(query.q))
  return page(await request.order('code').order('id').range(...bounds(query)), query)
}

export async function createLocation(client: SupabaseServerClient, input: LocationInput): Promise<StorageLocation> {
  return result(await client.from('storage_locations').insert(input).select('*').single())
}

export async function updateLocation(client: SupabaseServerClient, id: string, input: LocationInput): Promise<StorageLocation> {
  return result(await client.from('storage_locations').update(input).eq('id', id).select('*').maybeSingle())
}

export async function listInventory(client: SupabaseServerClient, query: InventoryQuery): Promise<InventoryResponse> {
  let request = client.from('inventory_rows').select('*', { count: 'exact' })
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  if (query.material_id) request = request.eq('material_id', query.material_id)
  if (query.manufacturer) request = request.ilike('manufacturer', literalSearch(query.manufacturer))
  if (query.warehouse_id) request = request.eq('warehouse_id', query.warehouse_id)
  if (query.location_id) request = request.eq('location_id', query.location_id)
  if (query.status) request = request.eq('effective_status', query.status)
  if (query.retest) request = request.eq('retest_due', true)
  if (query.expiry) request = request.eq('expiry_due', true)
  if (query.low_stock) request = request.eq('is_low_stock', true)
  return {
    ...page(await request.order('material_code').order('lot_number').order('received_on').order('id').range(...bounds(query)), query),
    asOf: new Date().toISOString(),
  }
}

export async function listMaterialStockSummary(client: SupabaseServerClient, query: SummaryQuery): Promise<Paginated<MaterialStockSummary>> {
  let request = client.from('material_stock_summary').select('*', { count: 'exact' })
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  if (query.low_stock) request = request.eq('is_low_stock', true)
  return page(await request.order('material_code').order('material_id').range(...bounds(query)), query)
}

export function parseInventoryInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '입력값을 확인해 주세요.', data: { fields: parsed.error.flatten().fieldErrors } })
  }
  return parsed.data
}

function routeId(event: H3Event): string {
  return parseInventoryInput(inventoryIdSchema, getRouterParam(event, 'id'))
}

async function mutationClient(event: H3Event): Promise<SupabaseServerClient> {
  requireSameOrigin(event)
  await requirePermission(event, 'materials:manage')
  return createSupabaseServerClient(event)
}

async function mutationBody<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  if (getHeader(event, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw createError({ statusCode: 415, statusMessage: 'Unsupported Media Type', message: 'JSON 요청이 필요합니다.' })
  }
  if (Number(getHeader(event, 'content-length') || 0) > 32_768) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: '요청 데이터가 너무 큽니다.' })
  }
  return parseInventoryInput(schema, await readBody(event, { strict: true }))
}

export function inventoryListHandler<Q, T>(schema: z.ZodType<Q>, handler: (client: SupabaseServerClient, query: Q) => Promise<T>) {
  return defineEventHandler(async (event) => {
    await requirePermission(event, 'inventory:read')
    return handler(createSupabaseServerClient(event), parseInventoryInput(schema, getQuery(event)))
  })
}

export function inventoryDetailHandler<T>(handler: (client: SupabaseServerClient, id: string) => Promise<T>) {
  return defineEventHandler(async (event) => {
    await requirePermission(event, 'inventory:read')
    return handler(createSupabaseServerClient(event), routeId(event))
  })
}

export function inventoryCreateHandler<I, T>(schema: z.ZodType<I>, handler: (client: SupabaseServerClient, input: I) => Promise<T>) {
  return defineEventHandler(async (event) => {
    const client = await mutationClient(event)
    const created = await handler(client, await mutationBody(event, schema))
    setResponseStatus(event, 201)
    return created
  })
}

export function inventoryUpdateHandler<I, T>(schema: z.ZodType<I>, handler: (client: SupabaseServerClient, id: string, input: I) => Promise<T>) {
  return defineEventHandler(async (event) => {
    const client = await mutationClient(event)
    return handler(client, routeId(event), await mutationBody(event, schema))
  })
}

export function inventoryDeleteHandler<T>(handler: (client: SupabaseServerClient, id: string) => Promise<T>) {
  return defineEventHandler(async (event) => handler(await mutationClient(event), routeId(event)))
}

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : Array.isArray(value) ? value.join(' | ') : String(value)
  // Spreadsheet apps may interpret formulas even after leading whitespace or control characters.
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

export function buildCsv<T>(columns: readonly { key: keyof T; label: string }[], rows: T[]): string {
  return `\uFEFF${[columns.map(column => csvCell(column.label)).join(','), ...rows.map(row => columns.map(column => csvCell(row[column.key])).join(','))].join('\r\n')}\r\n`
}

const materialCsvColumns: readonly { key: keyof Material; label: string }[] = [
  { key: 'code', label: '원료코드' }, { key: 'name', label: '원료명' }, { key: 'aliases', label: '약어·별칭' },
  { key: 'specification', label: '규격' }, { key: 'manufacturer', label: '제조사' }, { key: 'base_unit', label: '기본단위' },
  { key: 'min_stock', label: '최소재고' }, { key: 'storage_condition', label: '보관조건' },
  { key: 'package_size', label: '포장당 수량' }, { key: 'package_unit', label: '포장단위' },
  { key: 'density', label: '밀도(kg/L)' }, { key: 'is_active', label: '사용상태' },
]
const inventoryCsvColumns: readonly { key: keyof InventoryRow; label: string }[] = [
  { key: 'material_code', label: '원료코드' }, { key: 'material_name', label: '원료명' },
  { key: 'lot_number', label: '제조번호' }, { key: 'receipt_reference', label: '입고 참조번호' },
  { key: 'received_on', label: '입고일' }, { key: 'test_number', label: '시험번호' }, { key: 'manufacturer', label: '제조사' },
  { key: 'warehouse_name', label: '창고' }, { key: 'location_name', label: '보관위치' },
  { key: 'quality_status', label: 'QC 판정' }, { key: 'effective_status', label: '현재 품질상태' },
  { key: 'availability_reason', label: '사용불가 사유 코드' },
  { key: 'expires_on', label: '유효기간' }, { key: 'retest_on', label: '재시험일' },
  { key: 'on_hand', label: '현재고' }, { key: 'reserved', label: '예약수량' }, { key: 'available', label: '가용재고' },
  { key: 'unavailable', label: '사용불가재고' }, { key: 'base_unit', label: '기본단위' },
]

/** Fetch in batches because PostgREST may cap each response at 1,000 rows. Never silently truncate. */
export async function collectExportRows<T>(fetchPage: (page: number, pageSize: number) => Promise<Paginated<T>>): Promise<T[]> {
  const rows: T[] = []
  let expected = 0
  for (let current = 1; current <= 10; current++) {
    const response = await fetchPage(current, 1000)
    if (response.total > 10_000) {
      throw createError({ statusCode: 422, statusMessage: 'Unprocessable Entity', message: '내보내기는 최대 10,000건입니다. 검색 조건을 좁혀 주세요.' })
    }
    expected = response.total
    rows.push(...response.items)
    if (rows.length >= expected) return rows
    if (response.items.length < 1000) break
  }
  throw createError({ statusCode: 409, statusMessage: 'Conflict', message: '내보내기 중 데이터 범위가 변경되었거나 응답이 제한되었습니다. 다시 시도해 주세요.' })
}

export function inventoryExportHandler<Q extends { page: number; pageSize: number }, T>(
  schema: z.ZodType<Q>, handler: (client: SupabaseServerClient, query: Q) => Promise<Paginated<T>>,
  columns: readonly { key: keyof T; label: string }[], filename: string,
) {
  return defineEventHandler(async (event) => {
    await requirePermission(event, 'inventory:read')
    const query = parseInventoryInput(schema, getQuery(event))
    const client = createSupabaseServerClient(event)
    const rows = await collectExportRows((page, pageSize) => handler(client, { ...query, page, pageSize }))
    setResponseHeaders(event, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}.csv"` })
    return buildCsv(columns, rows)
  })
}

export { materialCsvColumns, inventoryCsvColumns }
