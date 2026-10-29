import { appendResponseHeader, getHeader } from 'h3'
import type { AuthUser, AuthSessionResponse, LoginResponse } from '#shared/types/auth'

export function authErrorMessage(error: unknown): string {
  const candidate = error as { statusCode?: number; status?: number; response?: { status?: number } }
  const status = candidate.statusCode ?? candidate.status ?? candidate.response?.status
  if (status === 400) return '이메일과 비밀번호를 다시 확인해 주세요.'
  if (status === 401) return '이메일 또는 비밀번호가 올바르지 않거나 세션이 만료되었습니다.'
  if (status === 403) return '사용이 제한된 계정입니다. 관리자에게 계정 및 접근 권한을 확인해 주세요.'
  if (status === 429) return '요청이 많습니다. 잠시 후 다시 시도해 주세요.'
  return '인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'
}

export function useAuth() {
  const user = useState<AuthUser | null>('auth:user', () => null)
  const configured = useState<boolean>('auth:configured', () => true)
  const loaded = useState<boolean>('auth:loaded', () => false)
  const sessionError = useState<string | null>('auth:error', () => null)
  const logoutNotice = useState<string | null>('auth:logout-notice', () => null)
  const event = import.meta.server ? useRequestEvent() : undefined

  async function fetchWithSession<T>(path: string): Promise<T> {
    const cookieHeader = import.meta.server && event
      ? (event.context.warehouseAuthCookie as string | undefined) ?? getHeader(event, 'cookie') ?? ''
      : undefined
    // Nitro's event.$fetch is a callable without `.raw`. Use the raw local
    // fetch API and explicitly carry only the credentials this BFF needs.
    const response = await $fetch.raw<T>(path, {
      ignoreResponseError: true,
      headers: cookieHeader !== undefined ? { cookie: cookieHeader } : undefined,
    })
    if (import.meta.server && event) {
      // Keep refreshed credentials on this SSR request only. useState would expose
      // them in the hydration payload, so the request context is deliberately used.
      const cookies = new Map((cookieHeader ?? getHeader(event, 'cookie') ?? '').split(';').filter(Boolean).map((cookie) => {
        const separator = cookie.indexOf('=')
        return [cookie.slice(0, separator).trim(), cookie.slice(separator + 1)] as [string, string]
      }))
      for (const cookie of response.headers.getSetCookie()) {
        appendResponseHeader(event, 'set-cookie', cookie)
        const pair = cookie.split(';', 1)[0] ?? ''
        const separator = pair.indexOf('=')
        if (separator > 0) {
          const name = pair.slice(0, separator).trim()
          const value = pair.slice(separator + 1)
          if (value) cookies.set(name, value)
          else cookies.delete(name)
        }
      }
      event.context.warehouseAuthCookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
    }
    if (!response.ok) throw createError({ statusCode: response.status, statusMessage: 'Authentication request failed' })
    return response._data as T
  }

  async function refreshSession() {
    sessionError.value = null
    try {
      const session = await fetchWithSession<AuthSessionResponse>('/api/auth/session')
      user.value = session.user
      configured.value = session.configured
      loaded.value = true
      return session
    }
    catch (error) {
      user.value = null
      loaded.value = true
      sessionError.value = authErrorMessage(error)
      throw error
    }
  }

  async function login(credentials: { email: string; password: string }) {
    const result = await $fetch<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: credentials,
    })
    user.value = result.user
    configured.value = true
    sessionError.value = null
    logoutNotice.value = null
    loaded.value = true
  }

  async function logout() {
    logoutNotice.value = null
    try { await $fetch('/api/auth/logout', { method: 'POST' }) }
    catch (error) {
      const response = error as { statusCode?: number; status?: number }
      if ((response.statusCode ?? response.status) !== 503) throw error
      logoutNotice.value = '현재 브라우저에서 로그아웃했습니다. 인증 서버의 세션 종료는 확인하지 못했습니다.'
    }
    user.value = null
    sessionError.value = null
    loaded.value = false
    await navigateTo('/login', { replace: true })
  }

  return { user, configured, loaded, sessionError, logoutNotice, refreshSession, fetchWithSession, login, logout }
}
