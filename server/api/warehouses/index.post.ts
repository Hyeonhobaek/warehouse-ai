import { warehouseInputSchema } from '../../../shared/schemas/inventory'
import { inventoryCreateHandler, createWarehouse } from '../../services/inventory'

export default inventoryCreateHandler(warehouseInputSchema, createWarehouse)
