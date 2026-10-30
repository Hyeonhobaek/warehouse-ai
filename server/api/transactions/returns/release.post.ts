import { releaseReturnInputSchema } from '../../../../shared/schemas/transactions'
import { releaseReturnedStock, transactionMutationHandler } from '../../../services/transactions'

export default transactionMutationHandler(releaseReturnInputSchema, releaseReturnedStock, 'materials:manage')
