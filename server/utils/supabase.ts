import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createError, deleteCookie, parseCookies, setCookie, setResponseHeaders, type H3Event } from 'h3'
import { useRuntimeConfig } from '#imports'
import type { Database } from '../../shared/types/database'

const authCookieName = 'warehouse-auth'

export function getSupabaseConfiguration(event: H3Event) {
  const config = useRuntimeConfig(event)
  const url = String(config.supabaseUrl || '').trim()
  const publishableKey = String(config.supabasePublishableKey || '').trim()

  return { url, publishableKey, configured: Boolean(url && publishableKey) }
}

export function clearAuthCookies(event: H3Event): void {
  const cookieNames = new Set([
    authCookieName,
    ...Object.keys(parseCookies(event)).filter(name => name.startsWith(`${authCookieName}.`)),
    ...(event.context.authCookieNames as Set<string> | undefined ?? []),
  ])

  for (const name of cookieNames) {
    deleteCookie(event, name, { path: '/', httpOnly: true, sameSite: 'lax', secure: !import.meta.dev })
  }
}

export function createSupabaseServerClient(event: H3Event): SupabaseClient<Database> {
  const existing = event.context.warehouseSupabase as SupabaseClient<Database> | undefined
  if (existing) return existing
  const { url, publishableKey, configured } = getSupabaseConfiguration(event)

  let validUrl = false
  try {
    validUrl = ['http:', 'https:'].includes(new URL(url).protocol)
  }
  catch { /* Invalid environment configuration is reported without exposing its value. */ }

  if (!configured || !validUrl) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Service Unavailable',
      message: 'Supabase 연결 설정이 필요합니다. 관리자에게 문의해 주세요.',
    })
  }

  // A new client per request prevents one user's session from leaking into another request.
  const requestCookies = parseCookies(event)

  const client = createServerClient<Database>(url, publishableKey, {
    global: {
      fetch(input, init) {
        const timeout = AbortSignal.timeout(8000)
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
        return globalThis.fetch(input, { ...init, signal })
      },
    },
    cookieOptions: {
      name: authCookieName,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: !import.meta.dev,
    },
    cookies: {
      getAll() {
        return Object.entries(requestCookies).map(([name, value]) => ({ name, value }))
      },
      setAll(cookiesToSet, cacheHeaders) {
        setResponseHeaders(event, cacheHeaders)
        const writtenCookieNames: Set<string> = event.context.authCookieNames ??= new Set<string>()
        for (const { name, value, options } of cookiesToSet) {
          writtenCookieNames.add(name)
          requestCookies[name] = value
          setCookie(event, name, value, {
            ...options,
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: !import.meta.dev,
          })
        }
      },
    },
  })
  // Auth validation may refresh the session. Reuse that client for this request's
  // queries so they cannot accidentally read the stale incoming cookie again.
  event.context.warehouseSupabase = client
  return client
}

export type SupabaseServerClient = ReturnType<typeof createSupabaseServerClient>
