import { lotInputSchema } from '../../../shared/schemas/inventory'
import { inventoryCreateHandler, createLot } from '../../services/inventory'

export default inventoryCreateHandler(lotInputSchema, createLot)
