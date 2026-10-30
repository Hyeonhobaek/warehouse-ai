// Test-only PostgREST transport backed by the actual PostgreSQL migrations.
// Production always uses its configured Supabase server, with no demo branches.
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createSupabaseFixture } from './supabase.mjs'

const tables = ['materials', 'material_lots', 'stock_batches', 'stock_batch_quality_history',
  'warehouses', 'storage_locations', 'stock_balances', 'inventory_rows', 'material_stock_summary']
const quote = value => `"${value.replaceAll('"', '""')}"`

export async function createInventoryFixture(port = 0) {
  const db = new PGlite()
  const errors = []
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `)
  for (const name of ['20261029000100_identity_foundation.sql', '20261030000100_inventory_foundation.sql']) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  }
  for (const [index, role] of ['viewer', 'operator', 'admin', 'inactive'].entries()) {
    await db.query('insert into auth.users (id,email) values ($1,$2)', [
      `00000000-0000-4000-8000-00000000000${index + 1}`, `${role}@example.test`,
    ])
  }
  await db.exec(`
    begin;
    set local app.audit_reason = '가상 HTTP 통합 테스트 권한 초기화';
    update public.profiles set role = 'operator' where id = '00000000-0000-4000-8000-000000000002';
    update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-000000000003';
    update public.profiles set is_active = false where id = '00000000-0000-4000-8000-000000000004';
    commit;
  `)
  await db.exec(await readFile(new URL('../../supabase/seed.sql', import.meta.url), 'utf8'))
  const columns = new Map()
  for (const table of tables) {
    const result = await db.query('select column_name from information_schema.columns where table_schema = $1 and table_name = $2', ['public', table])
    columns.set(table, new Set(result.rows.map(row => row.column_name)))
  }

  const fixture = await createSupabaseFixture(port, {
    async handleRest({ request, response, url, body, identity, reply }) {
      if (!identity) return reply(401, { code: '42501', message: 'Not authenticated' })
      const table = url.pathname.slice('/rest/v1/'.length)
      const allowed = columns.get(table)
      if (!allowed) return reply(404, { message: 'Unknown fixture resource' })
      const params = []
      const parameter = value => { params.push(value); return `$${params.length}` }
      const checkColumn = column => {
        if (!allowed.has(column)) throw new Error(`Unsupported fixture column ${column}`)
        return quote(column)
      }
      try {
        const filters = []
        for (const [key, value] of url.searchParams) {
          if (['select', 'order', 'limit', 'offset'].includes(key)) continue
          const separator = value.indexOf('.')
          const operator = value.slice(0, separator)
          const operand = value.slice(separator + 1)
          const column = checkColumn(key)
          if (operator === 'eq') filters.push(`${column} = ${parameter(operand)}`)
          else if (operator === 'ilike') filters.push(`${column} ilike ${parameter(operand.replaceAll('*', '%'))}`)
          else if (operator === 'is' && operand === 'null') filters.push(`${column} is null`)
          else throw new Error(`Unsupported fixture filter ${operator}`)
        }
        const where = filters.length ? ` where ${filters.join(' and ')}` : ''
        const selected = url.searchParams.get('select') ?? '*'
        const select = selected === '*' ? '*' : selected.split(',').map(checkColumn).join(',')
        const singular = request.headers.accept?.includes('application/vnd.pgrst.object+json')
        const result = await db.transaction(async (tx) => {
          await tx.exec('set local role authenticated')
          await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [identity.id])
          if (request.method === 'GET' || request.method === 'HEAD') {
            const count = await tx.query(`select count(*)::integer as count from public.${quote(table)}${where}`, params)
            const order = (url.searchParams.get('order') ?? '').split(',').filter(Boolean).map(item => {
              const [column, direction] = item.split('.')
              return `${checkColumn(column)} ${direction === 'desc' ? 'desc' : 'asc'}`
            })
            const offset = Number(url.searchParams.get('offset') ?? 0)
            const limit = Number(url.searchParams.get('limit') ?? 1000)
            const range = ` limit ${parameter(limit)} offset ${parameter(offset)}`
            const query = `select row_to_json(t) as value from (select ${select} from public.${quote(table)}${where}${order.length ? ` order by ${order.join(',')}` : ''}${range}) t`
            const rows = await tx.query(query, params)
            return { rows: rows.rows.map(row => row.value), total: count.rows[0].count, offset }
          }
          if (request.method === 'DELETE') {
            const rows = await tx.query(`delete from public.${quote(table)}${where} returning *`, params)
            return { rows: rows.rows, total: rows.rows.length, offset: 0 }
          }
          const input = Array.isArray(body) ? body[0] : body
          const entries = Object.entries(input)
          if (!entries.length) throw new Error('Empty fixture mutation')
          let query
          if (request.method === 'POST') {
            query = `insert into public.${quote(table)} (${entries.map(([key]) => checkColumn(key)).join(',')}) values (${entries.map(([, value]) => parameter(value)).join(',')}) returning *`
          }
          else if (request.method === 'PATCH') {
            query = `update public.${quote(table)} set ${entries.map(([key, value]) => `${checkColumn(key)} = ${parameter(value)}`).join(',')}${where} returning *`
          }
          else throw new Error('Unsupported fixture method')
          const rows = await tx.query(`with changed as (${query}) select row_to_json(changed) as value from changed`, params)
          return { rows: rows.rows.map(row => row.value), total: rows.rows.length, offset: 0 }
        })
        if (singular && result.rows.length !== 1) return reply(406, { code: 'PGRST116', message: 'No rows', details: 'The result contains 0 rows' })
        response.setHeader('content-range', `${result.offset}-${result.offset + Math.max(result.rows.length - 1, 0)}/${result.total}`)
        return reply(request.method === 'POST' ? 201 : 200, singular ? result.rows[0] : result.rows)
      }
      catch (error) {
        errors.push({ code: error.code, message: error.message })
        return reply(error.code === '42501' ? 403 : 400, { code: error.code ?? 'FIXTURE', message: error.message, details: error.detail ?? '' })
      }
    },
  })
  return { ...fixture, db, errors, close: async () => { await fixture.close(); await db.close() } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await createInventoryFixture(Number(process.env.FIXTURE_PORT || 54339))
  console.log(`TEST-ONLY inventory fixture: ${fixture.url}`)
}
