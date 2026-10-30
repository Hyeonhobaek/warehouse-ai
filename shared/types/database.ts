import type { UserRole } from './auth'
import type {
  Material, MaterialLot, StockBatch, QualityHistory, Warehouse, StorageLocation,
  StockBalance, InventoryRow, MaterialStockSummary, StockUnit, QualityStatus,
  MaterialInput, LotInput, BatchInput, WarehouseInput, LocationInput,
} from './inventory'
import type { IssuePreview, StockLedgerRow, StockOperation, StockTransactionLine, TransactionBatch, TransactionKind, TransactionResult } from './transactions'
import type { IssueInput, IssuePreviewQuery, ReceiptInput, ReleaseReturnInput, ReturnInput } from '../schemas/transactions'
import type { BomRecipe, IssuePlan, IssuePlanRow, ProductionSchedule, ScheduleResult, ScheduleRow } from './planning'
import type { BomInput, PlanIssueInput, ScheduleInput } from '../schemas/planning'

type DatabaseRow<Row> = { [Key in keyof Row]: Row[Key] }
type ReadOnlyTable<Row> = { Row: DatabaseRow<Row>; Insert: never; Update: never; Relationships: [] }

type MetadataTable<Row, Input> = {
  Row: DatabaseRow<Row>
  Insert: Input & { id?: string; created_at?: string; updated_at?: string }
  Update: Partial<Input>
  Relationships: []
}

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
      bom_recipes: ReadOnlyTable<BomRecipe & { search_text: string }>
      production_schedules: ReadOnlyTable<ProductionSchedule>
      stock_issue_plans: ReadOnlyTable<IssuePlan>
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
      materials: MetadataTable<Material & { search_text: string }, MaterialInput>
      material_lots: MetadataTable<MaterialLot, LotInput>
      stock_batches: MetadataTable<StockBatch, BatchInput>
      warehouses: MetadataTable<Warehouse, WarehouseInput>
      storage_locations: MetadataTable<StorageLocation, LocationInput>
      stock_balances: {
        Row: DatabaseRow<StockBalance>
        Insert: never
        Update: never
        Relationships: []
      }
      stock_batch_quality_history: {
        Row: DatabaseRow<QualityHistory>
        Insert: never
        Update: never
        Relationships: []
      }
      stock_operations: {
        Row: DatabaseRow<StockOperation> & { request_payload: unknown }
        Insert: never
        Update: never
        Relationships: []
      }
      stock_transaction_lines: {
        Row: DatabaseRow<StockTransactionLine>
        Insert: never
        Update: never
        Relationships: []
      }
    }
    Views: {
      schedule_rows: { Row: DatabaseRow<ScheduleRow>; Relationships: [] }
      issue_plan_rows: { Row: DatabaseRow<IssuePlanRow>; Relationships: [] }
      inventory_rows: { Row: DatabaseRow<InventoryRow>; Relationships: [] }
      material_stock_summary: { Row: DatabaseRow<MaterialStockSummary>; Relationships: [] }
      stock_ledger_rows: { Row: DatabaseRow<StockLedgerRow>; Relationships: [] }
      stock_batch_options: { Row: DatabaseRow<TransactionBatch>; Relationships: [] }
    }
    Functions: {
      planning_save_bom: { Args: { p_input: BomInput }; Returns: BomRecipe }
      planning_save_schedule: { Args: { p_input: ScheduleInput }; Returns: ScheduleResult }
      planning_issue_plan: { Args: { p_input: PlanIssueInput }; Returns: TransactionResult }
      stock_receive: { Args: { p_input: ReceiptInput }; Returns: TransactionResult }
      stock_issue: { Args: { p_input: IssueInput }; Returns: TransactionResult }
      stock_return: { Args: { p_input: ReturnInput }; Returns: TransactionResult }
      stock_release_return: { Args: { p_input: ReleaseReturnInput }; Returns: TransactionResult }
      stock_preview_issue: { Args: { p_input: IssuePreviewQuery }; Returns: IssuePreview }
    }
    Enums: { app_role: UserRole; stock_unit: StockUnit; quality_status: QualityStatus; stock_operation_kind: TransactionKind }
    CompositeTypes: Record<never, never>
  }
}
