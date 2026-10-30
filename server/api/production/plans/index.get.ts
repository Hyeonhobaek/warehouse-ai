import { planQuerySchema } from '../../../../shared/schemas/planning'
import { listIssuePlans } from '../../../services/planning'
import { transactionListHandler } from '../../../services/transactions'

export default transactionListHandler(planQuerySchema, listIssuePlans)
