import { materialQuerySchema } from '../../../shared/schemas/inventory'
import { inventoryExportHandler, listMaterials, materialCsvColumns } from '../../services/inventory'

export default inventoryExportHandler(materialQuerySchema, listMaterials, materialCsvColumns, 'materials')
