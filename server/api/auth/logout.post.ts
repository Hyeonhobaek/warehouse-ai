import { createError, defineEventHandler } from 'h3'
import { requireSameOrigin } from '../../utils/request-security'
import { clearAuthCookies, createSupabaseServerClient, getSupabaseConfiguration } from '../../utils/supabase'

export default defineEventHandler(async (event) => {
  requireSameOrigin(event)

  try {
    if (getSupabaseConfiguration(event).configured) {
      const supabase = createSupabaseServerClient(event)
      const { error } = await supabase.auth.signOut({ scope: 'local' })
      if (error) {
        throw createError({
          statusCode: 503,
          statusMessage: 'Service Unavailable',
          message: '현재 기기에서 로그아웃했습니다. 인증 서버의 세션 종료는 확인하지 못했습니다.',
        })
      }
    }
  }
  finally {
    // Clear local credentials even if the Auth service is temporarily unavailable.
    clearAuthCookies(event)
  }

  return { success: true }
})
