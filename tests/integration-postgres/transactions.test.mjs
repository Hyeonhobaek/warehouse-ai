// Manual real-PostgreSQL concurrency checks: node --test tests/integration-postgres/transactions.test.mjs
// Requires Docker and an already available postgres:17-alpine image. No ports, host mounts,
// external databases, existing containers, environment credentials, or network access are used.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { after, before, describe, it } from 'node:test'

const execute = promisify(execFile)
const container = `warehouse-phase3-test-${process.pid}-${randomUUID().slice(0, 8)}`
const database = 'warehouse_concurrency'
const operator = '00000000-0000-4000-8000-000000000002'
const admin = '00000000-0000-4000-8000-000000000003'
const quote = value => `'${String(value).replaceAll("'", "''")}'`
let started = false
let today
const sessions = new Set()

function session(sql, { name = randomUUID(), keepOpen = false } = {}) {
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  sessions.add(child)
  const output = { stdout: '', stderr: '', code: null }
  child.stdout.setEncoding('utf8').on('data', data => { output.stdout += data })
  child.stderr.setEncoding('utf8').on('data', data => { output.stderr += data })
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => {
      sessions.delete(child)
      output.code = code
      resolve(output)
    })
  })
  const input = `set application_name = ${quote(name)};\n${sql}\n`
  if (keepOpen) child.stdin.write(input)
  else child.stdin.end(input)
  return { child, output, completed, name }
}

async function sql(text) {
  const result = await session(text).completed
  assert.equal(result.code, 0, result.stderr)
  return result.stdout.trim()
}

