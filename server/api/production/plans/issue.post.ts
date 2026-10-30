import { planIssueInputSchema } from '../../../../shared/schemas/planning'
import { issuePlan, planningMutationHandler } from '../../../services/planning'

export default planningMutationHandler(planIssueInputSchema, issuePlan)
