import { locationInputSchema } from '../../../shared/schemas/inventory'
import { inventoryCreateHandler, createLocation } from '../../services/inventory'

export default inventoryCreateHandler(locationInputSchema, createLocation)
