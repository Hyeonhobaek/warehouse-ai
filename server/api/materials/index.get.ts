import { materialQuerySchema } from '../../../shared/schemas/inventory'
import { inventoryListHandler, listMaterials } from '../../services/inventory'

export default inventoryListHandler(materialQuerySchema, listMaterials)
