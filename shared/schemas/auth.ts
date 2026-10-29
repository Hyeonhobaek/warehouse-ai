import { z } from 'zod'

// Login validates an existing password; password creation policy belongs to Supabase Auth.
export const loginSchema = z.object({
  email: z.string().trim().email('올바른 이메일 주소를 입력해 주세요.').max(254),
  password: z.string().min(1, '비밀번호를 입력해 주세요.').max(1024, '비밀번호가 너무 깁니다.'),
}).strict()

export type LoginInput = z.infer<typeof loginSchema>
