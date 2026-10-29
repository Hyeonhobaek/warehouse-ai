import { createError, getHeader, getRequestURL, setResponseHeaders, type H3Event } from 'h3'

export function preventCaching(event: H3Event): void {
  setResponseHeaders(event, {
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
  })
}

/** Cookies are HttpOnly; mutation endpoints also reject cross-site/login-CSRF requests. */
export function requireSameOrigin(event: H3Event): void {
  const origin = getHeader(event, 'origin')
  const requestOrigin = getRequestURL(event).origin

  if (!origin || origin !== requestOrigin || getHeader(event, 'sec-fetch-site') === 'cross-site') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: '허용되지 않은 요청입니다.' })
  }
}
