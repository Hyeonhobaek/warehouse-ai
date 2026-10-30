import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const ids = {
  viewer: '00000000-0000-4000-8000-000000000001', operator: '00000000-0000-4000-8000-000000000002',
  admin: '00000000-0000-4000-8000-000000000003', disabled: '00000000-0000-4000-8000-000000000004',
  material: '10000000-0000-4000-8000-000000000001', second: '10000000-0000-4000-8000-000000000002',
  lot: '20000000-0000-4000-8000-000000000001', warehouse: '30000000-0000-4000-8000-000000000001',
  location: '40000000-0000-4000-8000-000000000001', old: '50000000-0000-4000-8000-000000000001',
  next: '50000000-0000-4000-8000-000000000002',
}
type Component = { material_id: string; quantity: string; unit: string; issue_purpose: string }
type Bom = { id: string; code: string; name: string; product_name: string; is_active: boolean; revision: number; components: Component[] }
type Plan = { id: string; schedule_id: string; material_id: string; quantity: number; unit: string; issue_purpose: string; planned_on: string; status: string; revision: number; bom_revision: number; production_item: string; production_batch: string; stock_operation_id: string | null }
type Schedule = { id: string; code: string; bom_id: string; scheduled_on: string; multiplier: number; production_batch: string; notes: string; status: string; revision: number; bom_revision: number }
type SavedSchedule = { schedule: Schedule; plans: Plan[] }
type Transaction = { operation: { id: string; quantity: number; input_quantity: number; issue_purpose: string }; lines: { id: string; batch_id: string; quantity: number; on_hand_after: number }[] }
let db: PGlite
let today: string
let tomorrow: string
let yesterday: string

