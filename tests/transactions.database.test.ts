import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const ids = {
  viewer: '00000000-0000-4000-8000-000000000001',
  operator: '00000000-0000-4000-8000-000000000002',
  admin: '00000000-0000-4000-8000-000000000003',
  disabled: '00000000-0000-4000-8000-000000000004',
  material: '10000000-0000-4000-8000-000000000001',
  lot: '20000000-0000-4000-8000-000000000001',
  warehouse: '30000000-0000-4000-8000-000000000001',
  otherWarehouse: '30000000-0000-4000-8000-000000000002',
  location: '40000000-0000-4000-8000-000000000001',
  otherLocation: '40000000-0000-4000-8000-000000000002',
  old: '50000000-0000-4000-8000-000000000001',
  newer: '50000000-0000-4000-8000-000000000002',
  hold: '50000000-0000-4000-8000-000000000003',
  expired: '50000000-0000-4000-8000-000000000004',
  unknown: '50000000-0000-4000-8000-000000000005',
}
type Result = { operation: { id: string; kind: string; quantity: number; actor_id: string; actor_name: string; density_snapshot: number }; lines: { id: string; batch_id: string; location_id: string; quantity: number; on_hand_before: number; on_hand_after: number; test_number_snapshot: string }[] }
let db: PGlite
let today: string
let yesterday: string

async function auth(role: 'viewer' | 'operator' | 'admin' | 'disabled' | 'anon') {
  await db.exec(`set local role ${role === 'anon' ? 'anon' : 'authenticated'}`)
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [role === 'anon' ? '' : ids[role]])
}
async function owner() { await db.exec('set local role none') }
async function rpc(name: string, input: Record<string, unknown>) {
  const result = await db.query<{ result: Result }>(`select public.${name}($1::jsonb) result`, [JSON.stringify(input)])
  return result.rows[0]!.result
}
function issue(overrides: Record<string, unknown> = {}) {
  return { request_key: randomUUID(), material_id: ids.material, quantity: '15', unit: 'kg', occurred_on: today,
    production_item: '가상 품목', production_batch: 'PROD-001', reason: '가상 생산 불출', notes: '', ...overrides }
}
function receipt(overrides: Record<string, unknown> = {}) {
  return { request_key: randomUUID(), material_id: ids.material, lot_number: '0000456', location_id: ids.location,
    quantity: '10', unit: 'kg', received_on: today, receipt_reference: 'RCV-NEW', test_number: 'RP-NEW',
    reason: '가상 입고', notes: '', ...overrides }
}
function returning(line: string, overrides: Record<string, unknown> = {}) {
  return { request_key: randomUUID(), issue_line_id: line, location_id: ids.location, quantity: '3', unit: 'kg',
    occurred_on: today, reason: '미사용 반납', notes: '', ...overrides }
}
function release(line: string, overrides: Record<string, unknown> = {}) {
  return { request_key: randomUUID(), return_line_id: line, quantity: '2', unit: 'kg', occurred_on: today,
    reason: '반납품 확인 완료', notes: '', ...overrides }
}
async function reject(work: () => Promise<unknown>, pattern: RegExp) {
  await db.exec('savepoint expected_failure')
  await expect(work()).rejects.toThrow(pattern)
  await db.exec('rollback to savepoint expected_failure')
}
async function quantities() {
  return (await db.query<{ batch_id: string; on_hand: number; held: number; available: number }>(
    'select batch_id, on_hand::float, held::float, available::float from public.inventory_rows order by batch_id, location_id')).rows
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
  for (const role of ['viewer', 'operator', 'admin', 'disabled'] as const) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [ids[role], `${role}@example.test`])
  }
  await db.exec(`begin; set local app.audit_reason = '가상 테스트 권한';
    update public.profiles set role = 'admin' where id = '${ids.admin}';
    update public.profiles set role = 'operator' where id = '${ids.operator}';
    update public.profiles set is_active = false where id = '${ids.disabled}'; commit;
    insert into public.materials(id,code,name,base_unit,density) values('${ids.material}','DEMO-TEST','가상 원료','kg',0.8);
    insert into public.material_lots(id,material_id,lot_number) values('${ids.lot}','${ids.material}','000123');
    insert into public.warehouses(id,code,name) values('${ids.warehouse}','MAIN','가상창고'),('${ids.otherWarehouse}','OTHER','다른창고');
    insert into public.storage_locations(id,warehouse_id,code,name) values('${ids.location}','${ids.warehouse}','A','A위치'),('${ids.otherLocation}','${ids.otherWarehouse}','B','B위치');
    insert into public.stock_batches(id,lot_id,receipt_reference,received_on,expires_on,test_number,quality_status,quality_reason,created_at) values
      ('${ids.old}','${ids.lot}','RCV-A',current_date-10,current_date+100,'ZZ-OLD','APPROVED','가상 승인',now()-interval '10 days'),
      ('${ids.newer}','${ids.lot}','RCV-B',current_date-5,current_date+1,'AA-NEW','APPROVED','가상 승인',now()-interval '5 days'),
      ('${ids.hold}','${ids.lot}','RCV-H',current_date-20,current_date+100,'HOLD','HOLD','가상 보류',now()-interval '20 days'),
      ('${ids.expired}','${ids.lot}','RCV-E',current_date-30,current_date-1,'EXPIRED','APPROVED','가상 승인',now()-interval '30 days'),
      ('${ids.unknown}','${ids.lot}','RCV-U',current_date-40,null,'UNKNOWN','APPROVED','기한 미확인',now()-interval '40 days');
    insert into public.stock_balances(batch_id,location_id,on_hand,reserved) values
      ('${ids.old}','${ids.location}',10,2),('${ids.newer}','${ids.otherLocation}',50,0),
      ('${ids.hold}','${ids.location}',100,0),('${ids.expired}','${ids.location}',100,0),('${ids.unknown}','${ids.location}',100,0);`)
  const dates = await db.query<{ today: string; yesterday: string }>("select (now() at time zone 'Asia/Seoul')::date::text today, ((now() at time zone 'Asia/Seoul')::date-1)::text yesterday")
  today = dates.rows[0]!.today
  yesterday = dates.rows[0]!.yesterday
}, 30_000)
beforeEach(async () => { await db.exec('begin'); await auth('operator') })
afterEach(async () => { await db.exec('rollback') })
afterAll(async () => { await db?.close() })

