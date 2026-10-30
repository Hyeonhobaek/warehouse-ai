import { bomQuerySchema } from '../../../shared/schemas/planning'
import { listBoms } from '../../services/planning'
import { transactionListHandler } from '../../services/transactions'

export default transactionListHandler(bomQuerySchema, listBoms)
