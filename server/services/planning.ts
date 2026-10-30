import { createError, defineEventHandler, getHeader, getRouterParam, readBody, setResponseStatus } from 'h3'
import type { z } from 'zod'
import { inventoryIdSchema } from '../../shared/schemas/inventory'
import type { BomInput, BomQuery, PlanIssueInput, PlanQuery, ScheduleInput, ScheduleQuery } from '../../shared/schemas/planning'
import type { Paginated } from '../../shared/types/inventory'
import type { BomRecipe, IssuePlanRow, ScheduleResult, ScheduleRow } from '../../shared/types/planning'
import type { TransactionResult } from '../../shared/types/transactions'
import type { Permission } from '../../shared/utils/permissions'
import { requirePermission } from './auth'
import { literalSearch, parseInventoryInput } from './inventory'
import { throwTransactionError, transactionErrors } from './transactions'
import { requireSameOrigin } from '../utils/request-security'
import { createSupabaseServerClient, type SupabaseServerClient } from '../utils/supabase'

const errors: Record<string, { status: number; message: string }> = {
  'Active BOM is required': { status: 409, message: '현재 사용 중인 BOM을 선택해 주세요.' },
  'Cleaning plan quantity must be an exact multiple of 18 L': { status: 400, message: '세척 예정 수량은 생산 배수 적용 후에도 18L 단위여야 합니다.' },
  'Plan has already been issued with another request key': { status: 409, message: '이미 출고 확정된 예정 내역입니다. 연결된 출고 원장을 확인해 주세요.' },
  'Planning revision conflict': { status: 409, message: '다른 사용자가 변경한 내용이 있습니다. 새로고침한 뒤 다시 확인해 주세요.' },
  'Planning record not found': { status: 404, message: 'BOM 또는 생산일정을 찾을 수 없습니다.' },
  'Planning input is invalid': { status: 400, message: 'BOM·일정 입력값을 확인해 주세요. 세척 예정량은 18L 단위여야 합니다.' },
  'Issued schedule cannot change BOM': { status: 409, message: '이미 출고한 일정의 BOM은 바꿀 수 없습니다. 새 일정으로 등록해 주세요.' },
  'Plan is not available for issue': { status: 409, message: '이미 처리되었거나 취소된 예정 내역입니다. 목록을 새로 확인해 주세요.' },
  'Plan cannot be issued before its planned date': { status: 400, message: '예정일보다 앞서 출고할 수 없습니다. 일정이 바뀌었다면 먼저 생산일정을 수정해 주세요.' },
}
export function throwPlanningError(error: { code?: string; message?: string }): never {
  const known = error.message ? errors[error.message] ?? transactionErrors[error.message] : undefined
  if (known) throw createError({ statusCode: known.status, message: known.message })
  if (error.code === '23505') throw createError({ statusCode: 409, message: '이미 사용한 코드 또는 요청입니다. 기존 내용을 확인해 주세요.' })
  if (error.code === '23514' || error.code === '22023') throw createError({ statusCode: 400, message: '입력값과 현재 계획 상태를 확인해 주세요. 세척 수량은 생산 배수 적용 후에도 18L 단위여야 합니다.' })
  throwTransactionError(error)
}
function result<T>(response: { data: T | null; error: { code?: string; message?: string } | null }): T {
  if (response.error) throwPlanningError(response.error)
  if (response.data === null) throw createError({ statusCode: 404, message: '요청한 항목을 찾을 수 없습니다.' })
  return response.data
}
function page<T>(response: { data: T[] | null; error: { code?: string; message?: string } | null; count: number | null }, query: { page: number; pageSize: number }): Paginated<T> {
  return { items: result(response), total: response.count ?? 0, page: query.page, pageSize: query.pageSize }
}
function bounds(query: { page: number; pageSize: number }): [number, number] {
  return [(query.page - 1) * query.pageSize, query.page * query.pageSize - 1]
}

export async function listBoms(client: SupabaseServerClient, query: BomQuery): Promise<Paginated<BomRecipe>> {
  let request = client.from('bom_recipes').select('*', { count: 'exact' })
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  return page(await request.order('code').order('id').range(...bounds(query)), query)
}
export async function getBom(client: SupabaseServerClient, id: string): Promise<BomRecipe> {
  return result(await client.from('bom_recipes').select('*').eq('id', id).maybeSingle())
}
export async function listSchedules(client: SupabaseServerClient, query: ScheduleQuery): Promise<Paginated<ScheduleRow>> {
  let request = client.from('schedule_rows').select('*', { count: 'exact' })
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  if (query.status) request = request.eq('status', query.status)
  return page(await request.order('scheduled_on', { ascending: false }).order('id').range(...bounds(query)), query)
}
export async function listIssuePlans(client: SupabaseServerClient, query: PlanQuery): Promise<Paginated<IssuePlanRow>> {
  let request = client.from('issue_plan_rows').select('*', { count: 'exact' })
  if (query.q) request = request.ilike('search_text', literalSearch(query.q))
  if (query.schedule_id) request = request.eq('schedule_id', query.schedule_id)
  if (query.status) request = request.eq('status', query.status)
  return page(await request.order('planned_on').order('schedule_id').order('id').range(...bounds(query)), query)
}
export async function saveBom(client: SupabaseServerClient, input: BomInput): Promise<BomRecipe> {
  return result(await client.rpc('planning_save_bom', { p_input: input }))
}
export async function saveSchedule(client: SupabaseServerClient, input: ScheduleInput): Promise<ScheduleResult> {
  return result(await client.rpc('planning_save_schedule', { p_input: input }))
}
export async function issuePlan(client: SupabaseServerClient, input: PlanIssueInput): Promise<TransactionResult> {
  return result(await client.rpc('planning_issue_plan', { p_input: input }))
}
export function planningMutationHandler<I, O>(schema: z.ZodType<I>, handler: (client: SupabaseServerClient, input: I) => Promise<O>, permission: Permission = 'inventory:write') {
  return defineEventHandler(async event => {
    requireSameOrigin(event)
    await requirePermission(event, permission)
    if (getHeader(event, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw createError({ statusCode: 415, message: 'JSON 요청이 필요합니다.' })
    if (Number(getHeader(event, 'content-length') || 0) > 131_072) throw createError({ statusCode: 413, message: '요청 데이터가 너무 큽니다.' })
    const input = parseInventoryInput(schema, await readBody(event, { strict: true }))
    const response = await handler(createSupabaseServerClient(event), input)
    setResponseStatus(event, 200)
    return response
  })
}
export function bomDetailHandler() {
  return defineEventHandler(async event => {
    await requirePermission(event, 'inventory:read')
    return getBom(createSupabaseServerClient(event), parseInventoryInput(inventoryIdSchema, getRouterParam(event, 'id')))
  })
}
