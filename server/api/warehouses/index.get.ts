import { warehouseQuerySchema } from '../../../shared/schemas/inventory'
import { inventoryListHandler, listWarehouses } from '../../services/inventory'

export default inventoryListHandler(warehouseQuerySchema, listWarehouses)
