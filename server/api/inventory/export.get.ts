import { inventoryQuerySchema } from '../../../shared/schemas/inventory'
import { inventoryExportHandler, listInventory, inventoryCsvColumns } from '../../services/inventory'

export default inventoryExportHandler(inventoryQuerySchema, listInventory, inventoryCsvColumns, 'inventory')
