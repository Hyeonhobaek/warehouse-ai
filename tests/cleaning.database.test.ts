import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const ids = {
  operator: '00000000-0000-4000-8000-000000000002',
  admin: '00000000-0000-4000-8000-000000000003',
  viewer: '00000000-0000-4000-8000-000000000004',
  material: '10000000-0000-4000-8000-000000000001',
  lot: '20000000-0000-4000-8000-000000000001',
  warehouse: '30000000-0000-4000-8000-000000000001',
  otherWarehouse: '30000000-0000-4000-8000-000000000002',
  location: '40000000-0000-4000-8000-000000000001',
  otherLocation: '40000000-0000-4000-8000-000000000002',
  secondLocation: '40000000-0000-4000-8000-000000000003',
  old: '50000000-0000-4000-8000-000000000001',
  newer: '50000000-0000-4000-8000-000000000002',
}
type Line = { batch_id: string; location_id: string; quantity: number; on_hand_before: number; on_hand_after: number; test_number_snapshot: string }
type Result = { operation: { id: string; quantity: number; input_quantity: number; input_unit: string; issue_purpose: string; density_snapshot: number }; lines: Line[] }
type Preview = { available: number; raw_available: number; quantity: number; shortage: number; sufficient: boolean; block_liters: number | null; issue_purpose: string; input_quantity: number; input_unit: string; lines: Line[] }
let db: PGlite
let today: string