describe('Phase 3 atomic stock operations', () => {
  it('receives a textual LOT as new PENDING stock with immutable actor and quantity snapshots', async () => {
    const result = await rpc('stock_receive', receipt())
    expect(result.operation).toMatchObject({ kind: 'RECEIPT', quantity: 10, actor_id: ids.operator, actor_name: 'operator' })
    const row = await db.query('select lot_number, quality_status, available::float, on_hand::float from public.inventory_rows where batch_id=$1', [result.lines[0]!.batch_id])
    expect(row.rows).toEqual([{ lot_number: '0000456', quality_status: 'PENDING', available: 0, on_hand: 10 }])
    expect(result.lines[0]).toMatchObject({ quantity: 10, on_hand_before: 0, on_hand_after: 10, test_number_snapshot: 'RP-NEW' })
  })
  it('uses actual receipt FIFO, reservations and split allocation, not expiry/test number sorting', async () => {
    const result = await rpc('stock_issue', issue())
    expect(result.lines.map(line => [line.batch_id, line.quantity, line.on_hand_after])).toEqual([[ids.old, 8, 2], [ids.newer, 7, 43]])
    expect((await quantities()).map(row => row.available)).toEqual([0, 43, 0, 0, 0])
  })
  it('rolls back the full request, operation and all allocations when stock is insufficient', async () => {
    const before = await quantities()
    await reject(() => rpc('stock_issue', issue({ quantity: '59' })), /Insufficient/)
    expect(await quantities()).toEqual(before)
    expect((await db.query('select count(*)::int total from public.stock_operations')).rows).toEqual([{ total: 0 }])
  })
  it('respects optional warehouse scope and does not borrow from another warehouse', async () => {
    await reject(() => rpc('stock_issue', issue({ warehouse_id: ids.warehouse, quantity: '9' })), /Insufficient/)
    const result = await rpc('stock_issue', issue({ warehouse_id: ids.otherWarehouse, quantity: '9' }))
    expect(result.lines.map(line => [line.batch_id, line.quantity])).toEqual([[ids.newer, 9]])
  })
  it('replays exactly once and rejects key reuse with changed input or another actor', async () => {
    const input = issue()
    const first = await rpc('stock_issue', input)
    expect(await rpc('stock_issue', input)).toEqual(first)
    await reject(() => rpc('stock_issue', { ...input, quantity: '16' }), /Request key/)
    await auth('admin')
    await reject(() => rpc('stock_issue', input), /Request key/)
    expect((await db.query('select count(*)::int total from public.stock_operations')).rows).toEqual([{ total: 1 }])
  })
  it('returns against a specific allocation, holds quantity, prevents over-return and releases only held stock', async () => {
    const issued = await rpc('stock_issue', issue({ quantity: '5' }))
    const returned = await rpc('stock_return', returning(issued.lines[0]!.id))
    expect((await quantities())[0]).toMatchObject({ on_hand: 8, held: 3, available: 3 })
    await reject(() => rpc('stock_return', returning(issued.lines[0]!.id)), /exceeds/)
    await reject(() => rpc('stock_release_return', release(returned.lines[0]!.id)), /permission denied/i)
    await auth('admin')
    await rpc('stock_release_return', release(returned.lines[0]!.id))
    expect((await quantities())[0]).toMatchObject({ on_hand: 8, held: 1, available: 5 })
    await reject(() => rpc('stock_release_return', release(returned.lines[0]!.id)), /exceeds/)
    const remaining = await db.query('select kind,returnable_quantity::float,releasable_quantity::float from public.stock_ledger_rows order by created_at')
    expect(remaining.rows).toEqual([{ kind: 'ISSUE', returnable_quantity: 2, releasable_quantity: 0 }, { kind: 'RETURN', returnable_quantity: 0, releasable_quantity: 1 }, { kind: 'RETURN_RELEASE', returnable_quantity: 0, releasable_quantity: 0 }])
  })
  it('does not make held returns available through ordinary QC approval and excludes held from further FIFO', async () => {
    const issued = await rpc('stock_issue', issue({ quantity: '8' }))
    const returned = await rpc('stock_return', returning(issued.lines[0]!.id, { quantity: '8' }))
    await auth('admin')
    await db.query("update public.stock_batches set quality_status='APPROVED', quality_reason='재확인' where id=$1", [ids.old])
    await auth('operator')
    const next = await rpc('stock_issue', issue({ quantity: '1' }))
    expect(next.lines[0]!.batch_id).toBe(ids.newer)
    expect(returned.lines[0]!.on_hand_after).toBe(10)
  })
  it('can return expired stock but cannot release it', async () => {
    const issued = await rpc('stock_issue', issue({ quantity: '5' }))
    await auth('admin')
    await db.query("update public.stock_batches set expires_on=current_date-1, quality_reason='기간 종료' where id=$1", [ids.old])
    const returned = await rpc('stock_return', returning(issued.lines[0]!.id))
    await reject(() => rpc('stock_release_return', release(returned.lines[0]!.id)), /not eligible/)
  })
  it('uses kg/g and verified kg/L conversions once and keeps the density snapshot', async () => {
    const byMass = await rpc('stock_issue', issue({ quantity: '1000', unit: 'g' }))
    const byVolume = await rpc('stock_issue', issue({ quantity: '1000', unit: 'mL' }))
    expect(byMass.operation.quantity).toBe(1)
    expect(byVolume.operation).toMatchObject({ quantity: 0.8, density_snapshot: 0.8 })
    await auth('admin')
    await db.query('update public.materials set density=0.9 where id=$1', [ids.material])
    await auth('operator')
    await reject(() => rpc('stock_return', returning(byVolume.lines[0]!.id, { quantity: '1', unit: 'L' })), /base unit/)
    expect((await rpc('stock_return', returning(byVolume.lines[0]!.id, { quantity: '0.8' }))).operation.quantity).toBe(0.8)
  })
  it.each(['0', '-1', 'NaN', 'Infinity', '1e2', '0.0000001', '1000000000'])('rejects invalid quantity %s in the database', async (quantity) => {
    await expect(rpc('stock_issue', issue({ quantity }))).rejects.toThrow(/Quantity|quantity/)
  })
  it('rejects density-free cross-dimension conversion and EA conversion', async () => {
    await auth('admin'); await db.query('update public.materials set density=null where id=$1', [ids.material]); await auth('operator')
    await reject(() => rpc('stock_issue', issue({ quantity: '1', unit: 'L' })), /density/)
    await reject(() => rpc('stock_issue', issue({ quantity: '1', unit: 'EA' })), /EA/)
  })
  it('preserves FIFO and historical test numbers after retesting, blocks receipt identity changes', async () => {
    const issued = await rpc('stock_issue', issue({ quantity: '1' }))
    await auth('admin')
    await db.query("update public.stock_batches set test_number='RETEST-NEW', quality_reason='재시험' where id=$1", [ids.old])
    await reject(() => db.query('update public.stock_batches set received_on=current_date where id=$1', [ids.old]), /immutable/)
    await reject(() => db.query("update public.stock_batches set receipt_reference='OTHER-REF' where id=$1", [ids.old]), /immutable/)
    await reject(() => db.query("update public.material_lots set lot_number='REPLACED' where id=$1", [ids.lot]), /immutable/)
    const history = await db.query('select test_number_snapshot,current_test_number from public.stock_ledger_rows where id=$1', [issued.lines[0]!.id])
    expect(history.rows).toEqual([{ test_number_snapshot: 'ZZ-OLD', current_test_number: 'RETEST-NEW' }])
    const next = await rpc('stock_issue', issue({ quantity: '1' }))
    expect(next.lines[0]).toMatchObject({ batch_id: ids.old, test_number_snapshot: 'RETEST-NEW' })
  })
  it('finds every transaction of a cohort using an intermediate test number with no stock movements', async () => {
    const first = await rpc('stock_issue', issue({ quantity: '1' }))
    await auth('admin')
    await db.query("update public.stock_batches set test_number='INTERMEDIATE-QC', quality_reason='중간 재시험' where id=$1", [ids.old])
    await db.query("update public.stock_batches set test_number='LATEST-QC', quality_reason='최종 재시험' where id=$1", [ids.old])
    const second = await rpc('stock_issue', issue({ quantity: '1' }))
    const ledger = await db.query<{ id: string }>("select id from public.stock_ledger_rows where search_text like '%intermediate-qc%'")
    expect(ledger.rows.map(row => row.id).sort()).toEqual([first.lines[0]!.id, second.lines[0]!.id].sort())
    const picker = await db.query('select batch_id from public.stock_batch_options where search_text like $1', ['%intermediate-qc%'])
    expect(picker.rows).toEqual([{ batch_id: ids.old }])
  })
  it('rejects future dates and dates before later recorded balance movements', async () => {
    const future = (await db.query<{ date: string }>("select ((now() at time zone 'Asia/Seoul')::date+1)::text date")).rows[0]!.date
    await reject(() => rpc('stock_issue', issue({ occurred_on: future })), /actual date/)
    const first = await rpc('stock_issue', issue({ quantity: '1' }))
    await reject(() => rpc('stock_issue', issue({ quantity: '1', occurred_on: yesterday })), /latest balance/)
    await reject(() => rpc('stock_return', returning(first.lines[0]!.id, { quantity: '1', occurred_on: yesterday })), /precedes issue/)
  })
  it('preview has no writes and actual save recalculates against intervening issues', async () => {
    const input = issue({ quantity: '50' })
    const preview = await db.query<{ result: { available: number; shortage: number; lines: { quantity: number }[] } }>('select public.stock_preview_issue($1::jsonb) result', [JSON.stringify(input)])
    expect(preview.rows[0]!.result).toMatchObject({ available: 58, shortage: 0 })
    expect(preview.rows[0]!.result.lines.map(line => line.quantity)).toEqual([8, 42])
    expect((await db.query('select count(*)::int total from public.stock_operations')).rows).toEqual([{ total: 0 }])
    await rpc('stock_issue', issue({ quantity: '10' }))
    await reject(() => rpc('stock_issue', input), /Insufficient/)
  })
  it('reuses a LOT without editing metadata and rolls back metadata conflicts', async () => {
    const result = await rpc('stock_receive', receipt({ lot_number: '000123' }))
    expect(result.lines).toHaveLength(1)
    await reject(() => rpc('stock_receive', receipt({ lot_number: '000123', manufacturer: '다른 회사', receipt_reference: 'CONFLICT' })), /metadata differs/)
  })
  it('uses stable cohort and location identifiers for tied receipt dates', async () => {
    await owner()
    // Fixture-only setup bypasses the immutable receipt guard by adding cohorts.
    const tiedA = '50000000-0000-4000-8000-000000000006'
    const tiedB = '50000000-0000-4000-8000-000000000007'
    await db.exec(`insert into public.stock_batches(id,lot_id,receipt_reference,received_on,expires_on,test_number,quality_status,quality_reason,created_at) values
      ('${tiedA}','${ids.lot}','TIE-A',current_date-50,current_date+100,'ZZ-TIE','APPROVED','동률 검증',now()-interval '50 days'),
      ('${tiedB}','${ids.lot}','TIE-B',current_date-50,current_date+100,'AA-TIE','APPROVED','동률 검증',now()-interval '50 days');
      insert into public.stock_balances(batch_id,location_id,on_hand) values
      ('${tiedB}','${ids.location}',3),('${tiedA}','${ids.otherLocation}',2),('${tiedA}','${ids.location}',1);`)
    await auth('operator')
    const result = await rpc('stock_issue', issue({ quantity: '5' }))
    expect(result.lines.map(line => [line.batch_id, line.location_id, line.quantity])).toEqual([
      [tiedA, ids.location, 1], [tiedA, ids.otherLocation, 2], [tiedB, ids.location, 2],
    ])
  })
  it.each(['material', 'location', 'warehouse'] as const)('excludes inactive %s and never changes its stock', async (target) => {
    await auth('admin')
    const table = target === 'material' ? 'materials' : target === 'location' ? 'storage_locations' : 'warehouses'
    await db.query(`update public.${table} set is_active=false where id=$1`, [ids[target]])
    await auth('operator')
    if (target === 'material') await expect(rpc('stock_issue', issue({ quantity: '1' }))).rejects.toThrow(/Active material/)
    else {
      const result = await rpc('stock_issue', issue({ quantity: '1' }))
      expect(result.lines[0]!.batch_id).toBe(ids.newer)
      expect((await quantities())[0]).toMatchObject({ on_hand: 10, available: 0 })
    }
  })
  it('supports a held return to another active location without changing its receipt cohort', async () => {
    const issued = await rpc('stock_issue', issue({ quantity: '5' }))
    const returned = await rpc('stock_return', returning(issued.lines[0]!.id, { location_id: ids.otherLocation }))
    expect(returned.lines[0]).toMatchObject({ batch_id: ids.old, location_id: ids.otherLocation, on_hand_before: 0, on_hand_after: 3 })
    const original = await db.query('select received_on_snapshot from public.stock_transaction_lines where id=$1', [returned.lines[0]!.id])
    const first = await db.query('select received_on_snapshot from public.stock_transaction_lines where id=$1', [issued.lines[0]!.id])
    expect(original.rows).toEqual(first.rows)
    await auth('admin')
    await rpc('stock_release_return', release(returned.lines[0]!.id, { quantity: '3' }))
    const next = await rpc('stock_issue', issue({ quantity: '6' }))
    expect(next.lines.map(line => [line.batch_id, line.location_id, line.quantity])).toEqual([[ids.old, ids.location, 3], [ids.old, ids.otherLocation, 3]])
  })
  it('rounds conversion only at six decimals and rejects quantities lost below accounting precision', async () => {
    const rounded = await rpc('stock_issue', issue({ quantity: '0.000001', unit: 'L' }))
    expect(rounded.operation.quantity).toBe(0.000001)
    await reject(() => rpc('stock_issue', issue({ quantity: '0.000001', unit: 'mL' })), /below precision/)
  })
  it('checks release date, original line kinds and base unit in the database', async () => {
    const issued = await rpc('stock_issue', issue({ quantity: '5' }))
    const returned = await rpc('stock_return', returning(issued.lines[0]!.id))
    await reject(() => rpc('stock_return', returning(returned.lines[0]!.id)), /must reference an issue/)
    await auth('admin')
    await reject(() => rpc('stock_release_return', release(issued.lines[0]!.id)), /must reference a return/)
    await reject(() => rpc('stock_release_return', release(returned.lines[0]!.id, { occurred_on: yesterday })), /precedes return/)
    await reject(() => rpc('stock_release_return', release(returned.lines[0]!.id, { unit: 'g' })), /base unit/)
  })
  it('ignores spoofed actor and QC fields in direct RPC inputs', async () => {
    const result = await rpc('stock_receive', receipt({ actor_id: ids.admin, actor_name: 'spoof', quality_status: 'APPROVED' }))
    expect(result.operation.actor_id).toBe(ids.operator)
    expect(result.operation.actor_name).toBe('operator')
    const batch = await db.query('select quality_status from public.stock_batches where id=$1', [result.lines[0]!.batch_id])
    expect(batch.rows).toEqual([{ quality_status: 'PENDING' }])
  })
})

