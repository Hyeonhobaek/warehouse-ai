import { z } from 'zod'
import { calendarDateSchema, inventoryIdSchema } from './inventory'
import { transactionQuantitySchema, validateCleaningQuantity } from './transactions'
import { stockUnits } from '../types/inventory'
import { issuePurposes } from '../types/transactions'

const text = (max: number) => z.string().trim().max(max)
const reason = text(1000).min(1, '변경 사유를 입력해 주세요.')
const emptyToNull = (value: unknown) => value === '' || value === undefined ? null : value
const nullableId = z.preprocess(emptyToNull, inventoryIdSchema.nullable())
const nullableRevision = z.preprocess(emptyToNull, z.number().int().positive().max(2_147_483_647).nullable())
const revisionIdentity = { id: nullableId, expected_revision: nullableRevision }

const component = z.object({
  material_id: inventoryIdSchema, quantity: transactionQuantitySchema,
  unit: z.enum(stockUnits), issue_purpose: z.enum(issuePurposes).default('GENERAL'),
}).strict().superRefine(validateCleaningQuantity)

export const bomInputSchema = z.object({
  ...revisionIdentity, code: text(80).min(1), name: text(200).min(1), product_name: text(200).min(1),
  is_active: z.boolean(), components: z.array(component).min(1).max(100), reason,
}).strict().superRefine((input, context) => {
  validateRevision(input, context)
  const keys = new Set<string>()
  input.components.forEach((row, index) => {
    const key = `${row.material_id}:${row.issue_purpose}`
    if (keys.has(key)) context.addIssue({ code: 'custom', path: ['components', index], message: '같은 원료·용도의 BOM 항목은 합쳐서 입력해 주세요.' })
    keys.add(key)
  })
})

export const scheduleInputSchema = z.object({
  ...revisionIdentity, code: text(80).min(1), bom_id: inventoryIdSchema,
  scheduled_on: calendarDateSchema, multiplier: transactionQuantitySchema,
  production_batch: text(100).min(1), notes: text(2000).default(''),
  status: z.enum(['ACTIVE', 'CANCELLED']).default('ACTIVE'), reason,
}).strict().superRefine(validateRevision)

function validateRevision(input: { id: string | null; expected_revision: number | null }, context: z.RefinementCtx) {
  if (Boolean(input.id) !== (input.expected_revision !== null)) {
    context.addIssue({ code: 'custom', path: ['expected_revision'], message: '수정할 항목을 새로 불러온 후 다시 저장해 주세요.' })
  }
}

export const planIssueInputSchema = z.object({
  plan_id: inventoryIdSchema, expected_revision: z.number().int().positive().max(2_147_483_647),
  request_key: inventoryIdSchema, occurred_on: calendarDateSchema,
  warehouse_id: nullableId, reason, notes: text(2000).default(''),
}).strict().refine(input => input.occurred_on <= new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()), { path: ['occurred_on'], message: '미래 날짜의 출고는 확정할 수 없습니다.' })

const optionalId = z.preprocess(value => value === '' ? undefined : value, inventoryIdSchema.optional())
const page = (fallback: number, max: number) => z.preprocess(value => value === undefined ? String(fallback) : value,
  z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max)))
const pagination = { page: page(1, 1_000_000), pageSize: page(20, 100), q: text(200).default('') }
const optionalStatus = <const T extends readonly [string, ...string[]]>(values: T) => z.preprocess(value => value === '' ? undefined : value, z.enum(values).optional())
export const bomQuerySchema = z.object({ ...pagination }).strict()
export const scheduleQuerySchema = z.object({ ...pagination, status: optionalStatus(['ACTIVE', 'CANCELLED']) }).strict()
export const planQuerySchema = z.object({ ...pagination, schedule_id: optionalId, status: optionalStatus(['PLANNED', 'ISSUED', 'CANCELLED']) }).strict()

export type BomInput = z.infer<typeof bomInputSchema>
export type ScheduleInput = z.infer<typeof scheduleInputSchema>
export type PlanIssueInput = z.infer<typeof planIssueInputSchema>
export type BomQuery = z.infer<typeof bomQuerySchema>
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>
export type PlanQuery = z.infer<typeof planQuerySchema>
