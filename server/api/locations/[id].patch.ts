import { locationInputSchema } from '../../../shared/schemas/inventory'
import { inventoryUpdateHandler, updateLocation } from '../../services/inventory'

export default inventoryUpdateHandler(locationInputSchema, updateLocation)