describe('Phase 3 direct database authorization', () => {
  it.each(['viewer', 'disabled', 'anon'] as const)('denies %s stock writes', async (role) => {
    await auth(role)
    await expect(rpc('stock_issue', issue())).rejects.toThrow(/permission denied/i)
  })
  it.each(['stock_operations', 'stock_transaction_lines', 'stock_balances'])('denies direct admin mutations to %s', async (table) => {
    await auth('admin')
    await expect(db.exec(`delete from public.${table}`)).rejects.toThrow(/permission denied/i)
  })
  it('denies direct calls to private stock helpers even for administrators', async () => {
    await auth('admin')
    await expect(db.exec("select private.stock_convert('1','kg','kg',1)")).rejects.toThrow(/permission denied/i)
  })
  it('retains immutable history even against accidental privileged updates', async () => {
    const result = await rpc('stock_issue', issue({ quantity: '1' }))
    await owner()
    await expect(db.query("update public.stock_operations set reason='rewrite' where id=$1", [result.operation.id])).rejects.toThrow(/immutable/)
  })
  it('makes disabled accounts read no transactions and anonymous accounts unable to read views', async () => {
    await rpc('stock_issue', issue({ quantity: '1' }))
    await auth('disabled')
    expect((await db.query('select * from public.stock_ledger_rows')).rows).toEqual([])
    await auth('anon')
    await expect(db.exec('select * from public.stock_ledger_rows')).rejects.toThrow(/permission denied/i)
  })
})
