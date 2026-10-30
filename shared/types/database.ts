import type { UserRole } from './auth'
import type {
  Material, MaterialLot, StockBatch, QualityHistory, Warehouse, StorageLocation,
  StockBalance, InventoryRow, MaterialStockSummary, StockUnit, QualityStatus,
  MaterialInput, LotInput, BatchInput, WarehouseInput, LocationInput,
} from './inventory'

type DatabaseRow<Row> = { [Key in keyof Row]: Row[Key] }

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
    }
    Views: {
      inventory_rows: { Row: DatabaseRow<InventoryRow>; Relationships: [] }
      material_stock_summary: { Row: DatabaseRow<MaterialStockSummary>; Relationships: [] }
    }
    Functions: Record<never, never>
    Enums: { app_role: UserRole; stock_unit: StockUnit; quality_status: QualityStatus }
    CompositeTypes: Record<never, never>
  }
}
