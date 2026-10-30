import { inventoryQuerySchema } from '../../../shared/schemas/inventory'
import { inventoryListHandler, listInventory } from '../../services/inventory'

export default inventoryListHandler(inventoryQuerySchema, listInventory)
