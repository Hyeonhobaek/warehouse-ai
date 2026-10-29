import { createError, defineEventHandler, getHeader, readBody } from 'h3'
import { loginSchema } from '../../../shared/schemas/auth'
import type { LoginResponse } from '../../../shared/types/auth'
import { getAuthenticatedUser } from '../../services/auth'
import { requireSameOrigin } from '../../utils/request-security'
import { clearAuthCookies, createSupabaseServerClient } from '../../utils/supabase'

export default defineEventHandler(async (event): Promise<LoginResponse> => {
  requireSameOrigin(event)

  if (getHeader(event, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw createError({ statusCode: 415, statusMessage: 'Unsupported Media Type', message: 'JSON 요청이 필요합니다.' })
  }

  if (Number(getHeader(event, 'content-length') || 0) > 16_384) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: '요청 데이터가 너무 큽니다.' })
  }

  const parsed = loginSchema.safeParse(await readBody(event, { strict: true }))
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: '이메일과 비밀번호를 확인해 주세요.',
      data: { fields: parsed.error.flatten().fieldErrors },
    })
  }

  const supabase = createSupabaseServerClient(event)
  const { error } = await supabase.auth.signInWithPassword(parsed.data)

  if (error) {
    if (error.status === 429) {
      throw createError({ statusCode: 429, statusMessage: 'Too Many Requests', message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' })
    }
    if (!error.status || error.status >= 500 || (error.status === 401 && error.code !== 'invalid_credentials') || error.name === 'AuthRetryableFetchError') {
      throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: '인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' })
    }
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: '이메일 또는 비밀번호가 올바르지 않습니다.' })
  }

  try {
    const user = await getAuthenticatedUser(event, supabase)
    if (!user) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: '로그인을 완료할 수 없습니다. 다시 시도해 주세요.' })
    }
    return { user }
  }
  catch (error) {
    // Do not retain a signed-in session when no active application profile can be verified.
    await supabase.auth.signOut({ scope: 'local' })
    clearAuthCookies(event)
    throw error
  }
})
