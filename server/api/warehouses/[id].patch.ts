import { warehouseInputSchema } from '../../../shared/schemas/inventory'
import { inventoryUpdateHandler, updateWarehouse } from '../../services/inventory'

export default inventoryUpdateHandler(warehouseInputSchema, updateWarehouse)
