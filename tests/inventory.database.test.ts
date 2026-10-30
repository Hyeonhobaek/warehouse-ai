import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const userIds = {
  viewer: '00000000-0000-4000-8000-000000000001',
  operator: '00000000-0000-4000-8000-000000000002',
  admin: '00000000-0000-4000-8000-000000000003',
  disabled: '00000000-0000-4000-8000-000000000004',
}
const materialId = '10000000-0000-4000-8000-000000000001'
const lotId = '40000000-0000-4000-8000-000000000001'
const batchId = '50000000-0000-4000-8000-000000000001'
const locationId = '30000000-0000-4000-8000-000000000001'
const balanceId = '60000000-0000-4000-8000-000000000001'
const tables = ['materials', 'material_lots', 'stock_batches', 'warehouses', 'storage_locations', 'stock_balances', 'stock_batch_quality_history', 'inventory_rows', 'material_stock_summary']
let db: PGlite
let seed: string

async function asUser<T>(id: string | null, run: () => Promise<T>) {
  await db.exec('begin')
  try {
    await db.exec(`set local role ${id ? 'authenticated' : 'anon'}`)
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [id ?? ''])
    return await run()
  }
  finally { await db.exec('rollback') }
}

async function count(table: string) {
  const result = await db.query<{ count: string }>(`select count(*) from public.${table}`)
  return Number(result.rows[0]?.count)
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `)
  for (const file of ['20261029000100_identity_foundation.sql', '20261030000100_inventory_foundation.sql']) {
    await db.exec(await readFile(fileURLToPath(new URL(`../supabase/migrations/${file}`, import.meta.url)), 'utf8'))
  }
  for (const [role, id] of Object.entries(userIds)) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${role}@example.test`])
  }
  await db.exec(`
    begin;
    set local app.audit_reason = '가상 재고 테스트 사용자 설정';
    update public.profiles set role = 'admin' where id = '${userIds.admin}';
    update public.profiles set role = 'operator' where id = '${userIds.operator}';
    update public.profiles set is_active = false where id = '${userIds.disabled}';
    commit;
  `)
  seed = await readFile(fileURLToPath(new URL('../supabase/seed.sql', import.meta.url)), 'utf8')
  await db.exec(seed)
}, 30_000)

afterAll(async () => { await db?.close() })

