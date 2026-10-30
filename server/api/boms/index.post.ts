import { bomInputSchema } from '../../../shared/schemas/planning'
import { saveBom, planningMutationHandler } from '../../services/planning'

export default planningMutationHandler(bomInputSchema, saveBom, 'materials:manage')
