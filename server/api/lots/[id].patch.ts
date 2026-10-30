import { lotInputSchema } from '../../../shared/schemas/inventory'
import { inventoryUpdateHandler, updateLot } from '../../services/inventory'

export default inventoryUpdateHandler(lotInputSchema, updateLot)