describe('Phase 2 PostgreSQL schema and authorization', () => {
  it('runs the seed repeatedly without duplicate records or overwriting edits', async () => {
    await db.query("update public.materials set name = '데모 수정 보존' where id = $1", [materialId])
    await db.query('update public.stock_balances set on_hand = 70.123456 where id = $1', [balanceId])
    await db.exec(seed)
    expect(await count('materials')).toBe(6)
    expect(await count('stock_batches')).toBe(8)
    expect(await count('stock_batch_quality_history')).toBe(8)
    expect(await count('stock_balances')).toBe(10)
    const material = await db.query('select name from public.materials where id = $1', [materialId])
    expect(material.rows).toEqual([{ name: '데모 수정 보존' }])
    const balance = await db.query('select on_hand::text from public.stock_balances where id = $1', [balanceId])
    expect(balance.rows).toEqual([{ on_hand: '70.123456' }])
    await db.query("update public.materials set name = '가상 세척용 원료 A' where id = $1", [materialId])
    await db.query('update public.stock_balances set on_hand = 70 where id = $1', [balanceId])
  })

  it.each(tables)('denies anonymous access to %s', async (table) => {
    await expect(asUser(null, () => count(table))).rejects.toThrow(/permission denied/i)
  })

  it.each(['viewer', 'operator', 'admin'] as const)('allows active %s inventory reads', async (role) => {
    expect(await asUser(userIds[role], () => count('materials'))).toBe(6)
    expect(await asUser(userIds[role], () => count('inventory_rows'))).toBe(10)
    expect(await asUser(userIds[role], () => count('material_stock_summary'))).toBe(6)
  })

  it.each(tables)('hides %s from inactive accounts, including view joins', async (table) => {
    expect(await asUser(userIds.disabled, () => count(table))).toBe(0)
  })

  it.each(['viewer', 'operator', 'disabled'] as const)('blocks metadata creation and edits for %s', async (role) => {
    await expect(asUser(userIds[role], () => db.query("insert into public.materials (code, name, base_unit) values ('DENIED', '권한없음', 'kg')"))).rejects.toThrow(/row-level security/i)
    const result = await asUser(userIds[role], () => db.query("update public.materials set name = '권한없음' where id = $1 returning id", [materialId]))
    expect(result.rows).toEqual([])
  })

  it('allows an administrator to create and delete an unreferenced material', async () => {
    await asUser(userIds.admin, async () => {
      const created = await db.query<{ id: string }>("insert into public.materials (code, name, aliases, base_unit) values ('DEMO-NEW', '신규 원료', array['별칭검색'], 'kg') returning id")
      const id = created.rows[0]!.id
      const updated = await db.query<{ search_text: string }>("update public.materials set name = '수정 원료' where id = $1 returning search_text", [id])
      expect(updated.rows[0]?.search_text).toContain('별칭검색')
      expect(updated.rows[0]?.search_text).toContain('수정 원료')
      const deleted = await db.query('delete from public.materials where id = $1 returning id', [id])
      expect(deleted.rows).toHaveLength(1)
    })
  })

  it('creates receipt metadata and its initial QC history without creating or duplicating stock', async () => {
    await asUser(userIds.admin, async () => {
      const result = await db.query<{ id: string }>(`insert into public.stock_batches (lot_id, receipt_reference, received_on, quality_reason)
        values ($1, 'DEMO-NEW-RECEIPT', (now() at time zone 'Asia/Seoul')::date, '신규 메타데이터 등록') returning id`, [lotId])
      const id = result.rows[0]!.id
      expect(await count('stock_balances')).toBe(10)
      const history = await db.query('select quality_status, actor_id, reason from public.stock_batch_quality_history where batch_id = $1', [id])
      expect(history.rows).toEqual([{ quality_status: 'PENDING', actor_id: userIds.admin, reason: '신규 메타데이터 등록' }])
      const total = await db.query<{ on_hand: string; batch_count: number }>('select on_hand::text, batch_count::int from public.material_stock_summary where material_id = $1', [materialId])
      expect(total.rows).toEqual([{ on_hand: '125.000000', batch_count: 3 }])
    })
  })

  it.each(['stock_balances', 'stock_batch_quality_history'])('blocks direct %s writes even for admins', async (table) => {
    for (const sql of [`delete from public.${table}`, `update public.${table} set id = id`, `insert into public.${table} default values`]) {
      await expect(asUser(userIds.admin, () => db.exec(sql))).rejects.toThrow(/permission denied/i)
    }
  })

  it('refuses to delete referenced materials and preserves all dependent data', async () => {
    await expect(asUser(userIds.admin, () => db.query('delete from public.materials where id = $1', [materialId]))).rejects.toThrow(/foreign key constraint/i)
    expect(await count('stock_batches')).toBe(8)
  })

  it.each([
    ["update public.materials set base_unit = 'g' where id = $1", materialId],
    ["update public.material_lots set material_id = '10000000-0000-4000-8000-000000000002' where id = $1", lotId],
    ["update public.stock_batches set lot_id = '40000000-0000-4000-8000-000000000002' where id = $1", batchId],
    ["update public.storage_locations set warehouse_id = '20000000-0000-4000-8000-000000000002' where id = $1", locationId],
    ['update public.materials set id = gen_random_uuid() where id = $1', materialId],
  ])('protects existing stock identity (%s)', async (sql, id) => {
    await expect(asUser(userIds.admin, () => db.query(sql!, [id]))).rejects.toThrow(/immutable|cannot change/i)
  })

  it.each([
    "update public.materials set min_stock = -1 where code = 'DEMO-SOL-01'",
    "update public.materials set min_stock = 'NaN' where code = 'DEMO-SOL-01'",
    "update public.materials set package_size = null where code = 'DEMO-SOL-01'",
    "update public.materials set density = 0 where code = 'DEMO-SOL-01'",
    "update public.materials set aliases = array[''] where code = 'DEMO-SOL-01'",
    "update public.stock_batches set expires_on = received_on - 1 where receipt_reference = 'DEMO-RCV-001'",
    "update public.stock_batches set received_on = date '1800-01-01' where receipt_reference = 'DEMO-RCV-001'",
    "update public.stock_batches set quality_reason = '  ' where receipt_reference = 'DEMO-RCV-001'",
  ])('enforces numeric, date and required field checks (%s)', async (sql) => {
    await expect(asUser(userIds.admin, () => db.exec(sql))).rejects.toThrow(/constraint|precede manufacture/i)
  })

  it.each([
    "insert into public.materials (code, name, base_unit) values ('DEMO-SOL-01', '중복', 'kg')",
    `insert into public.material_lots (material_id, lot_number) values ('${materialId}', '000123-DEMO')`,
    `insert into public.stock_batches (lot_id, receipt_reference, received_on, quality_reason) values ('${lotId}', 'DEMO-RCV-001', current_date, '중복 검사')`,
  ])('enforces business identifier uniqueness (%s)', async (sql) => {
    await expect(asUser(userIds.admin, () => db.exec(sql))).rejects.toThrow(/unique constraint/i)
  })

  it.each([
    'update public.stock_balances set on_hand = -1',
    'update public.stock_balances set reserved = on_hand + 1',
    "update public.stock_balances set on_hand = 'NaN'",
  ])('rejects invalid trusted stock initialization (%s)', async (sql) => {
    await expect(db.exec(sql)).rejects.toThrow(/check constraint/i)
  })

  it('prevents inconsistent dates in both LOT and receipt metadata', async () => {
    await expect(asUser(userIds.admin, () => db.query('update public.material_lots set manufactured_on = current_date where id = $1', [lotId]))).rejects.toThrow(/cannot follow/i)
    await expect(asUser(userIds.admin, () => db.query('update public.stock_batches set received_on = current_date - 150 where id = $1', [batchId]))).rejects.toThrow(/cannot precede/i)
  })

  it.each(['received_on', 'decision_on'])('rejects future %s on insert and update with SQLSTATE 23514', async (field) => {
    await expect(asUser(userIds.admin, () => db.query(`update public.stock_batches set ${field} = (now() at time zone 'Asia/Seoul')::date + 1 where id = $1`, [batchId]))).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/cannot be in the future/) })
    await expect(asUser(userIds.admin, () => db.query(`insert into public.stock_batches (lot_id, receipt_reference, received_on, decision_on, quality_reason)
      values ($1, 'DEMO-FUTURE', (now() at time zone 'Asia/Seoul')::date + ${field === 'received_on' ? 1 : 0},
      (now() at time zone 'Asia/Seoul')::date + 1, '예정일은 실제 입고일이 아님')`, [lotId]))).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/cannot be in the future/) })
    expect(await count('stock_batch_quality_history')).toBe(8)
    expect(await count('stock_batches')).toBe(8)
  })

  it('accepts today as the actual receipt and decision date in Seoul regardless of session timezone', async () => {
    await asUser(userIds.admin, async () => {
      await db.exec("set local time zone 'Pacific/Honolulu'")
      const result = await db.query(`insert into public.stock_batches (lot_id, receipt_reference, received_on, decision_on, quality_reason)
        values ($1, 'DEMO-TODAY', (now() at time zone 'Asia/Seoul')::date, (now() at time zone 'Asia/Seoul')::date, '오늘 실제 입고') returning receipt_reference`, [lotId])
      expect(result.rows).toEqual([{ receipt_reference: 'DEMO-TODAY' }])
    })
  })
})

