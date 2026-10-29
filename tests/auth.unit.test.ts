import { describe, expect, it } from 'vitest'
import { loginSchema } from '../shared/schemas/auth'
import { hasPermission } from '../shared/utils/permissions'

describe('login validation', () => {
  it('normalizes email whitespace without changing the password', () => {
    expect(loginSchema.parse({ email: ' viewer@example.test ', password: ' password ' })).toEqual({
      email: 'viewer@example.test', password: ' password ',
    })
  })

  it.each([
    { email: 'invalid-email', password: 'password' },
    { email: 'viewer@example.test', password: '' },
    { email: 'viewer@example.test', password: 'password', role: 'admin' },
  ])('rejects malformed credentials or extra privilege claims', (input) => {
    expect(loginSchema.safeParse(input).success).toBe(false)
  })
})

describe('role capabilities', () => {
  it('limits viewers to read capabilities', () => {
    expect(hasPermission('viewer', 'dashboard:read')).toBe(true)
    expect(hasPermission('viewer', 'inventory:read')).toBe(true)
    expect(hasPermission('viewer', 'inventory:write')).toBe(false)
    expect(hasPermission('viewer', 'materials:manage')).toBe(false)
    expect(hasPermission('viewer', 'users:manage')).toBe(false)
  })

  it('allows operators to handle transactions without granting administration', () => {
    expect(hasPermission('operator', 'inventory:write')).toBe(true)
    expect(hasPermission('operator', 'materials:manage')).toBe(false)
    expect(hasPermission('operator', 'users:manage')).toBe(false)
  })

  it('allows admins to manage users and materials', () => {
    expect(hasPermission('admin', 'materials:manage')).toBe(true)
    expect(hasPermission('admin', 'users:manage')).toBe(true)
  })
})
