import { locationQuerySchema } from '../../../shared/schemas/inventory'
import { inventoryListHandler, listLocations } from '../../services/inventory'

export default inventoryListHandler(locationQuerySchema, listLocations)