async function waitFor(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 30))
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${label}`)
}

async function locked(workerNames) {
  await waitFor(async () => {
    const count = await sql(`select count(*) from pg_stat_activity where application_name in (${workerNames.map(quote).join(',')}) and wait_event_type='Lock'`)
    return Number(count) === workerNames.length
  }, `blocked PostgreSQL sessions: ${workerNames.join(', ')}`)
}

async function beginGate(statement, actor) {
  const gate = session(`begin; set local statement_timeout='15s';
    ${actor ? `set local role authenticated; set local request.jwt.claim.sub=${quote(actor)};` : ''}
    ${statement};\n\\echo LOCK_HELD`, { keepOpen: true })
  await waitFor(() => {
    assert.equal(gate.output.code, null, gate.output.stderr)
    return gate.output.stdout.includes('LOCK_HELD')
  }, 'fixture transaction holding the deliberate row lock')
  return gate
}

async function commitGate(gate) {
  gate.child.stdin.end('commit;\n\\quit\n')
  const result = await gate.completed
  assert.equal(result.code, 0, result.stderr)
}

function request(name, input, actor = operator) {
  return session(`begin; set local statement_timeout='15s'; set local lock_timeout='12s';
    set local role authenticated; set local request.jwt.claim.sub=${quote(actor)};
    select public.${name}(${quote(JSON.stringify(input))}::jsonb); commit;`)
}

function resultJson(result) {
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}

function issue(material, quantity, requestKey = randomUUID()) {
  return { request_key: requestKey, material_id: material, quantity: String(quantity), unit: 'kg', occurred_on: today,
    production_item: 'Synthetic concurrency item', production_batch: 'SYNTHETIC-001', reason: 'Synthetic concurrency check', notes: '', warehouse_id: null }
}

function cleaningIssue(material, quantity, requestKey = randomUUID()) {
  return { ...issue(material, quantity, requestKey), unit: 'L', issue_purpose: 'CLEANING' }
}

async function scheduleFixture(material) {
  const bom = resultJson(await request('planning_save_bom', {
    code: randomUUID(), name: 'Synthetic BOM', product_name: 'Synthetic product', is_active: true,
    components: [{ material_id: material, quantity: '5', unit: 'kg', issue_purpose: 'GENERAL' }], reason: 'Synthetic BOM fixture',
  }, admin).completed)
  const input = { code: randomUUID(), bom_id: bom.id, scheduled_on: today, multiplier: '1',
    production_batch: 'SYNTHETIC-SCHEDULE', notes: '', status: 'ACTIVE', reason: 'Synthetic schedule fixture' }
  const saved = resultJson(await request('planning_save_schedule', input).completed)
  const update = { ...input, id: saved.schedule.id, expected_revision: saved.schedule.revision, multiplier: '2' }
  const confirm = { plan_id: saved.plans[0].id, expected_revision: saved.plans[0].revision, request_key: randomUUID(),
    occurred_on: today, warehouse_id: null, notes: '', reason: 'Synthetic plan confirmation' }
  return { saved, update, confirm }
}

async function fixture(quantities = [10, 20]) {
  const ids = { material: randomUUID(), lot: randomUUID(), warehouse: randomUUID(), location: randomUUID(), batches: quantities.map(() => randomUUID()) }
  await sql(`insert into public.materials(id,code,name,base_unit) values(${quote(ids.material)},${quote(ids.material)},'Synthetic material','kg');
    insert into public.material_lots(id,material_id,lot_number) values(${quote(ids.lot)},${quote(ids.material)},'0000123');
    insert into public.warehouses(id,code,name) values(${quote(ids.warehouse)},${quote(ids.warehouse)},'Synthetic warehouse');
    insert into public.storage_locations(id,warehouse_id,code,name) values(${quote(ids.location)},${quote(ids.warehouse)},'A','Synthetic shelf');
    ${ids.batches.map((batch, index) => `insert into public.stock_batches(id,lot_id,receipt_reference,received_on,expires_on,test_number,quality_status,quality_reason,created_at)
      values(${quote(batch)},${quote(ids.lot)},${quote(batch)},${quote(today)}::date-${20 - index},${quote(today)}::date+365,${quote(`SYNTHETIC-${index}`)},'APPROVED','Synthetic approved',now()-interval '${20 - index} days');
      insert into public.stock_balances(batch_id,location_id,on_hand,reserved) values(${quote(batch)},${quote(ids.location)},${quantities[index]},0);`).join('\n')}`)
  return ids
}

async function reconciliation(material) {
  return JSON.parse(await sql(`select jsonb_build_object(
    'on_hand',(select sum(b.on_hand) from public.stock_balances b join public.stock_batches r on r.id=b.batch_id join public.material_lots l on l.id=r.lot_id where l.material_id=${quote(material)}),
    'held',(select sum(b.held) from public.stock_balances b join public.stock_batches r on r.id=b.batch_id join public.material_lots l on l.id=r.lot_id where l.material_id=${quote(material)}),
    'operations',(select count(*) from public.stock_operations where material_id=${quote(material)}),
    'lines',(select count(*) from public.stock_ledger_rows where material_id=${quote(material)}),
    'delta',(select coalesce(sum(delta),0) from public.stock_ledger_rows where material_id=${quote(material)}),
    'broken_lines',(select count(*) from public.stock_ledger_rows where material_id=${quote(material)} and on_hand_before+delta<>on_hand_after)
  )`))
}

before(async () => {
  // Check locally first so a missing image never causes an implicit download.
  await execute('docker', ['image', 'inspect', 'postgres:17-alpine'], { timeout: 10_000 })
  await execute('docker', ['run', '--detach', '--rm', '--name', container, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', `POSTGRES_DB=${database}`, 'postgres:17-alpine'], { timeout: 30_000 })
  started = true
  // The image briefly starts a temporary init server; wait until that server has
  // shut down before accepting pg_isready from the final PostgreSQL process.
  await waitFor(async () => {
    const logs = await execute('docker', ['logs', container])
    return `${logs.stdout}\n${logs.stderr}`.includes('PostgreSQL init process complete; ready for start up.')
  }, 'PostgreSQL image initialization', 20_000)
  await waitFor(async () => {
    try { await execute('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', database]); return true }
    catch { return false }
  }, 'isolated PostgreSQL to become ready', 20_000)
  await sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`)
  for (const migration of ['20261029000100_identity_foundation.sql', '20261030000100_inventory_foundation.sql', '20261030000200_stock_transactions.sql', '20261030000300_cleaning_fifo.sql', '20261030000400_bom_planning.sql']) {
    await sql(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), 'utf8'))
  }
  await sql(`insert into auth.users(id,email) values(${quote(operator)},'synthetic-operator@example.test'),(${quote(admin)},'synthetic-admin@example.test');
    begin; set local app.audit_reason='Synthetic concurrency fixture';
    update public.profiles set role='operator' where id=${quote(operator)};
    update public.profiles set role='admin' where id=${quote(admin)}; commit;`)
  today = await sql("select (now() at time zone 'Asia/Seoul')::date::text")
}, { timeout: 60_000 })

