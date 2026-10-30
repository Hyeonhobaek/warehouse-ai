import { materialInputSchema } from '../../../shared/schemas/inventory'
import { inventoryUpdateHandler, updateMaterial } from '../../services/inventory'

export default inventoryUpdateHandler(materialInputSchema, updateMaterial)
