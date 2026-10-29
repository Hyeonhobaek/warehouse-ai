import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ids = {
  viewer: '00000000-0000-4000-8000-000000000001',
  operator: '00000000-0000-4000-8000-000000000002',
  admin: '00000000-0000-4000-8000-000000000003',
  disabled: '00000000-0000-4000-8000-000000000004',
  existing: '00000000-0000-4000-8000-000000000005',
}

let db: PGlite

async function asUser<T>(role: 'anon' | 'authenticated', id: string | null, query: () => Promise<T>) {
  await db.exec('begin')
  try {
    await db.exec(`set local role ${role}`)
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [id ?? ''])
    return await query()
  }
  finally {
    await db.exec('rollback')
  }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `)
  await db.query('insert into auth.users (id, email) values ($1, $2)', [ids.existing, 'existing@example.test'])
  const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20261029000100_identity_foundation.sql', import.meta.url)), 'utf8')
  await db.exec(migration)
  for (const [role, id] of Object.entries(ids).filter(([role]) => role !== 'existing')) {
    await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [
      id, `${role}@example.test`, JSON.stringify({ display_name: `가상 ${role}`, role: 'admin' }),
    ])
  }
  await db.exec(`
    begin;
    set local app.audit_reason = '가상 권한 fixture 초기화';
    update public.profiles set role = 'operator' where id = '${ids.operator}';
    update public.profiles set role = 'admin' where id = '${ids.admin}';
    update public.profiles set is_active = false where id = '${ids.disabled}';
    commit;
  `)
}, 30_000)

afterAll(async () => { await db?.close() })

describe('Phase 1 PostgreSQL migration and RLS', () => {
  it('backfills existing Auth users with the least-privileged role', async () => {
    const result = await db.query('select role, display_name from public.profiles where id = $1', [ids.existing])
    expect(result.rows).toEqual([{ role: 'viewer', display_name: 'existing' }])
  })

  it('ignores user-controlled admin metadata when creating a profile', async () => {
    const result = await db.query('select role, display_name from public.profiles where id = $1', [ids.viewer])
    expect(result.rows).toEqual([{ role: 'viewer', display_name: '가상 viewer' }])
  })

  it('denies anonymous profile reads', async () => {
    await expect(asUser('anon', null, () => db.query('select * from public.profiles'))).rejects.toThrow(/permission denied/i)
  })

  it.each(['viewer', 'operator'] as const)('%s can only read their own active profile', async (role) => {
    const result = await asUser('authenticated', ids[role], () => db.query('select id from public.profiles'))
    expect(result.rows).toEqual([{ id: ids[role] }])
  })

  it('lets active admins read profiles, including disabled accounts', async () => {
    const result = await asUser('authenticated', ids.admin, () => db.query('select id from public.profiles'))
    expect(result.rows).toHaveLength(5)
  })

  it('hides every profile from disabled users', async () => {
    const result = await asUser('authenticated', ids.disabled, () => db.query('select id from public.profiles'))
    expect(result.rows).toEqual([])
  })

  it.each(['viewer', 'admin'] as const)('blocks direct role changes even for %s clients', async (role) => {
    await expect(asUser('authenticated', ids[role], () => db.query("update public.profiles set role = 'admin' where id = $1", [ids.viewer]))).rejects.toThrow(/permission denied/i)
  })

  it('blocks authenticated profile creation and deletion', async () => {
    await expect(asUser('authenticated', ids.viewer, () => db.query('insert into public.profiles (id, display_name) values (gen_random_uuid(), $1)', ['공격자']))).rejects.toThrow(/permission denied/i)
    await expect(asUser('authenticated', ids.viewer, () => db.query('delete from public.profiles where id = $1', [ids.viewer]))).rejects.toThrow(/permission denied/i)
  })

  it('requires an audit reason and rolls back an unreasoned access change', async () => {
    await expect(db.query("update public.profiles set role = 'admin' where id = $1", [ids.viewer])).rejects.toThrow(/requires app.audit_reason/i)
    const result = await db.query('select role from public.profiles where id = $1', [ids.viewer])
    expect(result.rows).toEqual([{ role: 'viewer' }])
  })

  it('stores before/after roles and activation with the trusted change reason', async () => {
    const result = await db.query('select old_role, new_role, old_is_active, new_is_active, reason, database_actor from public.profile_role_audit where profile_id = $1', [ids.admin])
    expect(result.rows).toEqual([expect.objectContaining({
      old_role: 'viewer', new_role: 'admin', old_is_active: true, new_is_active: true,
      reason: '가상 권한 fixture 초기화', database_actor: expect.any(String),
    })])
  })

  it('only lets active admins read access audit rows', async () => {
    const viewerRows = await asUser('authenticated', ids.viewer, () => db.query('select id from public.profile_role_audit'))
    const adminRows = await asUser('authenticated', ids.admin, () => db.query('select id from public.profile_role_audit'))
    expect(viewerRows.rows).toEqual([])
    expect(adminRows.rows).toHaveLength(3)
  })

  it('does not grant audit mutation access to application admins', async () => {
    await expect(asUser('authenticated', ids.admin, () => db.query('delete from public.profile_role_audit'))).rejects.toThrow(/permission denied/i)
  })

  it('revokes admin read scope immediately when the admin becomes inactive', async () => {
    await db.exec('begin')
    try {
      await db.exec("set local app.audit_reason = '비활성 관리자 접근 시험'")
      await db.query('update public.profiles set is_active = false where id = $1', [ids.admin])
      await db.exec('set local role authenticated')
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ids.admin])
      const result = await db.query('select id from public.profiles')
      expect(result.rows).toEqual([])
      const audit = await db.query('select id from public.profile_role_audit')
      expect(audit.rows).toEqual([])
    }
    finally {
      await db.exec('rollback')
    }
  })
})
