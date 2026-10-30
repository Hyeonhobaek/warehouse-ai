import { batchInputSchema } from '../../../shared/schemas/inventory'
import { inventoryCreateHandler, createBatch } from '../../services/inventory'

export default inventoryCreateHandler(batchInputSchema, createBatch)
