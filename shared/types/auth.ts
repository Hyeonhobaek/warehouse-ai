export const userRoles = ['viewer', 'operator', 'admin'] as const

export type UserRole = typeof userRoles[number]

export interface AuthUser {
  id: string
  email: string
  displayName: string
  role: UserRole
}

export interface AuthSessionResponse {
  user: AuthUser | null
  configured: boolean
}

export interface LoginResponse {
  user: AuthUser
}
