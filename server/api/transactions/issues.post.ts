import { issueInputSchema } from '../../../shared/schemas/transactions'
import { issueStock, transactionMutationHandler } from '../../services/transactions'

export default transactionMutationHandler(issueInputSchema, issueStock)
