import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout } from 'node:timers/promises'
import { createSupabaseFixture, testPassword } from '../fixtures/supabase.mjs'

let fixture
let app
let base
let output = ''

async function freePort() {
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}

class Browser {
  cookies = new Map()
  async request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      redirect: 'manual', ...options,
      headers: { cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers },
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const separator = pair.indexOf('=')
      const key = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      if (value) this.cookies.set(key, value)
      else this.cookies.delete(key)
    }
    return response
  }
  post(path, body, origin = base) {
    return this.request(path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  login(role = 'viewer', password = testPassword) {
    return this.post('/api/auth/login', { email: `${role}@example.test`, password })
  }
}

before(async () => {
  fixture = await createSupabaseFixture()
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  app = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), NUXT_SUPABASE_URL: fixture.url, NUXT_SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key' },
  })
  app.stdout.on('data', chunk => { output += chunk })
  app.stderr.on('data', chunk => { output += chunk })
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${base}/api/auth/session`)).ok) { ready = true; break } } catch {}
    if (app.exitCode !== null) throw new Error(`App exited: ${output}`)
    await setTimeout(150)
  }
  assert.ok(ready, `Built application did not start: ${output}`)
})

after(async () => {
  if (app && app.exitCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve))
    app.kill()
    await exited
  }
  await fixture?.close()
})

test('anonymous session and protected API/page', async () => {
  const browser = new Browser()
  const session = await browser.request('/api/auth/session')
  assert.deepEqual(await session.json(), { user: null, configured: true })
  assert.match(session.headers.get('cache-control'), /no-store/)
  assert.equal((await browser.request('/api/dashboard')).status, 401)
  const page = await browser.request('/')
  assert.ok([302, 307].includes(page.status))
  assert.match(page.headers.get('location'), /^\/login/)
})

test('Zod rejects invalid credentials shape; external-origin login is blocked', async () => {
  const browser = new Browser()
  assert.equal((await browser.post('/api/auth/login', { email: 'invalid', password: '' })).status, 400)
  assert.equal((await browser.post('/api/auth/login', { email: 'viewer@example.test', password: testPassword, role: 'admin' })).status, 400)
  const malformed = await browser.request('/api/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{broken' })
  assert.equal(malformed.status, 400)
  assert.equal((await browser.post('/api/auth/login', { email: 'viewer@example.test', password: testPassword }, 'https://attacker.example')).status, 403)
  assert.equal((await browser.login('viewer', 'wrong-password')).status, 401)
})

test('login -> private dashboard -> refresh -> logout; tokens stay in HttpOnly cookies', async () => {
  const browser = new Browser()
  const login = await browser.login()
  assert.equal(login.status, 200)
  const loginBody = await login.json()
  assert.equal(loginBody.user.role, 'viewer')
  assert.equal(loginBody.user.email, 'viewer@example.test')
  assert.equal('access_token' in loginBody, false)
  assert.ok(login.headers.getSetCookie().some(cookie => /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie)))
  assert.equal((await browser.request('/api/dashboard')).status, 200)
  const page = await browser.request('/')
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /대시보드/)
  assert.doesNotMatch(html, /fixture-publishable-key|fixture-only/)
  assert.match(page.headers.get('cache-control'), /no-store/)
  const refreshed = await browser.request('/api/auth/session')
  assert.equal((await refreshed.json()).user.role, 'viewer')
  assert.equal((await browser.post('/api/auth/logout', {})).status, 200)
  assert.equal((await browser.request('/api/dashboard')).status, 401)
  assert.equal((await (await browser.request('/api/auth/session')).json()).user, null)
})

test('database role overrides user metadata, and inactive profile is rejected', async () => {
  for (const role of ['viewer', 'operator', 'admin']) {
    const browser = new Browser()
    const result = await browser.login(role)
    assert.equal(result.status, 200)
    assert.equal((await result.json()).user.role, role)
  }
  const inactive = new Browser()
  assert.equal((await inactive.login('inactive')).status, 403)
  assert.equal((await inactive.request('/api/dashboard')).status, 401)
})

test('SSR refresh sends replacement cookies to the browser', async () => {
  const browser = new Browser()
  const session = fixture.expiredSession()
  browser.cookies.set('warehouse-auth', `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`)
  const before = fixture.state.refreshCount
  const page = await browser.request('/')
  assert.equal(page.status, 200)
  assert.ok(fixture.state.refreshCount > before)
  assert.ok(page.headers.getSetCookie().some(cookie => cookie.startsWith('warehouse-auth')))
  assert.equal((await (await browser.request('/api/auth/session')).json()).user.role, 'viewer')
})

test('upstream failure fails closed, without leaking provider details', async () => {
  const browser = new Browser()
  await browser.login()
  fixture.state.unavailable = true
  try {
    const response = await browser.request('/api/auth/session')
    assert.equal(response.status, 503)
    assert.doesNotMatch(await response.text(), /fixture-publishable-key|Fixture service unavailable|access_token/)
  } finally { fixture.state.unavailable = false }
})

test('logout clears local cookies even when the upstream service is unavailable', async () => {
  const browser = new Browser()
  await browser.login()
  fixture.state.unavailable = true
  try {
    const response = await browser.post('/api/auth/logout', {})
    assert.equal(response.status, 503)
    assert.equal(browser.cookies.size, 0)
  } finally { fixture.state.unavailable = false }
  assert.equal((await browser.request('/api/dashboard')).status, 401)
})