after(async () => {
  for (const child of sessions) child.stdin.end('rollback;\n\\quit\n')
  // Only the uniquely named container created by this script is stopped. --rm removes it.
  if (started) await execute('docker', ['stop', '--time', '1', container], { timeout: 15_000 })
}, { timeout: 20_000 })

describe('PostgreSQL independent-connection stock concurrency', { concurrency: false, timeout: 30_000 }, () => {
  it('permits only one oversubscribed issue and rolls back every allocation of its competitor', async () => {
    const ids = await fixture()
    const gate = await beginGate(`select id from public.materials where id=${quote(ids.material)} for update`)
    const first = request('stock_issue', issue(ids.material, 20))
    const second = request('stock_issue', issue(ids.material, 20))
    await locked([first.name, second.name])
    await commitGate(gate)
    const results = await Promise.all([first.completed, second.completed])
    assert.equal(results.filter(result => result.code === 0).length, 1)
    assert.match(results.find(result => result.code !== 0).stderr, /Insufficient available stock/)
    const success = resultJson(results.find(result => result.code === 0))
    assert.deepEqual(success.lines.map(line => [line.batch_id, line.quantity]), [[ids.batches[0], 10], [ids.batches[1], 10]])
    assert.deepEqual(await reconciliation(ids.material), { on_hand: 10, held: 0, operations: 1, lines: 2, delta: -20, broken_lines: 0 })
  })

  it('serializes simultaneous identical request keys and returns the same immutable result', async () => {
    const ids = await fixture()
    const gate = await beginGate(`select id from public.materials where id=${quote(ids.material)} for update`)
    const input = issue(ids.material, 15)
    const first = request('stock_issue', input)
    const second = request('stock_issue', input)
    await locked([first.name, second.name])
    await commitGate(gate)
    const results = await Promise.all([first.completed, second.completed])
    assert.deepEqual(resultJson(results[0]), resultJson(results[1]))
    assert.deepEqual(await reconciliation(ids.material), { on_hand: 15, held: 0, operations: 1, lines: 2, delta: -15, broken_lines: 0 })
  })

  it('rechecks QC after waiting for a concurrent approval revocation and skips the held cohort', async () => {
    const ids = await fixture()
    const gate = await beginGate(`update public.stock_batches set quality_status='HOLD',quality_reason='Synthetic concurrent hold' where id=${quote(ids.batches[0])}`, admin)
    const worker = request('stock_issue', issue(ids.material, 15))
    await locked([worker.name])
    await commitGate(gate)
    const result = resultJson(await worker.completed)
    assert.deepEqual(result.lines.map(line => [line.batch_id, line.quantity]), [[ids.batches[1], 15]])
    assert.deepEqual(await reconciliation(ids.material), { on_hand: 15, held: 0, operations: 1, lines: 1, delta: -15, broken_lines: 0 })
    assert.equal(await sql(`select on_hand from public.stock_balances where batch_id=${quote(ids.batches[0])}`), '10.000000')
  })

  it('prevents concurrent over-return and counts the winner as held, never immediately available', async () => {
    const ids = await fixture([30])
    const issued = resultJson(await request('stock_issue', issue(ids.material, 12)).completed)
    const input = { issue_line_id: issued.lines[0].id, location_id: ids.location, quantity: '8', unit: 'kg', occurred_on: today, reason: 'Synthetic unused return', notes: '' }
    const gate = await beginGate(`select id from public.materials where id=${quote(ids.material)} for update`)
    const first = request('stock_return', { ...input, request_key: randomUUID() })
    const second = request('stock_return', { ...input, request_key: randomUUID() })
    await locked([first.name, second.name])
    await commitGate(gate)
    const results = await Promise.all([first.completed, second.completed])
    assert.equal(results.filter(result => result.code === 0).length, 1)
    assert.match(results.find(result => result.code !== 0).stderr, /Return exceeds original issued quantity remaining/)
    assert.deepEqual(await reconciliation(ids.material), { on_hand: 26, held: 8, operations: 2, lines: 2, delta: -4, broken_lines: 0 })
    assert.equal(await sql(`select available from public.inventory_rows where material_id=${quote(ids.material)}`), '18.000000')
  })

  it('serializes competing cleaning requests and preserves incomplete 18 L remainders', async () => {
    const ids = await fixture([20, 20]) // Two 25 L cohorts, each permitting only one 18 L block.
    await sql(`update public.materials set density=0.8 where id=${quote(ids.material)}`)
    const gate = await beginGate(`select id from public.materials where id=${quote(ids.material)} for update`)
    const first = request('stock_issue', cleaningIssue(ids.material, 36))
    const second = request('stock_issue', cleaningIssue(ids.material, 36))
    await locked([first.name, second.name])
    await commitGate(gate)
    const results = await Promise.all([first.completed, second.completed])
    assert.equal(results.filter(result => result.code === 0).length, 1)
    assert.match(results.find(result => result.code !== 0).stderr, /Insufficient available stock/)
    const winner = resultJson(results.find(result => result.code === 0))
    assert.deepEqual(winner.lines.map(line => [line.batch_id, line.quantity, line.on_hand_after]),
      [[ids.batches[0], 14.4, 5.6], [ids.batches[1], 14.4, 5.6]])
    assert.equal(winner.operation.issue_purpose, 'CLEANING')
    assert.deepEqual(await reconciliation(ids.material), { on_hand: 11.2, held: 0, operations: 1, lines: 2, delta: -28.8, broken_lines: 0 })
  })

  it('recalculates cleaning block capacity after a concurrent QC hold commits', async () => {
    const ids = await fixture([20, 80])
    await sql(`update public.materials set density=0.8 where id=${quote(ids.material)}`)
    const gate = await beginGate(`update public.stock_batches set quality_status='HOLD',quality_reason='Synthetic cleaning hold' where id=${quote(ids.batches[0])}`, admin)
    const worker = request('stock_issue', cleaningIssue(ids.material, 36))
    await locked([worker.name])
    await commitGate(gate)
    const result = resultJson(await worker.completed)
    assert.deepEqual(result.lines.map(line => [line.batch_id, line.quantity]), [[ids.batches[1], 28.8]])
    assert.equal(await sql(`select on_hand from public.stock_balances where batch_id=${quote(ids.batches[0])}`), '20.000000')
    assert.deepEqual(await reconciliation(ids.material), { on_hand: 71.2, held: 0, operations: 1, lines: 1, delta: -28.8, broken_lines: 0 })
  })

  it('rejects a stale planned issue after waiting for a concurrent schedule change', async () => {
    const ids = await fixture([30])
    const schedule = await scheduleFixture(ids.material)
    const gate = await beginGate(`select public.planning_save_schedule(${quote(JSON.stringify(schedule.update))}::jsonb)`, operator)
    const worker = request('planning_issue_plan', schedule.confirm)
    await locked([worker.name])
    await commitGate(gate)
    const result = await worker.completed
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Planning revision conflict/)
    const plan = JSON.parse(await sql(`select jsonb_build_object('status',status,'quantity',quantity,'revision',revision,'stock_operation_id',stock_operation_id)
      from public.stock_issue_plans where id=${quote(schedule.confirm.plan_id)}`))
    assert.deepEqual(plan, { status: 'PLANNED', quantity: 10, revision: 2, stock_operation_id: null })
    assert.deepEqual(await reconciliation(ids.material), { on_hand: 30, held: 0, operations: 0, lines: 0, delta: 0, broken_lines: 0 })
  })

  it('preserves an issued plan when a concurrent schedule change waits for its confirmation', async () => {
    const ids = await fixture([30])
    const schedule = await scheduleFixture(ids.material)
    const gate = await beginGate(`select public.planning_issue_plan(${quote(JSON.stringify(schedule.confirm))}::jsonb)`, operator)
    const worker = request('planning_save_schedule', schedule.update)
    await locked([worker.name])
    await commitGate(gate)
    const updated = resultJson(await worker.completed)
    assert.equal(updated.schedule.multiplier, 2)
    assert.equal(updated.plans[0].status, 'ISSUED')
    assert.equal(updated.plans[0].quantity, 5)
    assert.equal(updated.plans[0].revision, 2)
    assert.ok(updated.plans[0].stock_operation_id)
    assert.deepEqual(await reconciliation(ids.material), { on_hand: 25, held: 0, operations: 1, lines: 1, delta: -5, broken_lines: 0 })
    const replay = resultJson(await request('planning_issue_plan', schedule.confirm).completed)
    assert.equal(replay.operation.id, updated.plans[0].stock_operation_id)
  })
})
