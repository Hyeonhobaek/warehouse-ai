import { returnInputSchema } from '../../../../shared/schemas/transactions'
import { returnStock, transactionMutationHandler } from '../../../services/transactions'

export default transactionMutationHandler(returnInputSchema, returnStock)
