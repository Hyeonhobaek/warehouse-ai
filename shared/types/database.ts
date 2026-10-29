import type { UserRole } from './auth'

export type ProfileRow = {
  id: string
  display_name: string
  role: UserRole
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Keep aligned with supabase/migrations; replace with generated types as the schema grows. */
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow
        Insert: {
          id: string
          display_name: string
          role?: UserRole
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: Partial<ProfileRow>
        Relationships: []
      }
    }
    Views: Record<never, never>
    Functions: Record<never, never>
    Enums: { app_role: UserRole }
    CompositeTypes: Record<never, never>
  }
}
