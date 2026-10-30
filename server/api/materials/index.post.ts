import { materialInputSchema } from '../../../shared/schemas/inventory'
import { inventoryCreateHandler, createMaterial } from '../../services/inventory'

export default inventoryCreateHandler(materialInputSchema, createMaterial)