async function auth(role: 'viewer' | 'operator' | 'admin' | 'disabled' | 'anon') {
  await db.exec(`set local role ${role === 'anon' ? 'anon' : 'authenticated'}`)
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [role === 'anon' ? '' : ids[role]])
}
async function rpc<T>(name: string, input: Record<string, unknown>) {
  return (await db.query<{ result: T }>(`select public.${name}($1::jsonb) result`, [JSON.stringify(input)])).rows[0]!.result
}
async function reject(work: () => Promise<unknown>, pattern: RegExp) {
  await db.exec('savepoint expected_failure')
  await expect(work()).rejects.toThrow(pattern)
  await db.exec('rollback to savepoint expected_failure')
}
function component(overrides: Partial<Component> = {}): Component {
  return { material_id: ids.material, quantity: '5', unit: 'kg', issue_purpose: 'GENERAL', ...overrides }
}
function bomInput(overrides: Record<string, unknown> = {}) {
  return { code: 'BOM-001', name: '가상 BOM', product_name: '가상 제품', is_active: true, components: [component()], reason: 'BOM 등록', ...overrides }
}
function bomUpdate(bom: Bom, overrides: Record<string, unknown> = {}) {
  return bomInput({ id: bom.id, expected_revision: bom.revision, code: bom.code, name: bom.name,
    product_name: bom.product_name, is_active: bom.is_active, components: bom.components, ...overrides })
}
async function createBom(overrides: Record<string, unknown> = {}) {
  await auth('admin')
  const bom = await rpc<Bom>('planning_save_bom', bomInput(overrides))
  await auth('operator')
  return bom
}
function scheduleInput(bomId: string, overrides: Record<string, unknown> = {}) {
  return { code: 'SCH-001', bom_id: bomId, scheduled_on: today, multiplier: '1', production_batch: 'PROD-001', notes: '', status: 'ACTIVE', reason: '생산일정 등록', ...overrides }
}
function scheduleUpdate(schedule: Schedule, overrides: Record<string, unknown> = {}) {
  return scheduleInput(schedule.bom_id, { id: schedule.id, expected_revision: schedule.revision, code: schedule.code,
    scheduled_on: schedule.scheduled_on, multiplier: String(schedule.multiplier), production_batch: schedule.production_batch,
    notes: schedule.notes, status: schedule.status, ...overrides })
}
function confirmInput(plan: Plan, overrides: Record<string, unknown> = {}) {
  return { plan_id: plan.id, expected_revision: plan.revision, request_key: randomUUID(), occurred_on: today,
    reason: '예정 불출 확인', notes: '', ...overrides }
}
async function balances() {
  return (await db.query('select batch_id,on_hand::float,held::float,reserved::float from public.stock_balances order by batch_id')).rows
}
async function planRow(id: string) {
  return (await db.query<{ data: Plan }>('select to_jsonb(p) data from public.stock_issue_plans p where id=$1', [id])).rows[0]!.data
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`)
  for (const file of ['20261029000100_identity_foundation.sql', '20261030000100_inventory_foundation.sql', '20261030000200_stock_transactions.sql', '20261030000300_cleaning_fifo.sql', '20261030000400_bom_planning.sql']) {
    await db.exec(await readFile(fileURLToPath(new URL(`../supabase/migrations/${file}`, import.meta.url)), 'utf8'))
  }
  for (const role of ['viewer', 'operator', 'admin', 'disabled'] as const) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [ids[role], `${role}@example.test`])
  }
  await db.exec(`begin; set local app.audit_reason='가상 테스트 권한';
    update public.profiles set role='operator' where id='${ids.operator}';
    update public.profiles set role='admin' where id='${ids.admin}';
    update public.profiles set is_active=false where id='${ids.disabled}'; commit;
    insert into public.materials(id,code,name,base_unit,density) values
      ('${ids.material}','DEMO-A','가상 용매','kg',0.8),('${ids.second}','DEMO-B','가상 두번째 원료','kg',1);
    insert into public.material_lots(id,material_id,lot_number) values('${ids.lot}','${ids.material}','LOT-001');
    insert into public.warehouses(id,code,name) values('${ids.warehouse}','MAIN','가상 창고');
    insert into public.storage_locations(id,warehouse_id,code,name) values('${ids.location}','${ids.warehouse}','A','A위치');
    insert into public.stock_batches(id,lot_id,receipt_reference,received_on,expires_on,test_number,quality_status,quality_reason,created_at) values
      ('${ids.old}','${ids.lot}','RCV-1',current_date-10,current_date+100,'TEST-OLD','APPROVED','가상 승인',now()-interval '10 days'),
      ('${ids.next}','${ids.lot}','RCV-2',current_date-5,current_date+100,'TEST-NEXT','APPROVED','가상 승인',now()-interval '5 days');
    insert into public.stock_balances(batch_id,location_id,on_hand) values('${ids.old}','${ids.location}',20),('${ids.next}','${ids.location}',80);`)
  const dates = (await db.query<{ today: string; tomorrow: string; yesterday: string }>("select (now() at time zone 'Asia/Seoul')::date::text today, ((now() at time zone 'Asia/Seoul')::date+1)::text tomorrow, ((now() at time zone 'Asia/Seoul')::date-1)::text yesterday")).rows[0]!
  today = dates.today
  tomorrow = dates.tomorrow
  yesterday = dates.yesterday
}, 30_000)
beforeEach(async () => { await db.exec('begin'); await auth('operator') })
afterEach(async () => { await db.exec('rollback') })
afterAll(async () => { await db?.close() })

describe('web BOM and production schedule database boundary', () => {
  it('creates a versioned BOM, searchable view rows and actor/reason history without moving stock', async () => {
    const before = await balances()
    const bom = await createBom()
    const saved = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    expect(bom.revision).toBe(1)
    expect(saved.plans).toHaveLength(1)
    expect(saved.plans[0]).toMatchObject({ quantity: 5, unit: 'kg', status: 'PLANNED', revision: 1, bom_revision: 1, production_item: '가상 제품', production_batch: 'PROD-001', stock_operation_id: null })
    expect(await balances()).toEqual(before)
    expect((await db.query('select count(*)::int n from public.stock_operations')).rows[0]).toEqual({ n: 0 })
    expect((await db.query('select entity_kind,actor_id,reason,before_data from public.planning_change_history order by created_at')).rows).toEqual([
      { entity_kind: 'BOM', actor_id: ids.admin, reason: 'BOM 등록', before_data: null },
      { entity_kind: 'SCHEDULE', actor_id: ids.operator, reason: '생산일정 등록', before_data: null },
    ])
    expect((await db.query('select bom_code,product_name from public.schedule_rows')).rows).toEqual([{ bom_code: 'BOM-001', product_name: '가상 제품' }])
    expect((await db.query('select material_code,schedule_code from public.issue_plan_rows')).rows).toEqual([{ material_code: 'DEMO-A', schedule_code: 'SCH-001' }])
  })

  it('updates only planned quantities and dates using decimal multiplication and stable plan identities', async () => {
    const bom = await createBom({ components: [component({ quantity: '0.1' })] })
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const before = await balances()
    const next = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(first.schedule, { scheduled_on: tomorrow, multiplier: '3', production_batch: 'PROD-002' }))
    expect(next.schedule.revision).toBe(2)
    expect(next.plans[0]).toMatchObject({ id: first.plans[0]!.id, quantity: 0.3, planned_on: tomorrow, production_batch: 'PROD-002', revision: 2 })
    expect(await balances()).toEqual(before)
    await reject(() => rpc('planning_save_schedule', scheduleUpdate(first.schedule)), /revision conflict/)
  })

  it('does not rewrite existing plans when the BOM is edited until the schedule is explicitly saved', async () => {
    const bom = await createBom()
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    await auth('admin')
    const changed = await rpc<Bom>('planning_save_bom', bomUpdate(bom, { components: [component({ quantity: '8' })], product_name: '변경된 품목' }))
    expect(await planRow(first.plans[0]!.id)).toMatchObject({ quantity: 5, bom_revision: 1, production_item: '가상 제품' })
    const next = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(first.schedule))
    expect(changed.revision).toBe(2)
    expect(next.plans[0]).toMatchObject({ quantity: 8, bom_revision: 2, production_item: '변경된 품목' })
    await reject(() => rpc('planning_save_bom', bomUpdate(bom)), /revision conflict/)
  })

  it('cancels and reactivates unissued plans without losing their identities or moving stock', async () => {
    const bom = await createBom()
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const cancelled = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(first.schedule, { status: 'CANCELLED' }))
    expect(cancelled.plans[0]).toMatchObject({ id: first.plans[0]!.id, status: 'CANCELLED', revision: 2 })
    await reject(() => rpc('planning_issue_plan', confirmInput(cancelled.plans[0]!)), /not available/)
    const reactivated = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(cancelled.schedule, { status: 'ACTIVE' }))
    expect(reactivated.plans[0]).toMatchObject({ id: first.plans[0]!.id, status: 'PLANNED', revision: 3 })
    expect((await db.query('select count(*)::int n from public.stock_operations')).rows[0]).toEqual({ n: 0 })
  })

  it('cancels removed BOM components and reuses the same rows if they are later restored', async () => {
    const bom = await createBom({ components: [component(), component({ material_id: ids.second })] })
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const secondPlan = first.plans.find(p => p.material_id === ids.second)!
    await auth('admin')
    const trimmed = await rpc<Bom>('planning_save_bom', bomUpdate(bom, { components: [component()] }))
    const next = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(first.schedule))
    expect(next.plans.find(p => p.id === secondPlan.id)!.status).toBe('CANCELLED')
    await rpc('planning_save_bom', bomUpdate(trimmed, { components: bom.components }))
    const restored = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(next.schedule))
    expect(restored.plans.find(p => p.material_id === ids.second)).toMatchObject({ id: secondPlan.id, status: 'PLANNED' })
  })

  it('issues a plan atomically and preserves its full issued snapshot through later schedule/BOM changes', async () => {
    const bom = await createBom({ components: [component(), component({ material_id: ids.second })] })
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const plan = first.plans.find(p => p.material_id === ids.material)!
    const result = await rpc<Transaction>('planning_issue_plan', confirmInput(plan))
    const frozen = await planRow(plan.id)
    expect(frozen).toMatchObject({ status: 'ISSUED', stock_operation_id: result.operation.id, revision: 2 })
    expect(result.lines[0]).toMatchObject({ batch_id: ids.old, quantity: 5, on_hand_after: 15 })
    await auth('admin')
    await rpc('planning_save_bom', bomUpdate(bom, { components: [component({ quantity: '20' }), component({ material_id: ids.second, quantity: '7' })] }))
    const next = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(first.schedule, { multiplier: '2', scheduled_on: tomorrow, production_batch: 'PROD-NEW' }))
    expect(await planRow(plan.id)).toEqual(frozen)
    expect(next.plans.find(p => p.material_id === ids.second)).toMatchObject({ quantity: 14, planned_on: tomorrow, production_batch: 'PROD-NEW' })
    const cancelled = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(next.schedule, { status: 'CANCELLED' }))
    expect(cancelled.plans.find(p => p.id === plan.id)).toEqual(frozen)
  })

  it('replays a confirmation only for the same key, actor and exact original input', async () => {
    const bom = await createBom()
    const saved = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const input = confirmInput(saved.plans[0]!)
    const first = await rpc<Transaction>('planning_issue_plan', input)
    expect(await rpc('planning_issue_plan', input)).toEqual(first)
    await reject(() => rpc('planning_issue_plan', { ...input, request_key: randomUUID() }), /another request key/)
    await reject(() => rpc('planning_issue_plan', { ...input, notes: '변경' }), /different input/)
    await reject(() => rpc('planning_issue_plan', { ...input, expected_revision: 2 }), /revision conflict/)
    await auth('admin')
    await reject(() => rpc('planning_issue_plan', input), /different input/)
    expect((await db.query('select count(*)::int n from public.stock_operations')).rows[0]).toEqual({ n: 1 })
    expect((await db.query("select count(*)::int n from public.planning_change_history where entity_kind='PLAN_ISSUE'")).rows[0]).toEqual({ n: 1 })
  })

  it('reschedules unissued components without revalidating a frozen issued cleaning component', async () => {
    const bom = await createBom({ components: [
      component({ quantity: '18', unit: 'L', issue_purpose: 'CLEANING' }), component({ material_id: ids.second }),
    ] })
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const cleaning = first.plans.find(plan => plan.issue_purpose === 'CLEANING')!
    await rpc('planning_issue_plan', confirmInput(cleaning))
    const frozen = await planRow(cleaning.id)
    await auth('admin')
    await db.query('update public.materials set is_active=false,density=null where id=$1', [ids.material])
    await auth('operator')
    const next = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(first.schedule, { multiplier: '1.5', scheduled_on: tomorrow }))
    expect(next.plans.find(plan => plan.id === cleaning.id)).toEqual(frozen)
    expect(next.plans.find(plan => plan.material_id === ids.second)).toMatchObject({ quantity: 7.5, planned_on: tomorrow, status: 'PLANNED' })
    expect((await db.query('select count(*)::int n from public.stock_operations')).rows[0]).toEqual({ n: 1 })
  })

  it('preserves a removed issued component and validates a newly added purpose separately', async () => {
    const bom = await createBom()
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const general = first.plans[0]!
    await rpc('planning_issue_plan', confirmInput(general))
    const frozen = await planRow(general.id)
    await auth('admin')
    await rpc('planning_save_bom', bomUpdate(bom, { components: [component({ quantity: '18', unit: 'L', issue_purpose: 'CLEANING' })] }))
    await reject(() => rpc('planning_save_schedule', scheduleUpdate(first.schedule, { multiplier: '1.5' })), /exact multiple of 18 L/)
    const next = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(first.schedule))
    expect(next.plans.find(plan => plan.id === general.id)).toEqual(frozen)
    expect(next.plans.find(plan => plan.issue_purpose === 'CLEANING')).toMatchObject({ quantity: 18, status: 'PLANNED', stock_operation_id: null })
  })

  it('rejects stale confirmations after a schedule changes and enforces future planning dates', async () => {
    const bom = await createBom()
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const next = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(first.schedule, { scheduled_on: tomorrow }))
    await reject(() => rpc('planning_issue_plan', confirmInput(first.plans[0]!)), /revision conflict/)
    await reject(() => rpc('planning_issue_plan', confirmInput(next.plans[0]!)), /before its planned date/)
    const due = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(next.schedule, { scheduled_on: today }))
    await reject(() => rpc('planning_issue_plan', confirmInput(due.plans[0]!, { occurred_on: yesterday })), /before its planned date/)
    await reject(() => rpc('planning_issue_plan', confirmInput(due.plans[0]!, { occurred_on: tomorrow })), /no later than today/)
  })

  it('prevents switching the BOM of a schedule with any issued component', async () => {
    const bom = await createBom()
    const other = await createBom({ code: 'BOM-002' })
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    await rpc('planning_issue_plan', confirmInput(first.plans[0]!))
    await reject(() => rpc('planning_save_schedule', scheduleUpdate(first.schedule, { bom_id: other.id })), /cannot change BOM/)
    expect((await db.query('select bom_id,revision from public.production_schedules')).rows).toEqual([{ bom_id: bom.id, revision: 1 }])
  })

  it('uses the same 18 L FIFO cleaning allocator and kilogram conversion as manual issues', async () => {
    const bom = await createBom({ components: [component({ quantity: '18', unit: 'L', issue_purpose: 'CLEANING' })] })
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id, { multiplier: '2' }))
    const issued = await rpc<Transaction>('planning_issue_plan', confirmInput(first.plans[0]!))
    expect(issued.operation).toMatchObject({ input_quantity: 36, quantity: 28.8, issue_purpose: 'CLEANING' })
    expect(issued.lines.map(line => [line.batch_id, line.quantity, line.on_hand_after])).toEqual([[ids.old, 14.4, 5.6], [ids.next, 14.4, 65.6]])
  })

  it('rolls back a schedule edit entirely when a cleaning multiplier produces a partial 18 L block', async () => {
    const bom = await createBom({ components: [component({ quantity: '18', unit: 'L', issue_purpose: 'CLEANING' })] })
    const first = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    await reject(() => rpc('planning_save_schedule', scheduleUpdate(first.schedule, { multiplier: '1.5' })), /exact multiple of 18 L/)
    expect(await planRow(first.plans[0]!.id)).toEqual(first.plans[0])
    expect((await db.query('select revision,multiplier::float from public.production_schedules')).rows).toEqual([{ revision: 1, multiplier: 1 }])
  })

  it('rolls back insufficient-stock confirmation without completing the plan or adding issue history', async () => {
    const bom = await createBom({ components: [component({ quantity: '101' })] })
    const saved = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const before = await balances()
    await reject(() => rpc('planning_issue_plan', confirmInput(saved.plans[0]!)), /Insufficient/)
    expect(await planRow(saved.plans[0]!.id)).toEqual(saved.plans[0])
    expect(await balances()).toEqual(before)
    expect((await db.query("select count(*)::int n from public.planning_change_history where entity_kind='PLAN_ISSUE'")).rows[0]).toEqual({ n: 0 })
  })

  it('does not treat independent manual issues as confirmations or rewrite their history', async () => {
    const bom = await createBom()
    const saved = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    const result = await rpc<Transaction>('stock_issue', { request_key: randomUUID(), material_id: ids.material, quantity: '3', unit: 'kg', issue_purpose: 'GENERAL', occurred_on: today, production_item: '수기 추가', production_batch: 'MANUAL', reason: '추가 불출', notes: '' })
    await rpc('planning_save_schedule', scheduleUpdate(saved.schedule, { multiplier: '2' }))
    expect(await planRow(saved.plans[0]!.id)).toMatchObject({ status: 'PLANNED', quantity: 10, stock_operation_id: null })
    expect(result.lines[0]!.on_hand_after).toBe(17)
  })

  it('allows cancelling a schedule after its BOM is deactivated but forbids reactivation', async () => {
    const bom = await createBom()
    const saved = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    await auth('admin')
    await rpc('planning_save_bom', bomUpdate(bom, { is_active: false }))
    await auth('operator')
    const cancelled = await rpc<SavedSchedule>('planning_save_schedule', scheduleUpdate(saved.schedule, { status: 'CANCELLED' }))
    await reject(() => rpc('planning_save_schedule', scheduleUpdate(cancelled.schedule, { status: 'ACTIVE' })), /Active BOM/)
  })

  it('rejects quantities that overflow or require hidden rounding after multiplication', async () => {
    const bom = await createBom({ components: [component({ quantity: '0.000001' })] })
    await reject(() => rpc('planning_save_schedule', scheduleInput(bom.id, { multiplier: '0.1' })), /range or precision/)
    const big = await createBom({ code: 'BIG', components: [component({ quantity: '999999999' })] })
    await reject(() => rpc('planning_save_schedule', scheduleInput(big.id, { multiplier: '2' })), /range or precision/)
  })

  it('rejects incompatible EA and unverified mass/volume BOM conversions at authoring time', async () => {
    await auth('admin')
    await db.query("update public.materials set base_unit='EA' where id=$1", [ids.second])
    await reject(() => rpc('planning_save_bom', bomInput({ components: [component({ material_id: ids.second, quantity: '18', unit: 'L', issue_purpose: 'CLEANING' })] })), /EA cannot be converted/)
    await db.query("update public.materials set base_unit='kg',density=null where id=$1", [ids.second])
    await reject(() => rpc('planning_save_bom', bomInput({ components: [component({ material_id: ids.second, quantity: '18', unit: 'L', issue_purpose: 'CLEANING' })] })), /Verified material density/)
    const bom = await rpc<Bom>('planning_save_bom', bomInput({ components: [component({ material_id: ids.second, unit: 'g' })] }))
    expect(bom.components[0]!.unit).toBe('g')
  })

  it('rechecks conversion and activation when generating plans from an older BOM', async () => {
    const bom = await createBom({ components: [component({ material_id: ids.second, quantity: '18', unit: 'L', issue_purpose: 'CLEANING' })] })
    await auth('admin')
    await db.query('update public.materials set density=null where id=$1', [ids.second])
    await reject(() => rpc('planning_save_schedule', scheduleInput(bom.id)), /Verified material density/)
    await db.query('update public.materials set density=1,is_active=false where id=$1', [ids.second])
    await reject(() => rpc('planning_save_schedule', scheduleInput(bom.id)), /Active material is required/)
    expect((await db.query('select count(*)::int n from public.production_schedules')).rows[0]).toEqual({ n: 0 })
  })

  it('protects BOM-only material references from deletion before any schedule exists', async () => {
    await createBom({ components: [component({ material_id: ids.second })] })
    await auth('admin')
    await reject(() => db.query('delete from public.materials where id=$1', [ids.second]), /referenced by a BOM/)
  })

  it.each([
    { components: [] }, { components: [component(), component()] },
    { components: [component({ quantity: '17', unit: 'L', issue_purpose: 'CLEANING' })] },
    { components: [component({ quantity: '18', unit: 'kg', issue_purpose: 'CLEANING' })] },
    { components: [component({ quantity: 'NaN' })] }, { components: [component({ quantity: '0.0000001' })] },
    { components: [component({ issue_purpose: 'OTHER' })] }, { components: [null] },
    { components: [{ ...component(), density: '1' }] }, { unauthorized: true },
  ])('rejects invalid BOM input at the database boundary: %j', async (overrides) => {
    await auth('admin')
    await expect(rpc('planning_save_bom', bomInput(overrides))).rejects.toThrow()
  })

  it('enforces admin-only BOM edits and operator/admin-only planning mutations', async () => {
    await reject(() => rpc('planning_save_bom', bomInput()), /permission denied/i)
    const bom = await createBom()
    const schedule = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    for (const role of ['viewer', 'disabled', 'anon'] as const) {
      await auth(role)
      await reject(() => rpc('planning_save_bom', bomInput()), /permission denied/i)
      await reject(() => rpc('planning_save_schedule', scheduleInput(bom.id, { code: 'UNAUTHORIZED' })), /permission denied/i)
      await reject(() => rpc('planning_issue_plan', confirmInput(schedule.plans[0]!)), /permission denied/i)
    }
  })

  it('allows active viewers to read plans, hides them from disabled users, and denies all direct writes', async () => {
    const bom = await createBom()
    const saved = await rpc<SavedSchedule>('planning_save_schedule', scheduleInput(bom.id))
    await auth('viewer')
    expect((await db.query('select count(*)::int n from public.issue_plan_rows')).rows[0]).toEqual({ n: 1 })
    await auth('disabled')
    expect((await db.query('select count(*)::int n from public.issue_plan_rows')).rows[0]).toEqual({ n: 0 })
    await auth('admin')
    for (const table of ['bom_recipes', 'production_schedules', 'stock_issue_plans', 'planning_change_history']) {
      await reject(() => db.query(`delete from public.${table}`), /permission denied/i)
    }
    await reject(() => db.query('select private.planning_schedule_result($1)', [saved.schedule.id]), /permission denied/i)
    await rpc('planning_issue_plan', confirmInput(saved.plans[0]!))
    await db.exec('set local role none')
    await reject(() => db.query("update public.stock_issue_plans set quantity=1 where id=$1", [saved.plans[0]!.id]), /immutable/)
    await reject(() => db.query('delete from public.planning_change_history'), /immutable/)
  })
})
