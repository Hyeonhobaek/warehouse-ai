import type { UserRole } from '../types/auth'

export const permissionLabels = {
  'dashboard:read': '대시보드 조회',
  'inventory:read': '재고 조회',
  'inventory:write': '입출고 처리',
  'materials:manage': '원료 마스터 관리',
  'users:manage': '사용자 관리',
} as const

export type Permission = keyof typeof permissionLabels

// These are role capabilities, not a declaration that later-phase features are implemented.
export const rolePermissions: Record<UserRole, readonly Permission[]> = {
  viewer: ['dashboard:read', 'inventory:read'],
  operator: ['dashboard:read', 'inventory:read', 'inventory:write'],
  admin: ['dashboard:read', 'inventory:read', 'inventory:write', 'materials:manage', 'users:manage'],
}

export const roleLabels: Record<UserRole, string> = {
  viewer: 'Viewer',
  operator: 'Operator',
  admin: 'Admin',
}

export const roleDescriptions: Record<UserRole, string> = {
  viewer: '조회 담당자',
  operator: '입출고 담당자',
  admin: '관리자',
}

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return rolePermissions[role]?.includes(permission) ?? false
}
