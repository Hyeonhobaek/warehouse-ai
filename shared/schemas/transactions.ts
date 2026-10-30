import { z } from 'zod'
import { calendarDateSchema, inventoryIdSchema } from './inventory'
import { stockUnits } from '../types/inventory'
import { issuePurposes, transactionTypes } from '../types/transactions'

const text = (max: number) => z.string().trim().max(max, `최대 ${max}자까지 입력할 수 있습니다.`)
const reason = text(1000).min(1, '처리 사유를 입력해 주세요.')
const blankToNull = (value: unknown) => value === undefined || (typeof value === 'string' && !value.trim()) ? null : value
const nullableDate = z.preprocess(blankToNull, calendarDateSchema.nullable())
const optionalId = z.preprocess(blankToNull, inventoryIdSchema.nullable())

/** Keep decimal strings intact until PostgreSQL numeric conversion; never compute stock in JS. */
export const transactionQuantitySchema = z.union([z.string(), z.number().finite()])
  .transform(value => String(value).trim())
  .refine(value => /^\d+(\.\d{1,6})?$/.test(value), '양수이며 소수점 이하 6자리인 수량을 입력해 주세요.')
  .refine(value => Number(value) > 0 && Number(value) < 1_000_000_000, '수량은 0보다 크고 10억보다 작아야 합니다.')
  .transform(value => {
    const [whole = '0', fraction = ''] = value.split('.')
    const normalized = whole.replace(/^0+(?=\d)/, '')
    const tail = fraction.replace(/0+$/, '')
    return tail ? `${normalized}.${tail}` : normalized
  })

function todayInSeoul(): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

const businessDate = calendarDateSchema.refine(value => value <= todayInSeoul(), '한국 시간 기준 오늘 이후의 거래는 등록할 수 없습니다.')
const commonInput = {
  request_key: inventoryIdSchema,
  quantity: transactionQuantitySchema,
  unit: z.enum(stockUnits),
  reason,
  notes: text(2000).default(''),
}

export const receiptInputSchema = z.object({
  ...commonInput,
  material_id: inventoryIdSchema,
  lot_number: text(100).min(1, '제조번호를 입력해 주세요.'),
  location_id: inventoryIdSchema,
  received_on: businessDate,
  expires_on: nullableDate,
  retest_on: nullableDate,
  manufactured_on: nullableDate,
  manufacturer: text(200).default(''),
  test_number: text(100).default(''),
  receipt_reference: text(100).min(1, '입고 참조번호를 입력해 주세요.'),
}).strict().superRefine((input, context) => {
  for (const field of ['expires_on', 'retest_on'] as const) {
    if (input[field] && input[field] < input.received_on) {
      context.addIssue({ code: 'custom', path: [field], message: '입고일보다 빠를 수 없습니다.' })
    }
  }
  if (input.manufactured_on && input.manufactured_on > input.received_on) {
    context.addIssue({ code: 'custom', path: ['manufactured_on'], message: '제조일은 입고일보다 늦을 수 없습니다.' })
  }
})

export const issueInputSchema = z.object({
  ...commonInput,
  issue_purpose: z.enum(issuePurposes).default('GENERAL'),
  material_id: inventoryIdSchema,
  warehouse_id: optionalId,
  occurred_on: businessDate,
  production_item: text(200).default(''),
  production_batch: text(100).default(''),
}).strict().superRefine(validateCleaningQuantity)

export const returnInputSchema = z.object({
  ...commonInput,
  issue_line_id: inventoryIdSchema,
  location_id: inventoryIdSchema,
  occurred_on: businessDate,
}).strict()

export const releaseReturnInputSchema = z.object({
  ...commonInput,
  return_line_id: inventoryIdSchema,
  occurred_on: businessDate,
}).strict()

const queryText = text(200).default('')
const queryId = z.preprocess(value => value === '' ? undefined : value, inventoryIdSchema.optional())
const queryDate = z.preprocess(value => value === '' ? undefined : value, calendarDateSchema.optional())
const positiveIntegerQuery = (fallback: number, max: number) => z.preprocess(
  value => value === undefined ? String(fallback) : value,
  z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(max)),
)
const pagination = { page: positiveIntegerQuery(1, 1_000_000), pageSize: positiveIntegerQuery(20, 100) }

export const transactionQuerySchema = z.object({
  ...pagination, q: queryText,
  material_id: queryId, batch_id: queryId,
  type: z.preprocess(value => value === '' ? undefined : value, z.enum(transactionTypes).optional()),
  from: queryDate, to: queryDate,
}).strict().refine(input => !input.from || !input.to || input.from <= input.to, {
  path: ['to'], message: '종료일은 시작일보다 빠를 수 없습니다.',
})

export const transactionBatchQuerySchema = z.object({ ...pagination, q: queryText, material_id: queryId, batch_id: queryId }).strict()
export const returnableQuerySchema = z.object({ ...pagination, q: queryText, material_id: queryId }).strict()
export const pendingReturnQuerySchema = z.object({ ...pagination, q: queryText, material_id: queryId }).strict()
export const issuePreviewQuerySchema = z.object({
  material_id: inventoryIdSchema, warehouse_id: optionalId,
  occurred_on: businessDate,
  quantity: transactionQuantitySchema, unit: z.enum(stockUnits),
  issue_purpose: z.enum(issuePurposes).default('GENERAL'),
}).strict().superRefine(validateCleaningQuantity)

export function validateCleaningQuantity(input: { issue_purpose: string; quantity: string; unit: string }, context: z.RefinementCtx) {
  if (input.issue_purpose !== 'CLEANING') return
  if (input.unit !== 'L') context.addIssue({ code: 'custom', path: ['unit'], message: '세척 출고는 L 단위로 입력해 주세요.' })
  if (Number(input.quantity) % 18 !== 0) context.addIssue({ code: 'custom', path: ['quantity'], message: '세척 출고는 18L 단위로 입력해 주세요. 예: 18, 36, 54L' })
}

export type ReceiptInput = z.infer<typeof receiptInputSchema>
export type IssueInput = z.infer<typeof issueInputSchema>
export type ReturnInput = z.infer<typeof returnInputSchema>
export type ReleaseReturnInput = z.infer<typeof releaseReturnInputSchema>
export type TransactionQuery = z.infer<typeof transactionQuerySchema>
export type TransactionBatchQuery = z.infer<typeof transactionBatchQuerySchema>
export type ReturnableQuery = z.infer<typeof returnableQuerySchema>
export type PendingReturnQuery = z.infer<typeof pendingReturnQuerySchema>
export type IssuePreviewQuery = z.infer<typeof issuePreviewQuerySchema>
