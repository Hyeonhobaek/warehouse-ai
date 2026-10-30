import { issuePreviewQuerySchema } from '../../../shared/schemas/transactions'
import { previewIssue, transactionListHandler } from '../../services/transactions'

export default transactionListHandler(issuePreviewQuerySchema, previewIssue)
