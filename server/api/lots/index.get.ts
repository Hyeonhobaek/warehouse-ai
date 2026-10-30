import { lotQuerySchema } from '../../../shared/schemas/inventory'
import { inventoryListHandler, listLots } from '../../services/inventory'

export default inventoryListHandler(lotQuerySchema, listLots)
