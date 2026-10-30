import { pendingReturnQuerySchema } from '../../../../shared/schemas/transactions'
import { listPendingReturns, transactionListHandler } from '../../../services/transactions'

export default transactionListHandler(pendingReturnQuerySchema, listPendingReturns)
