import type { QualityStatus, StockUnit } from './inventory'

export const transactionKinds = ['RECEIPT', 'ISSUE', 'RETURN', 'RETURN_RELEASE'] as const
export type TransactionKind = typeof transactionKinds[number]
export const issuePurposes = ['GENERAL', 'CLEANING'] as const
export type IssuePurpose = typeof issuePurposes[number]
export const transactionTypes = transactionKinds
export type TransactionType = typeof transactionTypes[number]

export const transactionLabels: Record<TransactionType, string> = {
  RECEIPT: '입고', ISSUE: '불출', RETURN: '반납 · 보류', RETURN_RELEASE: '반납 보류 해제',
}

/** Immutable operation header. Quantities are converted by PostgreSQL, not the client. */
export interface StockOperation {
  id: string
  request_key: string
  kind: TransactionKind
  issue_purpose: IssuePurpose
  material_id: string
  occurred_on: string
  input_quantity: number
  input_unit: StockUnit
  quantity: number
  base_unit: StockUnit
  density_snapshot: number | null
  production_item: string
  production_batch: string
  reason: string
  notes: string
  actor_id: string
  actor_name: string
  created_at: string
}

export interface StockTransactionLine {
  id: string
  operation_id: string
  sequence: number
  batch_id: string
  location_id: string
  source_line_id: string | null
  quantity: number
  delta: number
  on_hand_before: number
  on_hand_after: number
  held_before: number
  held_after: number
  test_number_snapshot: string
  lot_number_snapshot: string
  received_on_snapshot: string
  location_code_snapshot: string
  warehouse_code_snapshot: string
}

export interface TransactionResult {
  operation: StockOperation
  lines: StockTransactionLine[]
}

/** Actual transactions only: imported balances do not invent earlier movement history. */
export interface StockLedgerRow extends StockTransactionLine, Omit<StockOperation, 'id' | 'quantity'> {
  material_code: string
  material_name: string
  current_test_number: string
  returnable_quantity: number
  releasable_quantity: number
  search_text: string
}

export interface TransactionBatch {
  batch_id: string
  material_id: string
  material_code: string
  material_name: string
  lot_number: string
  test_number: string
  received_on: string
  receipt_reference: string
  base_unit: StockUnit
  quality_status: QualityStatus
  on_hand: number
  held: number
  available: number
  search_text: string
}

export interface IssuePreviewLine {
  batch_id: string
  location_id: string
  test_number: string
  lot_number: string
  received_on: string
  location_code: string
  warehouse_code: string
  available: number
  quantity: number
}

export interface IssuePreview {
  material_id: string
  base_unit: StockUnit
  quantity: number
  density_snapshot: number | null
  available: number
  shortage: number
  sufficient: boolean
  issue_purpose: IssuePurpose
  input_quantity: number
  input_unit: StockUnit
  block_liters: number | null
  raw_available?: number
  lines: IssuePreviewLine[]
}
