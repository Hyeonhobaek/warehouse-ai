import { scheduleInputSchema } from '../../../../shared/schemas/planning'
import { saveSchedule, planningMutationHandler } from '../../../services/planning'

export default planningMutationHandler(scheduleInputSchema, saveSchedule)
