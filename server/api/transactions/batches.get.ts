import { transactionBatchQuerySchema } from '../../../shared/schemas/transactions'
import { listTransactionBatches, transactionListHandler } from '../../services/transactions'

export default transactionListHandler(transactionBatchQuerySchema, listTransactionBatches)
