import { summaryQuerySchema } from '../../../shared/schemas/inventory'
import { inventoryListHandler, listMaterialStockSummary } from '../../services/inventory'

export default inventoryListHandler(summaryQuerySchema, listMaterialStockSummary)
