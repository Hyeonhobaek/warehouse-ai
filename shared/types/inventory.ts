export const stockUnits = ['kg', 'g', 'L', 'mL', 'EA'] as const
export type StockUnit = typeof stockUnits[number]
export const qualityStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'HOLD'] as const
export type QualityStatus = typeof qualityStatuses[number]
export type EffectiveQualityStatus = QualityStatus | 'EXPIRED'
export const availabilityReasonLabels = {
  MATERIAL_INACTIVE: '사용 중지 원료',
  WAREHOUSE_INACTIVE: '운영 중지 창고',
  LOCATION_INACTIVE: '사용 중지 위치',
  QUALITY_NOT_APPROVED: '적합 판정 필요',
  EXPIRY_UNKNOWN: '유효기간 확인 필요',
  EXPIRED: '유효기간 경과',
} as const
export type AvailabilityReason = keyof typeof availabilityReasonLabels

export const qualityLabels: Record<EffectiveQualityStatus, string> = {
  PENDING: '시험대기', APPROVED: '적합', REJECTED: '부적합', HOLD: '사용보류', EXPIRED: '기한 경과',
}

export interface Material {
  id: string
  code: string
  name: string
  aliases: string[]
  specification: string
  manufacturer: string
  base_unit: StockUnit
  min_stock: number
  storage_condition: string
  package_size: number | null
  package_unit: StockUnit | null
  density: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface MaterialLot {
  id: string
  material_id: string
  lot_number: string
  manufacturer: string
  manufactured_on: string | null
  notes: string
  created_at: string
  updated_at: string
}

/** A physical receipt cohort. Retesting updates its QC history, never its balance. */
export interface StockBatch {
  id: string
  lot_id: string
  receipt_reference: string
  received_on: string
  expires_on: string | null
  retest_on: string | null
  test_number: string
  quality_status: QualityStatus
  decision_on: string | null
  quality_reason: string
  notes: string
  created_at: string
  updated_at: string
}

export interface QualityHistory {
  id: string
  batch_id: string
  test_number: string
  quality_status: QualityStatus
  decision_on: string | null
  expires_on: string | null
  retest_on: string | null
  reason: string
  actor_id: string | null
  created_at: string
}

export interface Warehouse {
  id: string
  code: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface StorageLocation {
  id: string
  warehouse_id: string
  code: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface StockBalance {
  id: string
  batch_id: string
  location_id: string
  on_hand: number
  reserved: number
  updated_at: string
}

export interface InventoryRow {
  id: string
  material_id: string
  material_code: string
  material_name: string
  base_unit: StockUnit
  min_stock: number
  material_active: boolean
  lot_id: string
  lot_number: string
  manufacturer: string
  batch_id: string
  receipt_reference: string
  received_on: string
  expires_on: string | null
  retest_on: string | null
  test_number: string
  quality_status: QualityStatus
  effective_status: EffectiveQualityStatus
  availability_reason: AvailabilityReason | null
  warehouse_id: string
  warehouse_code: string
  warehouse_name: string
  location_id: string
  location_code: string
  location_name: string
  on_hand: number
  reserved: number
  available: number
  unavailable: number
  material_available: number
  is_low_stock: boolean
  retest_due: boolean
  expiry_due: boolean
  search_text: string
}

export interface MaterialStockSummary {
  material_id: string
  material_code: string
  material_name: string
  base_unit: StockUnit
  min_stock: number
  is_active: boolean
  on_hand: number
  reserved: number
  available: number
  unavailable: number
  lot_count: number
  batch_count: number
  is_low_stock: boolean
  search_text: string
}

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface InventoryResponse extends Paginated<InventoryRow> {
  asOf: string
}

export type MaterialInput = Omit<Material, 'id' | 'created_at' | 'updated_at'>
export type LotInput = Omit<MaterialLot, 'id' | 'created_at' | 'updated_at'>
export type BatchInput = Omit<StockBatch, 'id' | 'created_at' | 'updated_at'>
export type WarehouseInput = Omit<Warehouse, 'id' | 'created_at' | 'updated_at'>
export type LocationInput = Omit<StorageLocation, 'id' | 'created_at' | 'updated_at'>
