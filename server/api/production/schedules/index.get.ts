import { scheduleQuerySchema } from '../../../../shared/schemas/planning'
import { listSchedules } from '../../../services/planning'
import { transactionListHandler } from '../../../services/transactions'

export default transactionListHandler(scheduleQuerySchema, listSchedules)
