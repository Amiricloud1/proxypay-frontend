import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/api', () => ({
  proxyPayAPI: {
    getTransactions: vi.fn(),
    getTransactionDetail: vi.fn(),
    getStatusHistory: vi.fn(),
  },
}))

import { proxyPayAPI } from '../../services/api'
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

describe('transactionStore retry', () => {
  const getTransactions = vi.mocked(proxyPayAPI.getTransactions)

  beforeEach(() => {
    getTransactions.mockReset()
    useTransactionStore.setState({
      transactions: [],
      total: 0,
      loading: false,
      retrying: false,
      error: null,
      filters: { limit: 2, offset: 0, status: 'settled' },
    })
  })

  it('repeats the active filter request when retrying', async () => {
    getTransactions.mockResolvedValueOnce({ data: { transactions: [], total: 0 } })

    await useTransactionStore.getState().retry()

    expect(getTransactions).toHaveBeenCalledWith({ limit: 2, offset: 0, status: 'settled' })
  })

  it('flags retry loading separately from the initial skeleton loading', async () => {
    let resolveRequest: (value: unknown) => void = () => {}
    getTransactions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve
      }) as ReturnType<typeof proxyPayAPI.getTransactions>,
    )

    const pending = useTransactionStore.getState().retry()

    expect(useTransactionStore.getState().retrying).toBe(true)
    expect(useTransactionStore.getState().loading).toBe(false)

    resolveRequest({ data: { transactions: [], total: 0 } })
    await pending

    expect(useTransactionStore.getState().retrying).toBe(false)
  })

  it('preserves existing rows when a retry fails', async () => {
    const existing = [{ id: 'txn_1' }] as never
    useTransactionStore.setState({ transactions: existing, total: 1, error: 'boom' })
    getTransactions.mockRejectedValueOnce(new Error('still down'))

    await useTransactionStore.getState().retry()

    const state = useTransactionStore.getState()
    expect(state.transactions).toBe(existing)
    expect(state.total).toBe(1)
    expect(state.error).toBeTruthy()
    expect(state.retrying).toBe(false)
  })

  it('clears the error after a successful retry', async () => {
    useTransactionStore.setState({ error: 'boom' })
    getTransactions.mockResolvedValueOnce({ data: { transactions: [], total: 0 } })

    await useTransactionStore.getState().retry()

    expect(useTransactionStore.getState().error).toBeNull()
  })
})
