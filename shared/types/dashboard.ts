import type { AuthUser } from './auth'

export interface DashboardResponse {
  phase: 2
  status: 'ready'
  user: AuthUser
}
