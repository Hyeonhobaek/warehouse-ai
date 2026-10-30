import { defineEventHandler } from 'h3'
import type { DashboardResponse } from '../../shared/types/dashboard'
import { requirePermission } from '../services/auth'

export default defineEventHandler(async (event): Promise<DashboardResponse> => ({
  phase: 2,
  status: 'ready',
  user: await requirePermission(event, 'dashboard:read'),
}))
