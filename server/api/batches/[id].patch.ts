import { batchInputSchema } from '../../../shared/schemas/inventory'
import { inventoryUpdateHandler, updateBatch } from '../../services/inventory'

export default inventoryUpdateHandler(batchInputSchema, updateBatch)
