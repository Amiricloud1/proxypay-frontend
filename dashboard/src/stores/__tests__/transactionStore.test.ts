import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/api', () => ({
  proxyPayAPI: {
    getTransactions: vi.fn(),
    getTransactionDetail: vi.fn(),
    getStatusHistory: vi.fn(),
  },
}))

import { useTransactionStore } from '../transactionStore'

describe('transactionStore pagination', () => {
  beforeEach(() => {
    useTransactionStore.setState({ filters: { limit: 2, offset: 0 } })
  })

  it('preserves an explicit offset when changing pages', () => {
    useTransactionStore.getState().setFilters({ offset: 2 })

    expect(useTransactionStore.getState().filters.offset).toBe(2)
  })

  it('resets the offset when changing a filter', () => {
    useTransactionStore.getState().setFilters({ status: 'settled' })

    expect(useTransactionStore.getState().filters).toEqual({ limit: 2, offset: 0, status: 'settled' })
  })

  it('resets the offset when changing the search filter', () => {
    useTransactionStore.setState({ filters: { limit: 2, offset: 4 } })

    useTransactionStore.getState().setFilters({ search: 'abc' })

    expect(useTransactionStore.getState().filters).toEqual({ limit: 2, offset: 0, search: 'abc' })
  })

  it('resets the offset when changing the date range filter', () => {
    useTransactionStore.setState({ filters: { limit: 2, offset: 4 } })

    useTransactionStore.getState().setFilters({ startDate: '2024-01-01', endDate: '2024-01-31' })

    expect(useTransactionStore.getState().filters).toEqual({
      limit: 2,
      offset: 0,
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    })
  })

  it('resets the offset when changing the provider filter', () => {
    useTransactionStore.setState({ filters: { limit: 2, offset: 4 } })

    useTransactionStore.getState().setFilters({ provider: 'mtn' })

    expect(useTransactionStore.getState().filters).toEqual({ limit: 2, offset: 0, provider: 'mtn' })
  })

  it('does not reset the offset when a filter value is unchanged', () => {
    useTransactionStore.setState({ filters: { limit: 2, offset: 4, status: 'settled' } })

    useTransactionStore.getState().setFilters({ status: 'settled' })

    expect(useTransactionStore.getState().filters).toEqual({ limit: 2, offset: 4, status: 'settled' })
  })

  it('does not reset the offset when only the limit changes', () => {
    useTransactionStore.setState({ filters: { limit: 2, offset: 4 } })

    useTransactionStore.getState().setFilters({ limit: 10 })

    expect(useTransactionStore.getState().filters).toEqual({ limit: 10, offset: 4 })
  })
})