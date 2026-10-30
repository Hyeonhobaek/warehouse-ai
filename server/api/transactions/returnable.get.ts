import { returnableQuerySchema } from '../../../shared/schemas/transactions'
import { listReturnableLines, transactionListHandler } from '../../services/transactions'

export default transactionListHandler(returnableQuerySchema, listReturnableLines)
