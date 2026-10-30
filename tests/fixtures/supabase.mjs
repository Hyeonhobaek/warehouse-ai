// Test-only HTTP double for the external Supabase service. The application has
// no mock-auth mode; tests point its ordinary environment variables here.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const testPassword = 'Phase1-test-only!'
const identities = ['viewer', 'operator', 'admin', 'inactive'].map((role, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  email: `${role}@example.test`,
  role: role === 'inactive' ? 'viewer' : role,
  display_name: `${role === 'admin' ? '관리자' : role === 'operator' ? '운영자' : '조회자'} 테스트`,
  is_active: role !== 'inactive',
}))

export async function createSupabaseFixture(port = 0, options = {}) {
  const sessions = new Map()
  const refreshTokens = new Map()
  const state = { unavailable: false, refreshCount: 0 }
  const issue = (identity, expiresIn = 3600) => {
    const timestamp = Math.floor(Date.now() / 1000)
    const payload = { sub: identity.id, aud: 'authenticated', role: 'authenticated', exp: timestamp + expiresIn, iat: timestamp, session_id: randomUUID() }
    const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture-only`
    const refreshToken = randomUUID()
    sessions.set(token, identity)
    refreshTokens.set(refreshToken, identity)
    return { access_token: token, refresh_token: refreshToken, expires_in: expiresIn, expires_at: payload.exp, token_type: 'bearer', user: user(identity) }
  }
  const user = identity => ({
    id: identity.id, email: identity.email, aud: 'authenticated', role: 'authenticated',
    app_metadata: { provider: 'email', providers: ['email'] },
    // A spoofed role here must never grant application permissions.
    user_metadata: { display_name: identity.display_name, role: 'admin' },
    created_at: '2026-01-01T00:00:00.000Z',
  })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (state.unavailable) return reply(503, { message: 'Fixture service unavailable' })
    let raw = ''
    for await (const chunk of request) raw += chunk
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { return reply(400, { message: 'Invalid JSON' }) }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const identity = identities.find(item => item.email === body.email)
      if (!identity || body.password !== testPassword) return reply(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
      return reply(200, issue(identity))
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const identity = refreshTokens.get(body.refresh_token)
      if (!identity) return reply(400, { error_code: 'refresh_token_not_found', msg: 'Refresh token not found' })
      state.refreshCount++
      return reply(200, issue(identity))
    }
    const token = request.headers.authorization?.replace(/^Bearer /i, '')
    const identity = sessions.get(token)
    if (url.pathname === '/auth/v1/user') {
      return identity ? reply(200, user(identity)) : reply(401, { error_code: 'bad_jwt', msg: 'Invalid JWT' })
    }
    if (url.pathname === '/auth/v1/logout') {
      sessions.delete(token)
      for (const [key, value] of refreshTokens) if (value.id === identity?.id) refreshTokens.delete(key)
      return reply(204, null)
    }
    if (url.pathname === '/rest/v1/profiles') {
      if (!identity) return reply(401, { message: 'Unauthorized' })
      const allowed = identity.is_active && url.searchParams.get('id') === `eq.${identity.id}`
      const profile = allowed ? { ...identity, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' } : null
      const singular = request.headers.accept?.includes('application/vnd.pgrst.object+json')
      if (singular && !profile) return reply(406, { code: 'PGRST116', message: 'No rows', details: 'The result contains 0 rows' })
      return reply(200, singular ? profile : profile ? [profile] : [])
    }
    if (url.pathname.startsWith('/rest/v1/') && options.handleRest) {
      return options.handleRest({ request, response, url, body, identity, reply })
    }
    return reply(404, { message: `Fixture does not implement ${url.pathname}` })
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    expiredSession: (role = 'viewer') => issue(identities.find(item => item.role === role), -60),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await createSupabaseFixture(Number(process.env.FIXTURE_PORT || 54329))
  console.log(`TEST-ONLY Supabase fixture: ${fixture.url}`)
}
