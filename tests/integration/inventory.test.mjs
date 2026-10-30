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

test('inventory routes require a session and protect SSR pages from caching', async () => {
  const anon = new Browser()
  for (const path of ['/api/materials', '/api/lots', '/api/batches', '/api/warehouses', '/api/locations', '/api/inventory', '/api/inventory/summary', '/api/materials/export', '/api/inventory/export']) {
    assert.equal((await anon.request(path)).status, 401, path)
  }
  for (const path of ['/materials', '/inventory', '/warehouses']) {
    const response = await anon.request(path)
    assert.ok([302, 307].includes(response.status), path)
    assert.match(response.headers.get('location'), /^\/login/)
  }
  const viewer = await new Browser().login()
  for (const path of ['/materials', '/inventory', '/warehouses']) {
    const response = await viewer.request(path)
    assert.equal(response.status, 200, path)
    assert.match(response.headers.get('cache-control'), /no-store/)
    const html = await response.text()
    assert.doesNotMatch(html, /fixture-publishable-key|fixture-only/)
    assert.doesNotMatch(html, /페이지를 찾을 수 없|Internal Server Error/)
  }
})

test('viewer/operator can read stock but cannot mutate master records', async () => {
  for (const role of ['viewer', 'operator']) {
    const browser = await new Browser().login(role)
    const result = await json(await browser.request('/api/inventory?pageSize=100'))
    assert.ok(result.items.length > 0)
    assert.ok(result.asOf)
    assert.equal((await browser.mutate('/api/materials', materialInput())).status, 403)
    assert.equal((await browser.mutate('/api/warehouses', { code: 'DENIED', name: '가상', is_active: true })).status, 403)
    assert.equal((await browser.mutate('/api/batches', {})).status, 403)
  }
})

test('inventory reads keep refreshed authentication on the same request', async () => {
  const browser = new Browser()
  browser.cookies.set('warehouse-auth', `base64-${Buffer.from(JSON.stringify(fixture.expiredSession())).toString('base64url')}`)
  const before = fixture.state.refreshCount
  const response = await browser.request('/api/inventory')
  const body = await json(response)
  assert.ok(body.items.length > 0)
  assert.ok(fixture.state.refreshCount > before)
  assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith('warehouse-auth')))
  assert.doesNotMatch(JSON.stringify(body), /access_token|refresh_token|fixture-only/)
})

test('stock filters and material totals preserve units, quality, reservations and pagination', async () => {
  const browser = await new Browser().login()
  const stock = await json(await browser.request('/api/inventory?pageSize=100'))
  const summary = await json(await browser.request('/api/inventory/summary?pageSize=100'))
  assert.ok(summary.items.some(row => row.on_hand === 0), 'zero-stock materials remain visible')
  assert.ok(stock.items.some(row => row.reserved > 0), 'reservation fixture')
  for (const row of stock.items) {
    assert.ok(row.on_hand >= 0 && row.available >= 0 && row.reserved <= row.on_hand)
    if (row.effective_status !== 'APPROVED') assert.equal(row.available, 0)
  }
  for (const material of summary.items) {
    const rows = stock.items.filter(row => row.material_id === material.material_id)
    const total = rows.reduce((sum, row) => sum + row.on_hand, 0)
    assert.ok(Math.abs(total - material.on_hand) < 0.000001)
  }
  const expired = await json(await browser.request('/api/inventory?status=EXPIRED'))
  assert.ok(expired.items.length > 0)
  assert.ok(expired.items.every(row => row.effective_status === 'EXPIRED' && row.available === 0))
  const first = await json(await browser.request('/api/inventory?page=1&pageSize=1'))
  const second = await json(await browser.request('/api/inventory?page=2&pageSize=1'))
  assert.equal(first.total, stock.total)
  assert.notEqual(first.items[0].id, second.items[0].id)
  assert.equal((await browser.request('/api/inventory?page=-1')).status, 400)
  assert.equal((await browser.request('/api/inventory?status=UNKNOWN')).status, 400)
})

