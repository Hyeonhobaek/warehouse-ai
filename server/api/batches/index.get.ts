import { batchQuerySchema } from '../../../shared/schemas/inventory'
import { inventoryListHandler, listBatches } from '../../services/inventory'

export default inventoryListHandler(batchQuerySchema, listBatches)
