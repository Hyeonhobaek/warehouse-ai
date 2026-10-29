import { defineEventHandler } from 'h3'
import type { AuthSessionResponse } from '../../../shared/types/auth'
import { getAuthenticatedUser } from '../../services/auth'
import { getSupabaseConfiguration } from '../../utils/supabase'

export default defineEventHandler(async (event): Promise<AuthSessionResponse> => {
  const { configured } = getSupabaseConfiguration(event)

  return {
    configured,
    user: configured ? await getAuthenticatedUser(event) : null,
  }
})
