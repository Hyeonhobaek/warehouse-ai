import { createError, type H3Event } from 'h3'
import { userRoles, type AuthUser } from '../../shared/types/auth'
import { hasPermission, type Permission } from '../../shared/utils/permissions'
import { clearAuthCookies, createSupabaseServerClient, type SupabaseServerClient } from '../utils/supabase'

const expiredSessionCodes = new Set([
  'bad_jwt',
  'session_not_found',
  'session_expired',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'user_not_found',
  'user_banned',
])

export async function getAuthenticatedUser(event: H3Event, client?: SupabaseServerClient): Promise<AuthUser | null> {
  const supabase = client ?? createSupabaseServerClient(event)
  // getSession() alone reads untrusted storage; getUser() validates with the Auth service.
  const { data, error } = await supabase.auth.getUser()

  if (error) {
    if (error.name === 'AuthSessionMissingError' || expiredSessionCodes.has(error.code ?? '')) {
      clearAuthCookies(event)
      return null
    }

    throw createError({
      statusCode: 503,
      statusMessage: 'Service Unavailable',
      message: '인증 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    })
  }

  if (!data.user) return null

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, display_name, role, is_active')
    .eq('id', data.user.id)
    .maybeSingle()

  if (profileError) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Service Unavailable',
      message: '사용자 권한을 확인할 수 없습니다. 데이터베이스 설정을 확인해 주세요.',
    })
  }

  if (!profile || !profile.is_active || !userRoles.includes(profile.role)) {
    clearAuthCookies(event)
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      message: '사용 권한이 없는 계정입니다. 관리자에게 문의해 주세요.',
    })
  }

  // Never authorize with client-controlled user_metadata or a role sent in a login body.
  return {
    id: data.user.id,
    email: data.user.email ?? '',
    displayName: profile.display_name,
    role: profile.role,
  }
}

export async function requireAuthenticatedUser(event: H3Event): Promise<AuthUser> {
  const user = await getAuthenticatedUser(event)

  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: '로그인이 필요합니다.' })
  }

  return user
}

export async function requirePermission(event: H3Event, permission: Permission): Promise<AuthUser> {
  const user = await requireAuthenticatedUser(event)

  if (!hasPermission(user.role, permission)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden', message: '이 작업을 수행할 권한이 없습니다.' })
  }

  return user
}
