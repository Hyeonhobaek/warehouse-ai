import { createError, defineEventHandler, getHeader, getQuery, getRouterParam, readBody, setResponseStatus } from 'h3'
import type { z } from 'zod'
import { inventoryIdSchema } from '../../shared/schemas/inventory'
import type { IssueInput, IssuePreviewQuery, PendingReturnQuery, ReceiptInput, ReleaseReturnInput, ReturnableQuery, ReturnInput, TransactionBatchQuery, TransactionQuery } from '../../shared/schemas/transactions'
import type { Paginated } from '../../shared/types/inventory'
import type { IssuePreview, StockLedgerRow, StockOperation, TransactionBatch, TransactionResult } from '../../shared/types/transactions'
import type { Permission } from '../../shared/utils/permissions'
import { requirePermission } from './auth'
import { literalSearch, parseInventoryInput, throwInventoryError } from './inventory'
import { requireSameOrigin } from '../utils/request-security'
import { createSupabaseServerClient, type SupabaseServerClient } from '../utils/supabase'

type DatabaseError = { code?: string; message?: string }

/** Only known, stable database error tokens can influence the public error message. */
export const transactionErrors: Readonly<Record<string, { status: number; message: string }>> = {
  'Issue purpose must be GENERAL or CLEANING': { status: 400, message: '일반 또는 세척 출고를 선택해 주세요.' },
  'Cleaning issues must use positive multiples of 18 L': { status: 400, message: '세척 출고는 L 단위로 18의 배수를 입력해 주세요. 예: 18, 36, 54L' },
  'Cleaning is not supported for EA materials': { status: 400, message: '개수(EA) 단위 원료는 세척 출고로 처리할 수 없습니다.' },
  'Insufficient available stock; entire issue cancelled': { status: 409, message: '사용 가능한 재고가 부족합니다. 요청 전체가 취소되었습니다. 재고를 새로 확인해 주세요.' },
  'Request key already used with different input': { status: 409, message: '이미 처리된 요청과 입력 내용이 다릅니다. 거래 이력을 확인해 주세요.' },
  'Return exceeds original issued quantity remaining': { status: 409, message: '반납할 수 있는 불출 잔량을 초과했습니다.' },
  'Release exceeds held return quantity remaining': { status: 409, message: '보류 해제할 수 있는 반납 잔량을 초과했습니다.' },
  'Verified material density is required for mass/volume conversion': { status: 400, message: '질량과 부피를 변환하려면 원료에 확인된 밀도(kg/L)를 등록해야 합니다.' },
  'EA cannot be converted to mass or volume': { status: 400, message: 'EA 수량은 질량·부피 단위로 변환할 수 없습니다.' },
  'Converted quantity is below precision or outside range': { status: 400, message: '기본단위로 환산한 수량이 저장 범위를 벗어납니다. 소수점 이하 6자리에서 0이 되는 수량은 등록할 수 없습니다.' },
  'Active material is required': { status: 409, message: '사용 중지되었거나 존재하지 않는 원료는 처리할 수 없습니다.' },
  'Active storage location and warehouse are required': { status: 409, message: '사용 가능한 창고와 보관위치를 선택해 주세요.' },
  'Active warehouse is required': { status: 409, message: '운영 중인 창고를 선택해 주세요.' },
  'Existing LOT metadata differs; review LOT before receiving': { status: 409, message: '기존 LOT의 제조사 또는 제조일과 다릅니다. 원료 관리에서 확인해 주세요.' },
  'Returned stock is not eligible for release': { status: 409, message: '현재 원료·위치·품질·유효기간 조건상 반납 재고의 보류를 해제할 수 없습니다.' },
  'Transaction date precedes latest balance transaction': { status: 400, message: '해당 재고에 더 늦은 거래가 있습니다. 마지막 거래일 이후로 처리일을 입력해 주세요.' },
  'Returns must use material base unit': { status: 400, message: '반납 수량은 원료의 기본단위로 입력해 주세요.' },
  'Releases must use material base unit': { status: 400, message: '보류 해제 수량은 원료의 기본단위로 입력해 주세요.' },
}

export function throwTransactionError(error: DatabaseError): never {
  const known = error.message ? transactionErrors[error.message] : undefined
  if (known) throw createError({ statusCode: known.status, message: known.message })
  if (error.code === '22023') {
    throw createError({ statusCode: 400, message: '처리일·수량·단위·재고 상태를 확인해 주세요. 처리일은 해당 재고의 마지막 거래일 이후여야 하며 반납·보류 해제는 기본단위로 입력해야 합니다.' })
  }
  if (error.code === '40001' || error.code === '40P01' || error.code === '55P03' || error.code === '57014') {
    throw createError({ statusCode: 409, statusMessage: 'Conflict', message: '다른 작업이 재고를 처리 중입니다. 같은 요청으로 다시 시도해 주세요.' })
  }
  throwInventoryError(error)
}

function result<T>(response: { data: T | null; error: DatabaseError | null }): T {
  if (response.error) throwTransactionError(response.error)
  if (response.data === null) throwInventoryError({ code: 'PGRST116' })
  return response.data
}

function bounds(query: { page: number; pageSize: number }): [number, number] {
  const start = (query.page - 1) * query.pageSize
  return [start, start + query.pageSize - 1]
}

