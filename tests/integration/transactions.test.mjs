import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout } from 'node:timers/promises'
import { createInventoryFixture } from '../fixtures/inventory.mjs'
import { testPassword } from '../fixtures/supabase.mjs'

let fixture
let app
let base
let output = ''

class Browser {
  cookies = new Map()
  async request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      redirect: 'manual', ...options,
      headers: { cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers },
    })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]
      const separator = pair.indexOf('=')
      const key = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      if (value) this.cookies.set(key, value)
      else this.cookies.delete(key)
    }
    return response
  }
  mutate(path, body, method = 'POST', origin = base) {
    return this.request(path, { method, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  async login(role = 'viewer') {
    const response = await this.mutate('/api/auth/login', { email: `${role}@example.test`, password: testPassword })
    assert.equal(response.status, 200)
    return this
  }
}

async function json(response, status = 200) {
  const body = await response.json()
  assert.equal(response.status, status, JSON.stringify(body))
  return body
}

const materialInput = overrides => ({
  code: 'DEMO-HTTP-001', name: '가상 통합검증 원료', aliases: ['샘플별칭'], specification: '가상 규격',
  manufacturer: '가상 제조사', base_unit: 'kg', min_stock: 2.5, storage_condition: '상온',
  package_size: 1, package_unit: 'kg', density: null, is_active: true, ...overrides,
})

before(async () => {
  fixture = await createInventoryFixture()
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  base = `http://127.0.0.1:${port}`
  app = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port),
      NUXT_SUPABASE_URL: fixture.url, NUXT_SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key' },
  })
  app.stdout.on('data', chunk => { output += chunk })
  app.stderr.on('data', chunk => { output += chunk })
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${base}/api/auth/session`)).ok) return } catch {}
    if (app.exitCode !== null) throw new Error(`App exited: ${output}`)
    await setTimeout(150)
  }
  throw new Error(`Built application did not start: ${output}`)
})

after(async () => {
  if (app && app.exitCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve))
    app.kill()
    await exited
  }
  await fixture?.close()
})

const day = offset => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86_400_000))
const key = () => crypto.randomUUID()

test('transaction pages and endpoints require authentication and respect roles', async () => {
  const anonymous = new Browser()
  for (const path of ['/api/transactions', '/api/transactions/batches', '/api/transactions/returnable', '/api/transactions/returns', '/api/transactions/preview']) {
    assert.equal((await anonymous.request(path)).status, 401, path)
  }
  for (const path of ['/receipts', '/issues', '/returns', '/transactions']) {
    assert.ok([302, 307].includes((await anonymous.request(path)).status), path)
  }
  const viewer = await new Browser().login('viewer')
  for (const path of ['/receipts', '/issues', '/returns', '/transactions']) {
    const response = await viewer.request(path)
    assert.equal(response.status, 200, path)
    assert.match(response.headers.get('cache-control'), /no-store/)
    const html = await response.text()
    assert.doesNotMatch(html, /Internal Server Error|fixture-publishable-key|fixture-only/)
  }
  for (const path of ['/api/transactions/receipts', '/api/transactions/issues', '/api/transactions/returns', '/api/transactions/returns/release']) {
    assert.equal((await viewer.mutate(path, {})).status, 403, path)
  }
  const operator = await new Browser().login('operator')
  assert.equal((await operator.mutate('/api/transactions/returns/release', {})).status, 403)
  assert.equal((await operator.mutate('/api/transactions/issues', {}, 'POST', 'https://outside.example')).status, 403)
  assert.equal((await operator.request('/api/transactions/issues', { method: 'POST', headers: { origin: base, 'content-type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await operator.mutate('/api/transactions/issues', { quantity: '-1' })).status, 400)
})

test('receipt → QC → FIFO split → held return → release keeps stock and immutable ledger consistent', async () => {
  const admin = await new Browser().login('admin')
  const operator = await new Browser().login('operator')
  const material = await json(await admin.mutate('/api/materials', materialInput({ code: 'DEMO-PHASE3', density: 0.8 })), 201)
  const warehouse = await json(await admin.mutate('/api/warehouses', { code: 'DEMO-P3-WH', name: '거래검증 창고', is_active: true }), 201)
  const location = await json(await admin.mutate('/api/locations', { warehouse_id: warehouse.id, code: 'P3-01', name: '거래검증 위치', is_active: true }), 201)
  const receiptInput = (number, quantity, offset) => ({ request_key: key(), material_id: material.id,
    lot_number: `000P3-${number}`, manufacturer: '가상 제조사', manufactured_on: day(-30),
    location_id: location.id, quantity, unit: 'kg', received_on: day(offset), expires_on: day(365),
    retest_on: null, test_number: `P3-QC-${number}`, receipt_reference: `P3-RC-${number}`, reason: '가상 입고 검증', notes: '',
  })
  const firstInput = receiptInput('A', '10', -2)
  const first = await json(await operator.mutate('/api/transactions/receipts', firstInput), 201)
  const second = await json(await operator.mutate('/api/transactions/receipts', receiptInput('B', '50', -1)), 201)
  const firstReplay = await json(await operator.mutate('/api/transactions/receipts', firstInput), 201)
  assert.equal(firstReplay.operation.id, first.operation.id)
  assert.equal((await operator.mutate('/api/transactions/receipts', { ...firstInput, quantity: '11' })).status, 409)
  const stock = async () => (await json(await operator.request(`/api/inventory?material_id=${material.id}&pageSize=100`))).items
  let rows = await stock()
  assert.equal(rows.reduce((sum, row) => sum + row.on_hand, 0), 60)
  assert.ok(rows.every(row => row.quality_status === 'PENDING' && row.available === 0))
  const issueInput = { request_key: key(), material_id: material.id, warehouse_id: warehouse.id,
    quantity: '15', unit: 'kg', occurred_on: day(0), production_item: '가상 제품', production_batch: 'P3-PROD-001', reason: 'FIFO 검증', notes: '가상 기록',
  }
  assert.equal((await operator.mutate('/api/transactions/issues', issueInput)).status, 409)
  async function approve(receipt, testNumber) {
    const batches = await json(await admin.request(`/api/batches?lot_id=${(await fixture.db.query('select lot_id from stock_batches where id=$1', [receipt.lines[0].batch_id])).rows[0].lot_id}`))
    const batch = batches.items.find(row => row.id === receipt.lines[0].batch_id)
    const { id, created_at, updated_at, ...input } = batch
    return json(await admin.mutate(`/api/batches/${id}`, { ...input, quality_status: 'APPROVED', decision_on: day(0), quality_reason: '가상 적합 판정', test_number: testNumber }, 'PATCH'))
  }
  await approve(first, 'P3-QC-A')
  await approve(second, 'P3-QC-B')
  const previewQuery = new URLSearchParams({ material_id: material.id, warehouse_id: warehouse.id, quantity: '15', unit: 'kg', occurred_on: day(0) })
  const preview = await json(await operator.request(`/api/transactions/preview?${previewQuery}`))
  assert.equal(preview.shortage, 0)
  assert.deepEqual(preview.lines.map(line => line.quantity), [10, 5])
  const issue = await json(await operator.mutate('/api/transactions/issues', issueInput), 201)
  assert.deepEqual(issue.lines.map(line => [line.batch_id, line.quantity, line.on_hand_after]), [
    [first.lines[0].batch_id, 10, 0], [second.lines[0].batch_id, 5, 45],
  ])
  assert.equal((await json(await operator.mutate('/api/transactions/issues', issueInput), 201)).operation.id, issue.operation.id)
  const beforeFailure = await stock()
  assert.equal((await operator.mutate('/api/transactions/issues', { ...issueInput, request_key: key(), quantity: '46' })).status, 409)
  assert.deepEqual(await stock(), beforeFailure, 'insufficient request must roll back all changes')
  assert.equal((await operator.mutate('/api/transactions/issues', { ...issueInput, request_key: key(), quantity: '1', occurred_on: day(-1) })).status, 400)
  const returned = await json(await operator.mutate('/api/transactions/returns', { request_key: key(), issue_line_id: issue.lines[0].id,
    location_id: location.id, quantity: '3', unit: 'kg', occurred_on: day(0), reason: '가상 미사용 반납', notes: '',
  }), 201)
  rows = await stock()
  const firstStock = rows.find(row => row.batch_id === first.lines[0].batch_id)
  assert.equal(firstStock.on_hand, 3)
  assert.equal(firstStock.held, 3)
  assert.equal(firstStock.available, 0)
  assert.equal((await operator.mutate('/api/transactions/returns', { request_key: key(), issue_line_id: issue.lines[0].id,
    location_id: location.id, quantity: '8', unit: 'kg', occurred_on: day(0), reason: '초과 반납 방지', notes: '',
  })).status, 409)
  const releaseInput = { request_key: key(), return_line_id: returned.lines[0].id, quantity: '2', unit: 'kg', occurred_on: day(0), reason: '가상 반납 승인', notes: '' }
  await json(await admin.mutate('/api/transactions/returns/release', releaseInput), 201)
  rows = await stock()
  assert.equal(rows.find(row => row.batch_id === first.lines[0].batch_id).available, 2)
  assert.equal(rows.find(row => row.batch_id === first.lines[0].batch_id).held, 1)
  assert.equal((await admin.mutate('/api/transactions/returns/release', { ...releaseInput, request_key: key(), quantity: '2' })).status, 409)
  const returnable = await json(await operator.request(`/api/transactions/returnable?material_id=${material.id}`))
  assert.equal(returnable.items.find(row => row.id === issue.lines[0].id).returnable_quantity, 7)
  const pending = await json(await admin.request(`/api/transactions/returns?material_id=${material.id}`))
  assert.equal(pending.items.find(row => row.id === returned.lines[0].id).releasable_quantity, 1)
  await approve(first, 'P3-RETEST-A')
  const ledger = await json(await operator.request(`/api/transactions?batch_id=${first.lines[0].batch_id}&q=P3-QC-A&from=${day(-3)}&to=${day(0)}&pageSize=100`))
  assert.ok(ledger.items.some(row => row.kind === 'ISSUE' && row.test_number_snapshot === 'P3-QC-A' && row.current_test_number === 'P3-RETEST-A'))
  assert.ok(ledger.items.every(row => row.batch_id === first.lines[0].batch_id))
  assert.deepEqual(ledger.items.map(row => row.occurred_on), [...ledger.items.map(row => row.occurred_on)].sort())
  const batchSearch = await json(await operator.request('/api/transactions/batches?q=P3-QC-A'))
  assert.ok(batchSearch.items.some(row => row.batch_id === first.lines[0].batch_id), 'previous QC number remains searchable')
  const detail = await json(await operator.request(`/api/transactions/${issue.operation.id}`))
  assert.equal(detail.lines.length, 2)
  assert.equal(detail.operation.actor_id, '00000000-0000-4000-8000-000000000002')
  assert.doesNotMatch(JSON.stringify(detail), /request_payload|access_token|refresh_token|fixture-only/)
  const converted = await json(await operator.mutate('/api/transactions/issues', { ...issueInput, request_key: key(), quantity: '1', unit: 'L' }), 201)
  assert.equal(converted.operation.quantity, 0.8)
  assert.equal(converted.operation.density_snapshot, 0.8)
  rows = await stock()
  assert.equal(rows.reduce((sum, row) => sum + row.on_hand, 0), 47.2)
  assert.equal(rows.reduce((sum, row) => sum + row.available, 0), 46.2)
  assert.equal((await operator.request('/api/transactions?from=2026-02-30')).status, 400)
  assert.equal((await operator.request('/api/transactions?type=TRANSFER')).status, 400)
})

test('BOM and planning routes enforce read/write roles, origin, and revisions', async () => {
  const anonymous = new Browser()
  const viewer = await new Browser().login('viewer')
  const operator = await new Browser().login('operator')
  for (const path of ['/api/boms', '/api/production/schedules', '/api/production/plans']) {
    assert.equal((await anonymous.request(path)).status, 401)
    await json(await viewer.request(path))
  }
  for (const path of ['/boms', '/production']) {
    assert.ok([302, 307].includes((await anonymous.request(path)).status))
    const response = await viewer.request(path)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control'), /no-store/)
    assert.doesNotMatch(await response.text(), /Internal Server Error|fixture-publishable-key/)
  }
  for (const path of ['/api/boms', '/api/production/schedules', '/api/production/plans/issue']) {
    assert.equal((await viewer.mutate(path, {})).status, 403)
  }
  assert.equal((await operator.mutate('/api/boms', {})).status, 403)
  assert.equal((await operator.mutate('/api/production/schedules', {}, 'POST', 'https://outside.example')).status, 403)
  assert.equal((await operator.mutate('/api/production/plans/issue', { plan_id: key(), expected_revision: 1, request_key: key(), occurred_on: day(0), reason: '확인', quantity: '1' })).status, 400)
  assert.equal((await operator.request('/api/production/plans?status=UNKNOWN')).status, 400)
})

test('web BOM schedule regenerates only pending plans and confirms cleaning blocks once', async () => {
  const admin = await new Browser().login('admin')
  const operator = await new Browser().login('operator')
  const material = await json(await admin.mutate('/api/materials', materialInput({ code: 'DEMO-PLAN-18L', density: 0.8 })), 201)
  const warehouse = await json(await admin.mutate('/api/warehouses', { code: 'DEMO-PLAN-WH', name: '계획검증 창고', is_active: true }), 201)
  const location = await json(await admin.mutate('/api/locations', { warehouse_id: warehouse.id, code: 'PLAN-01', name: '계획검증 위치', is_active: true }), 201)
  const receipts = []
  for (const [index, quantity] of ['25', '100'].entries()) {
    const receipt = await json(await operator.mutate('/api/transactions/receipts', {
      request_key: key(), material_id: material.id, lot_number: 'SAME-MANUFACTURER-LOT',
      manufacturer: '가상 제조사', manufactured_on: day(-30), location_id: location.id,
      quantity, unit: 'L', received_on: day(index - 2), expires_on: day(365), retest_on: null,
      test_number: `PLAN-QC-${index}`, receipt_reference: `PLAN-RC-${index}`, reason: '계획 검증 입고', notes: '',
    }), 201)
    receipts.push(receipt)
    const lotId = (await fixture.db.query('select lot_id from stock_batches where id=$1', [receipt.lines[0].batch_id])).rows[0].lot_id
    const batches = await json(await admin.request(`/api/batches?lot_id=${lotId}`))
    const { id, created_at, updated_at, ...batch } = batches.items.find(row => row.id === receipt.lines[0].batch_id)
    await json(await admin.mutate(`/api/batches/${id}`, { ...batch, quality_status: 'APPROVED', decision_on: day(0), quality_reason: '적합 판정' }, 'PATCH'))
  }
  const stock = async () => (await json(await operator.request(`/api/inventory?material_id=${material.id}&pageSize=100`))).items
  const before = await stock()
  const bomInput = { code: 'BOM-PLAN-HTTP', name: '제품 배합', product_name: '계획 검증 제품', is_active: true,
    components: [
      { material_id: material.id, quantity: '18', unit: 'L', issue_purpose: 'CLEANING' },
      { material_id: material.id, quantity: '1', unit: 'kg', issue_purpose: 'GENERAL' },
    ], reason: 'BOM 최초 등록' }
  const bom = await json(await admin.mutate('/api/boms', bomInput))
  assert.equal((await json(await operator.request(`/api/boms/${bom.id}`))).components.length, 2)
  assert.equal((await json(await operator.request('/api/boms?q=BOM-PLAN-HTTP'))).total, 1)
  const scheduleInput = { code: 'PLAN-HTTP', bom_id: bom.id, scheduled_on: day(1), multiplier: '2', production_batch: '000-PROD', notes: '가상 일정', status: 'ACTIVE', reason: '일정 최초 등록' }
  let saved = await json(await operator.mutate('/api/production/schedules', scheduleInput))
  assert.equal(saved.plans.length, 2)
  assert.deepEqual(await stock(), before, 'creating plans must not reserve or deduct stock')
  const original = saved.plans.find(row => row.issue_purpose === 'CLEANING')
  const confirm = plan => ({ plan_id: plan.id, expected_revision: plan.revision, request_key: key(), occurred_on: day(0), warehouse_id: warehouse.id, reason: '계획 출고 확정', notes: '' })
  assert.equal((await operator.mutate('/api/production/plans/issue', confirm(original))).status, 400)
  saved = await json(await operator.mutate('/api/production/schedules', { ...scheduleInput, id: saved.schedule.id, expected_revision: saved.schedule.revision, scheduled_on: day(0), reason: '오늘로 일정 변경' }))
  const cleaning = saved.plans.find(row => row.issue_purpose === 'CLEANING')
  assert.equal(cleaning.id, original.id)
  assert.equal(cleaning.quantity, 36)
  assert.ok(cleaning.revision > original.revision)
  assert.equal((await operator.mutate('/api/production/plans/issue', confirm(original))).status, 409)
  const preview = await json(await operator.request(`/api/transactions/preview?${new URLSearchParams({ material_id: material.id, quantity: '36', unit: 'L', issue_purpose: 'CLEANING', occurred_on: day(0), warehouse_id: warehouse.id })}`))
  assert.deepEqual(preview.lines.map(row => row.quantity), [14.4, 14.4])
  const issueInput = confirm(cleaning)
  const issued = await json(await operator.mutate('/api/production/plans/issue', issueInput))
  assert.deepEqual(issued.lines.map(row => row.quantity), [14.4, 14.4])
  assert.equal(issued.operation.issue_purpose, 'CLEANING')
  assert.equal(issued.operation.input_quantity, 36)
  assert.equal(issued.operation.quantity, 28.8)
  assert.equal(issued.operation.density_snapshot, 0.8)
  const oldStock = (await stock()).find(row => row.batch_id === receipts[0].lines[0].batch_id)
  assert.equal(oldStock.on_hand, 5.6, 'old physical batch keeps 7L despite matching manufacturer LOT')
  assert.equal((await json(await operator.mutate('/api/production/plans/issue', issueInput))).operation.id, issued.operation.id)
  assert.equal((await operator.mutate('/api/production/plans/issue', { ...issueInput, request_key: key() })).status, 409)
  const plans = async () => (await json(await operator.request(`/api/production/plans?schedule_id=${saved.schedule.id}&pageSize=100`))).items
  const postedPlan = (await plans()).find(row => row.id === cleaning.id)
  const manual = await json(await operator.mutate('/api/transactions/issues', {
    request_key: key(), material_id: material.id, warehouse_id: warehouse.id, quantity: '1', unit: 'kg',
    occurred_on: day(0), reason: '수기 추가 출고',
  }), 201)
  saved = await json(await operator.mutate('/api/production/schedules', { ...scheduleInput, id: saved.schedule.id, expected_revision: saved.schedule.revision, multiplier: '3', scheduled_on: day(2), reason: '잔여 예정 변경' }))
  const afterChange = await plans()
  assert.deepEqual(afterChange.find(row => row.id === cleaning.id), postedPlan, 'posted plan remains unchanged when schedule is edited')
  assert.equal(afterChange.find(row => row.issue_purpose === 'GENERAL').quantity, 3)
  assert.equal(afterChange.find(row => row.issue_purpose === 'GENERAL').planned_on, day(2))
  saved = await json(await operator.mutate('/api/production/schedules', { ...scheduleInput, id: saved.schedule.id, expected_revision: saved.schedule.revision, status: 'CANCELLED', reason: '미출고 일정 취소' }))
  assert.equal(saved.plans.find(row => row.issue_purpose === 'GENERAL').status, 'CANCELLED')
  assert.equal(saved.plans.find(row => row.issue_purpose === 'CLEANING').status, 'ISSUED')
  assert.equal((await json(await operator.request(`/api/transactions/${manual.operation.id}`))).operation.id, manual.operation.id)
  assert.equal((await json(await operator.mutate('/api/production/plans/issue', issueInput))).operation.id, issued.operation.id, 'retry remains safe after schedule cancellation')
  const movements = await json(await operator.request(`/api/transactions?material_id=${material.id}&type=ISSUE&pageSize=100`))
  assert.equal(movements.items.length, 3, 'two cleaning lines and one manual line only')
})
