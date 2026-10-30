import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bomInputSchema, planIssueInputSchema, planQuerySchema, scheduleInputSchema } from '../shared/schemas/planning'
import { issueInputSchema, issuePreviewQuerySchema } from '../shared/schemas/transactions'
import { throwPlanningError } from '../server/services/planning'

vi.mock('../server/services/auth', () => ({ requirePermission: vi.fn() }))
vi.mock('../server/utils/supabase', () => ({ createSupabaseServerClient: vi.fn() }))

const id = '11111111-1111-4111-8111-111111111111'
const bom = { code: 'BOM-A', name: '배합', product_name: '제품', is_active: true,
  components: [{ material_id: id, quantity: '18', unit: 'L', issue_purpose: 'CLEANING' }], reason: '신규 배합' }
const schedule = { code: 'SCHEDULE-A', bom_id: id, scheduled_on: '2027-01-01', multiplier: '2', production_batch: '0001', reason: '생산 계획' }
const plannedIssue = { plan_id: id, expected_revision: 1, request_key: id, occurred_on: '2026-10-30', reason: '생산 불출' }

describe('planning and cleaning input boundaries', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T14:59:59Z')) })
  afterEach(() => vi.useRealTimers())

  it('accepts future schedules but prevents confirming future stock movements in Seoul time', () => {
    expect(scheduleInputSchema.parse(schedule)).toMatchObject({ id: null, expected_revision: null, multiplier: '2' })
    expect(planIssueInputSchema.safeParse({ ...plannedIssue, occurred_on: '2026-10-31' }).success).toBe(false)
    vi.setSystemTime(new Date('2026-10-30T15:00:00Z'))
    expect(planIssueInputSchema.safeParse({ ...plannedIssue, occurred_on: '2026-10-31' }).success).toBe(true)
    expect(scheduleInputSchema.safeParse({ ...schedule, scheduled_on: '2027-02-29' }).success).toBe(false)
  })

  it('requires an expected revision exactly when editing an existing BOM or schedule', () => {
    for (const [schema, input] of [[bomInputSchema, bom], [scheduleInputSchema, schedule]] as const) {
      expect(schema.safeParse(input).success).toBe(true)
      expect(schema.safeParse({ ...input, id }).success).toBe(false)
      expect(schema.safeParse({ ...input, expected_revision: 1 }).success).toBe(false)
      expect(schema.safeParse({ ...input, id, expected_revision: 1 }).success).toBe(true)
      expect(schema.safeParse({ ...input, id, expected_revision: 0 }).success).toBe(false)
    }
  })

  it('rejects duplicate BOM material-purpose pairs while allowing general and cleaning for one material', () => {
    expect(bomInputSchema.safeParse({ ...bom, components: [...bom.components, ...bom.components] }).success).toBe(false)
    expect(bomInputSchema.safeParse({ ...bom, components: [...bom.components, { ...bom.components[0], issue_purpose: 'GENERAL' }] }).success).toBe(true)
    expect(bomInputSchema.safeParse({ ...bom, components: [] }).success).toBe(false)
  })

  it.each(['0', '7', '18.000001', '35.999999', '19', '-18', '18e1'])('rejects non-block cleaning quantity %s in preview, save, and BOM', quantity => {
    const issue = { ...plannedIssue, material_id: id, quantity, unit: 'L', issue_purpose: 'CLEANING' }
    const { plan_id: _planId, expected_revision: _revision, ...manual } = issue
    expect(issueInputSchema.safeParse(manual).success).toBe(false)
    expect(issuePreviewQuerySchema.safeParse({ material_id: id, quantity, unit: 'L', issue_purpose: 'CLEANING', occurred_on: plannedIssue.occurred_on }).success).toBe(false)
    expect(bomInputSchema.safeParse({ ...bom, components: [{ ...bom.components[0], quantity }] }).success).toBe(false)
  })

  it('accepts 18L multiples and keeps ordinary manual issues available for leftover quantities', () => {
    const manual = { material_id: id, request_key: id, occurred_on: plannedIssue.occurred_on, reason: '추가 불출', unit: 'L', quantity: '36.000000', issue_purpose: 'CLEANING' }
    expect(issueInputSchema.parse(manual).quantity).toBe('36')
    expect(issueInputSchema.safeParse({ ...manual, unit: 'kg' }).success).toBe(false)
    expect(issueInputSchema.parse({ ...manual, issue_purpose: 'GENERAL', quantity: '7' }).quantity).toBe('7')
  })

  it('does not let callers override the plan quantity, actor, linkage, or confirmed status', () => {
    for (const extra of [{ quantity: '1' }, { actor_id: id }, { material_id: id }, { stock_operation_id: id }, { status: 'ISSUED' }]) {
      expect(planIssueInputSchema.safeParse({ ...plannedIssue, ...extra }).success).toBe(false)
    }
    expect(planIssueInputSchema.safeParse({ ...plannedIssue, request_key: undefined }).success).toBe(false)
    expect(planIssueInputSchema.safeParse({ ...plannedIssue, reason: ' ' }).success).toBe(false)
  })

  it('bounds planning filters and rejects query arrays or unknown statuses', () => {
    expect(planQuerySchema.parse({ schedule_id: id, status: 'PLANNED' })).toMatchObject({ page: 1, pageSize: 20 })
    for (const input of [{ pageSize: '101' }, { status: 'DONE' }, { schedule_id: [id] }, { status: ['PLANNED'] }, { sql: 'select *' }]) {
      expect(planQuerySchema.safeParse(input).success).toBe(false)
    }
  })

  it.each([
    ['40001', 'Planning revision conflict', 409], ['23514', 'Issued schedule cannot change BOM', 409],
    ['23505', 'Plan has already been issued with another request key', 409],
    ['22023', 'Plan cannot be issued before its planned date', 400],
    ['22023', 'Planning record not found', 404], ['XX000', 'private schema details', 503],
  ])('maps planning errors safely: %s / %s', (code, message, statusCode) => {
    expect(() => throwPlanningError({ code, message })).toThrow(expect.objectContaining({ statusCode }))
    try { throwPlanningError({ code, message }) } catch (error) { expect((error as Error).message).not.toContain('private schema') }
  })

  it('keeps actionable stock conversion messages when a BOM or plan cannot be converted', () => {
    expect(() => throwPlanningError({ code: '22023', message: 'Verified material density is required for mass/volume conversion' }))
      .toThrow(/밀도/)
    expect(() => throwPlanningError({ code: '22023', message: 'EA cannot be converted to mass or volume' }))
      .toThrow(/EA/)
  })
})