describe('Inventory accounting views and QC history', () => {
  it('keeps two physical receipts under one LOT with their distinct test numbers', async () => {
    const result = await asUser(userIds.viewer, () => db.query('select lot_number, count(distinct batch_id)::int batches, count(distinct test_number)::int tests from public.inventory_rows where material_id = $1 group by lot_number', [materialId]))
    expect(result.rows).toEqual([{ lot_number: '000123-DEMO', batches: 2, tests: 2 }])
  })

  it('separates reservations from unavailable stock and includes zero-stock materials', async () => {
    const result = await asUser(userIds.viewer, () => db.query('select material_code, on_hand::float, reserved::float, available::float, unavailable::float, is_low_stock from public.material_stock_summary order by material_code'))
    expect(result.rows).toEqual([
      { material_code: 'DEMO-ADD-04', on_hand: 350, reserved: 50, available: 100, unavailable: 200, is_low_stock: true },
      { material_code: 'DEMO-LIQ-03', on_hand: 190, reserved: 5, available: 35, unavailable: 150, is_low_stock: true },
      { material_code: 'DEMO-POW-02', on_hand: 250, reserved: 0, available: 0, unavailable: 250, is_low_stock: true },
      { material_code: 'DEMO-SOL-01', on_hand: 125, reserved: 10, available: 100, unavailable: 15, is_low_stock: false },
      { material_code: 'DEMO-UNIT-05', on_hand: 25, reserved: 0, available: 0, unavailable: 25, is_low_stock: false },
      { material_code: 'DEMO-ZERO-06', on_hand: 0, reserved: 0, available: 0, unavailable: 0, is_low_stock: true },
    ])
  })

  it('calculates low stock from the entire material across locations and receipts', async () => {
    await asUser(userIds.admin, async () => {
      await db.query('update public.materials set min_stock = 70 where id = $1', [materialId])
      const result = await db.query<{ is_low_stock: boolean; material_available: number }>('select is_low_stock, material_available::float from public.inventory_rows where material_id = $1', [materialId])
      expect(result.rows).toHaveLength(3)
      expect(result.rows.every(row => !row.is_low_stock && row.material_available === 100)).toBe(true)
    })
  })

  it('retains original QC judgment for expired stock and flags both upcoming and overdue retests', async () => {
    const result = await asUser(userIds.viewer, () => db.query('select receipt_reference, quality_status, effective_status, expiry_due, retest_due from public.inventory_rows where receipt_reference in ($1, $2, $3) order by receipt_reference', ['DEMO-RCV-004', 'DEMO-RCV-005', 'DEMO-RCV-006']))
    expect(result.rows).toEqual([
      { receipt_reference: 'DEMO-RCV-004', quality_status: 'APPROVED', effective_status: 'EXPIRED', expiry_due: false, retest_due: false },
      { receipt_reference: 'DEMO-RCV-005', quality_status: 'APPROVED', effective_status: 'APPROVED', expiry_due: true, retest_due: true },
      { receipt_reference: 'DEMO-RCV-006', quality_status: 'APPROVED', effective_status: 'APPROVED', expiry_due: false, retest_due: true },
      { receipt_reference: 'DEMO-RCV-006', quality_status: 'APPROVED', effective_status: 'APPROVED', expiry_due: false, retest_due: true },
    ])
  })

  it('uses Seoul date and includes today but excludes day 31 from the due window', async () => {
    await asUser(userIds.admin, async () => {
      await db.exec("set local time zone 'Pacific/Honolulu'")
      await db.query("update public.stock_batches set expires_on = (now() at time zone 'Asia/Seoul')::date, retest_on = (now() at time zone 'Asia/Seoul')::date + 31 where id = $1", [batchId])
      const result = await db.query('select effective_status, expiry_due, retest_due, available::float from public.inventory_rows where batch_id = $1', [batchId])
      expect(result.rows).toEqual([{ effective_status: 'APPROVED', expiry_due: true, retest_due: false, available: 60 }])
    })
  })

  it('makes inactive materials unavailable without changing physical quantities', async () => {
    await asUser(userIds.admin, async () => {
      await db.query('update public.materials set is_active = false where id = $1', [materialId])
      const result = await db.query('select on_hand::float, available::float, unavailable::float from public.material_stock_summary where material_id = $1', [materialId])
      expect(result.rows).toEqual([{ on_hand: 125, available: 0, unavailable: 125 }])
      const reasons = await db.query('select distinct availability_reason from public.inventory_rows where material_id = $1', [materialId])
      expect(reasons.rows).toEqual([{ availability_reason: 'MATERIAL_INACTIVE' }])
    })
  })

  it('explains unavailable inventory without changing the original QC status', async () => {
    const result = await asUser(userIds.viewer, () => db.query('select id, availability_reason from public.inventory_rows where id in ($1, $2, $3, $4, $5) order by id', [
      balanceId, '60000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000004',
      '60000000-0000-4000-8000-000000000007', '60000000-0000-4000-8000-000000000010',
    ]))
    expect(result.rows).toEqual([
      { id: balanceId, availability_reason: null },
      { id: '60000000-0000-4000-8000-000000000003', availability_reason: 'QUALITY_NOT_APPROVED' },
      { id: '60000000-0000-4000-8000-000000000004', availability_reason: 'EXPIRED' },
      { id: '60000000-0000-4000-8000-000000000007', availability_reason: 'LOCATION_INACTIVE' },
      { id: '60000000-0000-4000-8000-000000000010', availability_reason: 'WAREHOUSE_INACTIVE' },
    ])
  })

  it('treats unknown expiry as unavailable and propagates that exclusion to material totals', async () => {
    await asUser(userIds.admin, async () => {
      await db.query("update public.stock_batches set expires_on = null, quality_reason = '유효기간 확인 중' where id = $1", [batchId])
      const row = await db.query('select quality_status, effective_status, availability_reason, on_hand::float, reserved::float, available::float, unavailable::float from public.inventory_rows where batch_id = $1', [batchId])
      expect(row.rows).toEqual([{ quality_status: 'APPROVED', effective_status: 'APPROVED', availability_reason: 'EXPIRY_UNKNOWN', on_hand: 70, reserved: 10, available: 0, unavailable: 70 }])
      const summary = await db.query('select on_hand::float, reserved::float, available::float, unavailable::float from public.material_stock_summary where material_id = $1', [materialId])
      expect(summary.rows).toEqual([{ on_hand: 125, reserved: 10, available: 40, unavailable: 85 }])
    })
  })

  it('does not release previously expired stock when the expiry date is cleared', async () => {
    await asUser(userIds.admin, async () => {
      await db.exec("update public.stock_batches set expires_on = null, quality_reason = '유효기간 자료 재확인' where receipt_reference = 'DEMO-RCV-004'")
      const result = await db.query("select quality_status, effective_status, availability_reason, available::float, unavailable::float, expiry_due from public.inventory_rows where receipt_reference = 'DEMO-RCV-004'")
      expect(result.rows).toEqual([{ quality_status: 'APPROVED', effective_status: 'APPROVED', availability_reason: 'EXPIRY_UNKNOWN', available: 0, unavailable: 150, expiry_due: false }])
    })
  })

  it.each([
    "quality_status = 'HOLD'",
    "test_number = 'DEMO-RETEST-001'",
    'decision_on = decision_on + 1',
    'expires_on = expires_on + 1',
    'retest_on = retest_on + 1',
  ])('appends actor/reason and preserves balances when %s changes', async (assignment) => {
    await asUser(userIds.admin, async () => {
      const before = await db.query('select * from public.stock_balances where batch_id = $1', [batchId])
      await db.query(`update public.stock_batches set ${assignment}, quality_reason = '재시험 정보 변경' where id = $1`, [batchId])
      const history = await db.query('select actor_id, reason from public.stock_batch_quality_history where batch_id = $1 and reason = $2', [batchId, '재시험 정보 변경'])
      expect(history.rows).toEqual([{ actor_id: userIds.admin, reason: '재시험 정보 변경' }])
      expect(await count('stock_batch_quality_history')).toBe(9)
      const after = await db.query('select * from public.stock_balances where batch_id = $1', [batchId])
      expect(after.rows).toEqual(before.rows)
    })
  })

  it('does not create fake QC events for a note-only edit and updates metadata timestamps', async () => {
    await asUser(userIds.admin, async () => {
      const result = await db.query('update public.stock_batches set notes = $1 where id = $2 returning updated_at >= created_at valid_timestamp', ['메모 보완', batchId])
      expect(result.rows).toEqual([{ valid_timestamp: true }])
      expect(await count('stock_batch_quality_history')).toBe(8)
    })
  })

  it.each(['가상용제', '000123', 'demo-qc-001', '제조사 a'])('searches aliases, textual LOTs, test numbers and manufacturers (%s)', async (term) => {
    const result = await asUser(userIds.viewer, () => db.query('select distinct material_code from public.inventory_rows where search_text like $1', [`%${term}%`]))
    expect(result.rows).toEqual([{ material_code: 'DEMO-SOL-01' }])
  })
})
