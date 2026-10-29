import type { AuthUser } from './auth'

export interface DashboardResponse {
  phase: 1
  status: 'ready'
  user: AuthUser
}
