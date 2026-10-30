import { transactionQuerySchema } from '../../../shared/schemas/transactions'
import { listTransactions, transactionListHandler } from '../../services/transactions'

export default transactionListHandler(transactionQuerySchema, listTransactions)