async function auth(role: 'operator' | 'admin' | 'viewer') {
  await db.exec('set local role authenticated')
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ids[role]])
}
async function owner() { await db.exec('set local role none') }
async function call<T>(name: string, input: Record<string, unknown>) {
  const result = await db.query<{ result: T }>(`select public.${name}($1::jsonb) result`, [JSON.stringify(input)])
  return result.rows[0]!.result
}
const issue = (input: Record<string, unknown>) => call<Result>('stock_issue', input)
const preview = (input: Record<string, unknown>) => call<Preview>('stock_preview_issue', input)
function cleaning(overrides: Record<string, unknown> = {}) {
  return { request_key: randomUUID(), material_id: ids.material, quantity: '36', unit: 'L', issue_purpose: 'CLEANING',
    occurred_on: today, production_item: '', production_batch: '', reason: '가상 세척 불출', notes: '', ...overrides }
}
async function reject(work: () => Promise<unknown>, pattern: RegExp) {
  await db.exec('savepoint expected_failure')
  await expect(work()).rejects.toThrow(pattern)
  await db.exec('rollback to savepoint expected_failure')
}
async function balance(batch: string, quantity: string, reserved = '0', held = '0') {
  await owner()
  await db.query('update public.stock_balances set on_hand=$2::numeric,reserved=$3::numeric,held=$4::numeric where batch_id=$1', [batch, quantity, reserved, held])
  await auth('operator')
}
async function remaining() {
  return (await db.query<{ batch_id: string; on_hand: string }>('select batch_id,on_hand::text from public.stock_balances order by batch_id,location_id')).rows
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;`)
  for (const file of ['20261029000100_identity_foundation.sql', '20261030000100_inventory_foundation.sql', '20261030000200_stock_transactions.sql', '20261030000300_cleaning_fifo.sql']) {
    await db.exec(await readFile(fileURLToPath(new URL(`../supabase/migrations/${file}`, import.meta.url)), 'utf8'))
  }
  for (const role of ['operator', 'admin', 'viewer'] as const) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [ids[role], `${role}@example.test`])
  }
  await db.exec(`begin; set local app.audit_reason = '가상 테스트 권한';
    update public.profiles set role='admin' where id='${ids.admin}';
    update public.profiles set role='operator' where id='${ids.operator}'; commit;
    insert into public.materials(id,code,name,base_unit,density) values('${ids.material}','CLEAN-DEMO','가상 세척 원료','kg',0.8);
    insert into public.material_lots(id,material_id,lot_number) values('${ids.lot}','${ids.material}','SAME-LOT');
    insert into public.warehouses(id,code,name) values('${ids.warehouse}','MAIN','가상창고'),('${ids.otherWarehouse}','OTHER','다른창고');
    insert into public.storage_locations(id,warehouse_id,code,name) values
      ('${ids.location}','${ids.warehouse}','A','A위치'),('${ids.otherLocation}','${ids.otherWarehouse}','B','B위치'),('${ids.secondLocation}','${ids.warehouse}','C','C위치');
    insert into public.stock_batches(id,lot_id,receipt_reference,received_on,expires_on,test_number,quality_status,quality_reason,created_at) values
      ('${ids.old}','${ids.lot}','CLEAN-A',current_date-10,current_date+100,'ZZ-OLD','APPROVED','가상 승인',now()-interval '10 days'),
      ('${ids.newer}','${ids.lot}','CLEAN-B',current_date-5,current_date+1,'AA-NEW','APPROVED','가상 승인',now()-interval '5 days');
    insert into public.stock_balances(batch_id,location_id,on_hand) values
      ('${ids.old}','${ids.location}',20),('${ids.newer}','${ids.otherLocation}',80);`)
  today = (await db.query<{ today: string }>("select (now() at time zone 'Asia/Seoul')::date::text today")).rows[0]!.today
}, 30_000)
beforeEach(async () => { await db.exec('begin'); await auth('operator') })
afterEach(async () => { await db.exec('rollback') })
afterAll(async () => { await db?.close() })

describe('Cleaning 18 L receipt FIFO', () => {
  it('allocates 18 + 18 L from 25 + 100 L and preserves the old 7 L with the same LOT', async () => {
    const input = cleaning()
    const plan = await preview(input)
    expect(plan).toMatchObject({ available: 86.4, raw_available: 100, quantity: 28.8, input_quantity: 36, input_unit: 'L', issue_purpose: 'CLEANING', block_liters: 18, sufficient: true })
    expect(plan.lines.map(line => [line.batch_id, line.quantity])).toEqual([[ids.old, 14.4], [ids.newer, 14.4]])
    const result = await issue(input)
    expect(result.operation).toMatchObject({ quantity: 28.8, input_quantity: 36, input_unit: 'L', density_snapshot: 0.8, issue_purpose: 'CLEANING' })
    expect(result.lines.map(line => [line.batch_id, line.quantity, line.on_hand_after])).toEqual([[ids.old, 14.4, 5.6], [ids.newer, 14.4, 65.6]])
    expect(await remaining()).toEqual([{ batch_id: ids.old, on_hand: '5.600000' }, { batch_id: ids.newer, on_hand: '65.600000' }])
    expect((await db.query('select distinct issue_purpose from public.stock_ledger_rows')).rows).toEqual([{ issue_purpose: 'CLEANING' }])
  })
  it('skips an old receipt below 18 L without consuming any of its remainder', async () => {
    await balance(ids.old, '14.399999')
    const result = await issue(cleaning())
    expect(result.lines.map(line => [line.batch_id, line.quantity])).toEqual([[ids.newer, 28.8]])
    expect((await remaining())[0]!.on_hand).toBe('14.399999')
  })
  it('does not combine incomplete blocks across different receipt or test numbers', async () => {
    await balance(ids.old, '10')
    await balance(ids.newer, '10')
    const input = cleaning({ quantity: '18' })
    expect(await preview(input)).toMatchObject({ raw_available: 20, available: 0, shortage: 14.4, sufficient: false, lines: [] })
    await reject(() => issue(input), /Insufficient/)
    expect((await db.query('select count(*)::int total from public.stock_operations')).rows[0]).toEqual({ total: 0 })
  })
  it('counts reserved and held stock before calculating complete blocks', async () => {
    await balance(ids.old, '20', '2', '4')
    const result = await issue(cleaning({ quantity: '18' }))
    expect(result.lines.map(line => line.batch_id)).toEqual([ids.newer])
    expect((await remaining())[0]!.on_hand).toBe('20.000000')
  })
  it('aggregates a receipt across locations and deducts in stable location order', async () => {
    await balance(ids.old, '8')
    await owner()
    await db.query('insert into public.stock_balances(batch_id,location_id,on_hand) values($1,$2,12)', [ids.old, ids.secondLocation])
    await auth('operator')
    const input = cleaning()
    const planned = await preview(input)
    const saved = await issue(input)
    const allocations = [[ids.old, ids.location, 8], [ids.old, ids.secondLocation, 6.4], [ids.newer, ids.otherLocation, 14.4]]
    expect(planned.lines.map(line => [line.batch_id, line.location_id, line.quantity])).toEqual(allocations)
    expect(saved.lines.map(line => [line.batch_id, line.location_id, line.quantity])).toEqual(allocations)
  })
  it('does not combine a receipt across an excluded warehouse to form a block', async () => {
    await balance(ids.old, '8')
    await owner()
    await db.query('insert into public.stock_balances(batch_id,location_id,on_hand) values($1,$2,12)', [ids.old, ids.otherLocation])
    await auth('operator')
    const scoped = cleaning({ quantity: '18', warehouse_id: ids.warehouse })
    expect(await preview(scoped)).toMatchObject({ available: 0, raw_available: 8, sufficient: false })
    await reject(() => issue(scoped), /Insufficient/)
    const result = await issue(cleaning({ quantity: '18' }))
    expect(result.lines.map(line => [line.batch_id, line.quantity])).toEqual([[ids.old, 8], [ids.old, 6.4]])
  })
  it('rolls back an otherwise possible partial plan when whole-block stock is short', async () => {
    const before = await remaining()
    const input = cleaning({ quantity: '126' })
    expect(await preview(input)).toMatchObject({ available: 86.4, raw_available: 100, shortage: 14.4, sufficient: false })
    await reject(() => issue(input), /Insufficient/)
    expect(await remaining()).toEqual(before)
    expect((await db.query('select count(*)::int total from public.stock_operations')).rows[0]).toEqual({ total: 0 })
  })
  it('leaves GENERAL FIFO unchanged and allows GENERAL to consume cleaning remainders', async () => {
    await issue(cleaning())
    const input = cleaning({ quantity: '7', unit: 'kg', issue_purpose: 'GENERAL' })
    const plan = await preview(input)
    expect(plan).toMatchObject({ issue_purpose: 'GENERAL', block_liters: null, available: 71.2 })
    const result = await issue(input)
    expect(result.lines.map(line => [line.batch_id, line.quantity])).toEqual([[ids.old, 5.6], [ids.newer, 1.4]])
    expect(result.operation.issue_purpose).toBe('GENERAL')
  })
  it('defaults omitted purpose to GENERAL', async () => {
    const { issue_purpose: _purpose, ...input } = cleaning({ quantity: '36' })
    const result = await issue(input)
    expect(result.operation.issue_purpose).toBe('GENERAL')
    expect(result.lines.map(line => line.quantity)).toEqual([20, 8.8])
  })
  it.each(['1', '17', '19', '25', '35.999999', '0', '-18', 'NaN', '1e2'])('rejects non-block cleaning quantity %s', async quantity => {
    await reject(() => issue(cleaning({ quantity })), /18 L|Quantity/)
    await reject(() => preview(cleaning({ quantity })), /18 L|Quantity/)
  })
  it.each(['kg', 'mL', 'g', 'EA'])('rejects cleaning input unit %s', async unit => {
    await reject(() => issue(cleaning({ unit })), /18 L/)
    await reject(() => preview(cleaning({ unit })), /18 L/)
  })
  it('rejects unknown purpose and absent density', async () => {
    await reject(() => issue(cleaning({ issue_purpose: 'OTHER' })), /Issue purpose/)
    await reject(() => preview(cleaning({ issue_purpose: 'OTHER' })), /Issue purpose/)
    await auth('admin')
    await db.query('update public.materials set density=null where id=$1', [ids.material])
    await auth('operator')
    await reject(() => issue(cleaning()), /density/)
    await reject(() => preview(cleaning()), /density/)
  })
  it.each(['L', 'mL', 'g', 'EA'] as const)('handles %s inventory units without guessing density or count conversion', async baseUnit => {
    await owner()
    const material = randomUUID(), lot = randomUUID(), batch = randomUUID()
    await db.query('insert into public.materials(id,code,name,base_unit,density) values($1,$2,$3,$4,$5)', [material, baseUnit, '가상 단위 원료', baseUnit, baseUnit === 'g' ? '0.789123' : null])
    await db.query('insert into public.material_lots(id,material_id,lot_number) values($1,$2,$3)', [lot, material, 'UNIT-LOT'])
    await db.query("insert into public.stock_batches(id,lot_id,receipt_reference,received_on,expires_on,test_number,quality_status,quality_reason) values($1,$2,$3,current_date-1,current_date+10,'UNIT-TEST','APPROVED','가상 승인')", [batch, lot, material])
    await db.query('insert into public.stock_balances(batch_id,location_id,on_hand) values($1,$2,1000000)', [batch, ids.location])
    await auth('operator')
    const input = cleaning({ material_id: material, quantity: '18' })
    if (baseUnit === 'EA') {
      await reject(() => issue(input), /not supported for EA/)
      await reject(() => preview(input), /not supported for EA/)
    } else {
      const quantity = baseUnit === 'L' ? 18 : baseUnit === 'mL' ? 18000 : 14204.214
      expect((await preview(input)).quantity).toBe(quantity)
      const result = await issue(input)
      expect(result.operation.quantity).toBe(quantity)
      expect(result.lines[0]!.quantity).toBe(quantity)
    }
  })
  it('uses exact six-decimal block boundaries and preserves quantity conservation', async () => {
    await auth('admin'); await db.query('update public.materials set density=0.789123 where id=$1', [ids.material]); await auth('operator')
    await balance(ids.old, '28.408427')
    await balance(ids.newer, '28.408428')
    const input = cleaning({ quantity: '54' })
    const plan = await preview(input)
    expect(plan).toMatchObject({ available: 42.612642, quantity: 42.612642, sufficient: true })
    expect(plan.lines.map(line => line.quantity)).toEqual([14.204214, 28.408428])
    const saved = await issue(input)
    const accounting = await db.query('select o.quantity::text quantity,sum(l.quantity)::text lines,sum(l.delta)::text delta from public.stock_operations o join public.stock_transaction_lines l on l.operation_id=o.id where o.id=$1 group by o.quantity', [saved.operation.id])
    expect(accounting.rows).toEqual([{ quantity: '42.612642', lines: '42.612642', delta: '-42.612642' }])
    expect((await remaining())[0]!.on_hand).toBe('14.204213')
  })
  it.each(['HOLD', 'PENDING', 'REJECTED', 'EXPIRED', 'UNKNOWN', 'INACTIVE_LOCATION', 'INACTIVE_WAREHOUSE'] as const)('excludes %s inventory from complete blocks', async condition => {
    await auth('admin')
    if (condition === 'EXPIRED' || condition === 'UNKNOWN') {
      await db.query(`update public.stock_batches set expires_on=${condition === 'EXPIRED' ? 'current_date-1' : 'null'},quality_reason='가상 기한 변경' where id=$1`, [ids.old])
    } else if (condition === 'INACTIVE_LOCATION') {
      await db.query('update public.storage_locations set is_active=false where id=$1', [ids.location])
    } else if (condition === 'INACTIVE_WAREHOUSE') {
      await db.query('update public.warehouses set is_active=false where id=$1', [ids.warehouse])
    } else await db.query('update public.stock_batches set quality_status=$2,quality_reason=$3 where id=$1', [ids.old, condition, '가상 QC 변경'])
    await auth('operator')
    const input = cleaning({ quantity: '18' })
    expect((await preview(input)).lines.map(line => line.batch_id)).toEqual([ids.newer])
    expect((await issue(input)).lines.map(line => line.batch_id)).toEqual([ids.newer])
  })
  it('preserves retest history, idempotency and the original conversion snapshot', async () => {
    const input = cleaning()
    const first = await issue(input)
    await auth('admin')
    await db.query("update public.stock_batches set test_number='RETEST',quality_reason='가상 재시험' where id=$1", [ids.old])
    await db.query('update public.materials set density=0.9 where id=$1', [ids.material])
    await auth('operator')
    expect(await issue(input)).toEqual(first)
    await reject(() => issue({ ...input, issue_purpose: 'GENERAL' }), /Request key/)
    const ledger = await db.query('select test_number_snapshot,current_test_number,density_snapshot::float,input_quantity::float,input_unit,issue_purpose from public.stock_ledger_rows where operation_id=$1 order by sequence', [first.operation.id])
    expect(ledger.rows[0]).toEqual({ test_number_snapshot: 'ZZ-OLD', current_test_number: 'RETEST', density_snapshot: 0.8, input_quantity: 36, input_unit: 'L', issue_purpose: 'CLEANING' })
  })
  it('rechecks current stock after a preview and rejects backdated allocation changes', async () => {
    const input = cleaning({ quantity: '108' })
    expect((await preview(input)).sufficient).toBe(true)
    await issue(cleaning())
    await reject(() => issue(input), /Insufficient/)
    const yesterday = (await db.query<{ date: string }>("select ((now() at time zone 'Asia/Seoul')::date-1)::text date")).rows[0]!.date
    await reject(() => issue(cleaning({ quantity: '18', occurred_on: yesterday })), /latest balance/)
    await reject(() => preview(cleaning({ quantity: '18', occurred_on: yesterday })), /latest balance/)
  })
  it('allows viewer previews but blocks stock writes and private allocator invocation', async () => {
    await auth('viewer')
    expect((await preview(cleaning())).sufficient).toBe(true)
    await reject(() => issue(cleaning()), /permission denied/i)
    await reject(() => db.query('select private.stock_issue_plan($1,18,current_date,null,18)', [ids.material]), /permission denied/i)
    await reject(() => db.query("update public.stock_operations set issue_purpose='GENERAL'"), /permission denied/i)
  })
})