function page<T>(response: { data: T[] | null; error: DatabaseError | null; count: number | null }, query: { page: number; pageSize: number }): Paginated<T> {
  return { items: result(response), total: response.count ?? 0, page: query.page, pageSize: query.pageSize }
}

export async function receiveStock(client: SupabaseServerClient, input: ReceiptInput): Promise<TransactionResult> {
  return result(await client.rpc('stock_receive', { p_input: input }))
}

export async function issueStock(client: SupabaseServerClient, input: IssueInput): Promise<TransactionResult> {
  return result(await client.rpc('stock_issue', { p_input: input }))
}

export async function returnStock(client: SupabaseServerClient, input: ReturnInput): Promise<TransactionResult> {
  return result(await client.rpc('stock_return', { p_input: input }))
}

export async function releaseReturnedStock(client: SupabaseServerClient, input: ReleaseReturnInput): Promise<TransactionResult> {
  return result(await client.rpc('stock_release_return', { p_input: input }))
}

export async function previewIssue(client: SupabaseServerClient, input: IssuePreviewQuery): Promise<IssuePreview> {
  return result(await client.rpc('stock_preview_issue', { p_input: input }))
}

export async function listTransactions(client: SupabaseServerClient, query: TransactionQuery): Promise<Paginated<StockLedgerRow>> {
  let request = client.from('stock_ledger_rows').select('*', { count: 'exact' })
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  if (query.material_id) request = request.eq('material_id', query.material_id)
  if (query.batch_id) request = request.eq('batch_id', query.batch_id)
  if (query.type) request = request.eq('kind', query.type)
  if (query.from) request = request.gte('occurred_on', query.from)
  if (query.to) request = request.lte('occurred_on', query.to)
  // Business date then actual processing time, and sequence for a stable FIFO split display.
  return page(await request.order('occurred_on').order('created_at').order('operation_id').order('sequence').order('id').range(...bounds(query)), query)
}

export async function listTransactionBatches(client: SupabaseServerClient, query: TransactionBatchQuery): Promise<Paginated<TransactionBatch>> {
  let request = client.from('stock_batch_options').select('*', { count: 'exact' })
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  if (query.material_id) request = request.eq('material_id', query.material_id)
  if (query.batch_id) request = request.eq('batch_id', query.batch_id)
  return page(await request.order('received_on').order('batch_id').range(...bounds(query)), query)
}

export async function listReturnableLines(client: SupabaseServerClient, query: ReturnableQuery): Promise<Paginated<StockLedgerRow>> {
  let request = client.from('stock_ledger_rows').select('*', { count: 'exact' }).eq('kind', 'ISSUE').gt('returnable_quantity', 0)
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  if (query.material_id) request = request.eq('material_id', query.material_id)
  return page(await request.order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).order('sequence').order('id').range(...bounds(query)), query)
}

export async function listPendingReturns(client: SupabaseServerClient, query: PendingReturnQuery): Promise<Paginated<StockLedgerRow>> {
  let request = client.from('stock_ledger_rows').select('*', { count: 'exact' }).eq('kind', 'RETURN').gt('releasable_quantity', 0)
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  if (query.material_id) request = request.eq('material_id', query.material_id)
  return page(await request.order('occurred_on').order('created_at').order('id').range(...bounds(query)), query)
}

const operationColumns = 'id,request_key,kind,issue_purpose,material_id,occurred_on,input_quantity,input_unit,quantity,base_unit,density_snapshot,production_item,production_batch,reason,notes,actor_id,actor_name,created_at'

export async function getTransaction(client: SupabaseServerClient, id: string): Promise<TransactionResult> {
  const operation = result<StockOperation>(await client.from('stock_operations').select(operationColumns).eq('id', id).maybeSingle())
  const lines = result(await client.from('stock_transaction_lines').select('*').eq('operation_id', id).order('sequence').order('id'))
  return { operation, lines }
}

export function transactionListHandler<Q, T>(schema: z.ZodType<Q>, handler: (client: SupabaseServerClient, query: Q) => Promise<T>) {
  return defineEventHandler(async (event) => {
    await requirePermission(event, 'inventory:read')
    const input = parseInventoryInput(schema, getQuery(event))
    return handler(createSupabaseServerClient(event), input)
  })
}

export function transactionDetailHandler() {
  return defineEventHandler(async (event) => {
    await requirePermission(event, 'inventory:read')
    const id = parseInventoryInput(inventoryIdSchema, getRouterParam(event, 'id'))
    return getTransaction(createSupabaseServerClient(event), id)
  })
}

export function transactionMutationHandler<I>(schema: z.ZodType<I>, handler: (client: SupabaseServerClient, input: I) => Promise<TransactionResult>, permission: Permission = 'inventory:write') {
  return defineEventHandler(async (event) => {
    requireSameOrigin(event)
    await requirePermission(event, permission)
    if (getHeader(event, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw createError({ statusCode: 415, message: 'JSON 요청이 필요합니다.' })
    }
    if (Number(getHeader(event, 'content-length') || 0) > 32_768) {
      throw createError({ statusCode: 413, message: '요청 데이터가 너무 큽니다.' })
    }
    const input = parseInventoryInput(schema, await readBody(event, { strict: true }))
    const response = await handler(createSupabaseServerClient(event), input)
    setResponseStatus(event, 201)
    return response
  })
}