test('admin material CRUD validates payloads, searches aliases and protects referenced units', async () => {
  const browser = await new Browser().login('admin')
  const input = materialInput()
  const created = await json(await browser.mutate('/api/materials', input), 201)
  assert.equal(created.code, input.code)
  assert.equal((await browser.mutate('/api/materials', input)).status, 409)
  assert.equal((await browser.mutate('/api/materials', { ...input, code: 'INVALID', min_stock: -1 })).status, 400)
  assert.equal((await browser.mutate('/api/materials', { ...input, code: 'INVALID', on_hand: 100 })).status, 400)
  const found = await json(await browser.request('/api/materials?q=' + encodeURIComponent('샘플별칭')))
  assert.equal(found.items.length, 1)
  assert.equal(found.items[0].id, created.id)
  const updated = await json(await browser.mutate(`/api/materials/${created.id}`, { ...input, name: '가상 수정 원료', is_active: false }, 'PATCH'))
  assert.equal(updated.is_active, false)
  const noMatch = await json(await browser.request('/api/materials?q=' + encodeURIComponent('x),id.not.is.null')))
  assert.equal(noMatch.items.length, 0)
  assert.equal((await browser.mutate(`/api/materials/${created.id}`, {}, 'DELETE')).status, 200)
  assert.equal((await browser.request(`/api/materials/${created.id}`)).status, 404)
  const stocks = await json(await browser.request('/api/inventory?pageSize=1'))
  const referenced = await json(await browser.request(`/api/materials/${stocks.items[0].material_id}`))
  const { id, created_at, updated_at, search_text, ...fields } = referenced
  assert.equal((await browser.mutate(`/api/materials/${id}`, { ...fields, base_unit: fields.base_unit === 'kg' ? 'g' : 'kg' }, 'PATCH')).status, 409)
  assert.equal((await browser.mutate(`/api/materials/${id}`, {}, 'DELETE')).status, 409, JSON.stringify(fixture.errors.slice(-1)))
  assert.equal((await browser.mutate('/api/materials', input, 'POST', 'https://outside.example')).status, 403)
})

test('LOT receipt metadata and QC history never add or duplicate stock', async () => {
  const browser = await new Browser().login('admin')
  const material = await json(await browser.mutate('/api/materials', materialInput({ code: 'DEMO-HTTP-002' })), 201)
  const lotInput = { material_id: material.id, lot_number: '000123', manufacturer: '가상 제조사', manufactured_on: '2026-01-01', notes: '' }
  const lot = await json(await browser.mutate('/api/lots', lotInput), 201)
  assert.equal(lot.lot_number, '000123')
  assert.equal((await browser.mutate('/api/lots', lotInput)).status, 409)
  const batchInput = { lot_id: lot.id, receipt_reference: 'DEMO-HTTP-IN-001', received_on: '2026-10-01', expires_on: '2028-10-01', retest_on: '2027-10-01', test_number: 'DEMO-QC-001', quality_status: 'PENDING', decision_on: null, quality_reason: '가상 등록', notes: '' }
  assert.equal((await browser.mutate('/api/batches', { ...batchInput, received_on: '2026-02-30' })).status, 400)
  const batch = await json(await browser.mutate('/api/batches', batchInput), 201)
  const history = await json(await browser.request(`/api/batches/${batch.id}/history`))
  assert.equal(history.length, 1)
  const approved = { ...batchInput, quality_status: 'APPROVED', decision_on: '2026-10-02', quality_reason: '가상 판정 검증' }
  await json(await browser.mutate(`/api/batches/${batch.id}`, approved, 'PATCH'))
  const next = await json(await browser.request(`/api/batches/${batch.id}/history`))
  assert.equal(next.length, 2)
  assert.ok(next.some(item => item.quality_status === 'PENDING'))
  assert.ok(next.some(item => item.quality_status === 'APPROVED'))
  const summary = await json(await browser.request('/api/inventory/summary?q=DEMO-HTTP-002'))
  assert.equal(summary.items[0].on_hand, 0)
  const page = await browser.request(`/materials/${material.id}`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /000123/)
})

test('warehouse and location CRUD and CSV downloads use authenticated APIs', async () => {
  const browser = await new Browser().login('admin')
  const warehouse = await json(await browser.mutate('/api/warehouses', { code: 'DEMO-HTTP-WH', name: '가상 검증 창고', is_active: true }), 201)
  const locationInput = { warehouse_id: warehouse.id, code: 'A-01', name: '가상 검증 위치', is_active: true }
  const location = await json(await browser.mutate('/api/locations', locationInput), 201)
  const locations = await json(await browser.request(`/api/locations?warehouse_id=${warehouse.id}`))
  assert.equal(locations.total, 1)
  const updated = await json(await browser.mutate(`/api/locations/${location.id}`, { ...locationInput, is_active: false }, 'PATCH'))
  assert.equal(updated.is_active, false)
  const csv = await browser.request('/api/inventory/export?status=EXPIRED')
  assert.equal(csv.status, 200)
  assert.match(csv.headers.get('content-type'), /text\/csv/)
  assert.match(csv.headers.get('content-disposition'), /attachment/)
  assert.match(await csv.text(), /기한 경과|EXPIRED/)
  const materialsCsv = await browser.request('/api/materials/export')
  assert.equal(materialsCsv.status, 200)
  assert.match(await materialsCsv.text(), /DEMO-HTTP-002/)
})
