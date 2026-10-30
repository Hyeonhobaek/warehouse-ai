import { describe, expect, it } from 'vitest'
import { inventoryDate } from '../app/composables/useInventoryUi'

describe('inventory date display uses the database calendar', () => {
  it('preserves a date-only expiry value without timezone shifts', () => {
    expect(inventoryDate('2026-10-30')).toBe('2026.10.30')
  })
  it('displays the Seoul date when UTC is still the previous day', () => {
    expect(inventoryDate('2026-10-29T18:00:00.000Z')).toBe('2026.10.30')
    expect(inventoryDate('2026-10-29T14:59:59.000Z')).toBe('2026.10.29')
  })
  it('does not display unknown or invalid dates as real dates', () => {
    expect(inventoryDate(null)).toBe('—')
    expect(inventoryDate('invalid')).toBe('—')
  })
})
