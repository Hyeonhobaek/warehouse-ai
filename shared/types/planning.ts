import type { StockUnit } from './inventory'
import type { IssuePurpose } from './transactions'

export interface BomComponent {
  material_id: string
  quantity: string
  unit: StockUnit
  issue_purpose: IssuePurpose
}

export interface BomRecipe {
  id: string
  code: string
  name: string
  product_name: string
  is_active: boolean
  revision: number
  components: BomComponent[]
  created_at: string
  updated_at: string
}

export interface ProductionSchedule {
  id: string
  code: string
  bom_id: string
  scheduled_on: string
  multiplier: number
  production_batch: string
  notes: string
  status: 'ACTIVE' | 'CANCELLED'
  revision: number
  bom_revision: number
  created_at: string
  updated_at: string
}

export interface IssuePlan {
  id: string
  schedule_id: string
  material_id: string
  quantity: number
  unit: StockUnit
  issue_purpose: IssuePurpose
  planned_on: string
  status: 'PLANNED' | 'ISSUED' | 'CANCELLED'
  revision: number
  bom_revision: number
  production_item: string
  production_batch: string
  stock_operation_id: string | null
  created_at: string
  updated_at: string
}

export interface ScheduleRow extends ProductionSchedule {
  bom_code: string
  bom_name: string
  product_name: string
  search_text: string
}

export interface IssuePlanRow extends IssuePlan {
  material_code: string
  material_name: string
  base_unit: StockUnit
  schedule_code: string
  search_text: string
}

export interface ScheduleResult {
  schedule: ProductionSchedule
  plans: IssuePlan[]
}
