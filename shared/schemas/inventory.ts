import { z } from 'zod'
import { qualityStatuses, stockUnits } from '../types/inventory'

const text = (max: number) => z.string().trim().max(max, `최대 ${max}자까지 입력할 수 있습니다.`)
const requiredText = (max: number) => text(max).min(1, '필수 입력 항목입니다.')
export const inventoryIdSchema = z.string().uuid('올바른 식별자가 아닙니다.')

/** Dates are calendar dates, not timestamps; reject overflow such as February 30. */
export function isCalendarDate(value: string): boolean {
  if (!/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime())
    && parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day
}

const seoulCalendar = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Recompute at validation time so long-running servers cross midnight correctly. */
function todayInSeoul(): string {
  const parts = Object.fromEntries(seoulCalendar.formatToParts(new Date()).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export const calendarDateSchema = z.string().trim().refine(isCalendarDate, '1900~2199년의 올바른 날짜를 입력해 주세요.')
const blankToNull = (value: unknown) => typeof value === 'string' && value.trim() === '' ? null : value
const nullableDate = z.preprocess(blankToNull, calendarDateSchema.nullable())
const decimal = z.preprocess((value) => {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim())
  return value
}, z.number().finite().min(0).max(999_999_999).refine(
  value => /^\d+(\.\d{1,6})?$/.test(String(value)), '소수점 이하 6자리까지 입력할 수 있습니다.',
))
const positiveDecimal = decimal.refine(value => value > 0, '0보다 큰 수량을 입력해 주세요.')
const nullablePositiveDecimal = z.preprocess(blankToNull, positiveDecimal.nullable())

// Every field is required on POST and PATCH: an omitted field cannot erase existing metadata.
export const materialInputSchema = z.object({
  code: requiredText(80),
  name: requiredText(200),
  aliases: z.array(requiredText(100)).max(20).transform(items => [...new Set(items)]),
  specification: text(500),
  manufacturer: text(200),
  base_unit: z.enum(stockUnits),
  min_stock: decimal,
  storage_condition: text(500),
  package_size: nullablePositiveDecimal,
  package_unit: z.preprocess(blankToNull, z.enum(stockUnits).nullable()),
  density: nullablePositiveDecimal,
  is_active: z.boolean(),
}).strict().refine(input => (input.package_size === null) === (input.package_unit === null), {
  path: ['package_unit'], message: '포장 수량과 단위를 함께 입력해 주세요.',
})

export const lotInputSchema = z.object({
  material_id: inventoryIdSchema,
  lot_number: requiredText(100),
  manufacturer: text(200),
  manufactured_on: nullableDate,
  notes: text(2000),
}).strict()

export const batchInputSchema = z.object({
  lot_id: inventoryIdSchema,
  receipt_reference: requiredText(100),
  received_on: calendarDateSchema,
  expires_on: nullableDate,
  retest_on: nullableDate,
  test_number: text(100),
  quality_status: z.enum(qualityStatuses),
  decision_on: nullableDate,
  quality_reason: requiredText(1000),
  notes: text(2000),
}).strict().superRefine((input, context) => {
  const today = todayInSeoul()
  for (const field of ['received_on', 'decision_on'] as const) {
    if (input[field] && input[field] > today) {
      context.addIssue({ code: 'custom', path: [field], message: '입고일과 판정일은 한국 시간 기준 오늘 이후로 입력할 수 없습니다.' })
    }
  }
  for (const field of ['expires_on', 'retest_on', 'decision_on'] as const) {
    if (input[field] && input[field] < input.received_on) {
      context.addIssue({ code: 'custom', path: [field], message: '입고일보다 빠를 수 없습니다.' })
    }
  }
})

export const warehouseInputSchema = z.object({
  code: requiredText(80), name: requiredText(200), is_active: z.boolean(),
}).strict()

export const locationInputSchema = z.object({
  warehouse_id: inventoryIdSchema, code: requiredText(80), name: requiredText(200), is_active: z.boolean(),
}).strict()

const blankToUndefined = (value: unknown) => value === '' ? undefined : value
const optionalId = z.preprocess(blankToUndefined, inventoryIdSchema.optional())
const queryText = z.string().trim().max(200).default('')
const queryBoolean = z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional()).transform(value => value === 'true')
const positiveIntegerQuery = (fallback: number, max: number) => z.preprocess(
  value => value === undefined ? String(fallback) : value,
  z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(max)),
)
const pagination = { page: positiveIntegerQuery(1, 1_000_000), pageSize: positiveIntegerQuery(20, 100) }

export const materialQuerySchema = z.object({
  ...pagination, q: queryText, active: z.enum(['all', 'true', 'false']).default('all'),
}).strict()
export const lotQuerySchema = z.object({ ...pagination, q: queryText, material_id: optionalId }).strict()
export const batchQuerySchema = z.object({ ...pagination, lot_id: optionalId }).strict()
export const warehouseQuerySchema = z.object({ ...pagination, q: queryText }).strict()
export const locationQuerySchema = z.object({ ...pagination, warehouse_id: optionalId, q: queryText }).strict()
export const inventoryQuerySchema = z.object({
  ...pagination,
  q: queryText,
  material_id: optionalId,
  manufacturer: queryText,
  warehouse_id: optionalId,
  location_id: optionalId,
  status: z.preprocess(blankToUndefined, z.enum([...qualityStatuses, 'EXPIRED']).optional()),
  retest: queryBoolean,
  expiry: queryBoolean,
  low_stock: queryBoolean,
}).strict()
export const summaryQuerySchema = z.object({ ...pagination, q: queryText, low_stock: queryBoolean }).strict()

export type MaterialQuery = z.infer<typeof materialQuerySchema>
export type LotQuery = z.infer<typeof lotQuerySchema>
export type BatchQuery = z.infer<typeof batchQuerySchema>
export type WarehouseQuery = z.infer<typeof warehouseQuerySchema>
export type LocationQuery = z.infer<typeof locationQuerySchema>
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>
export type SummaryQuery = z.infer<typeof summaryQuerySchema>
