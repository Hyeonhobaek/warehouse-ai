import { receiptInputSchema } from '../../../shared/schemas/transactions'
import { receiveStock, transactionMutationHandler } from '../../services/transactions'

export default transactionMutationHandler(receiptInputSchema, receiveStock)
