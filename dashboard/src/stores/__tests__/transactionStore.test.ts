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

describe('transactionStore sorting', () => {
  const makeRow = (id: string, overrides: Record<string, unknown> = {}) =>
    ({ id, amount: 0, createdAt: '2024-01-01T00:00:00.000Z', ...overrides }) as never

  beforeEach(() => {
    useTransactionStore.setState({
      transactions: [],
      total: 0,
      loading: false,
      retrying: false,
      error: null,
      filters: { limit: 10, offset: 0 },
    })
  })

  it('keeps equal values in a deterministic order across repeated sorts', () => {
    const rows = [makeRow('txn_b', { amount: 5 }), makeRow('txn_a', { amount: 5 }), makeRow('txn_c', { amount: 5 })]
    useTransactionStore.setState({ transactions: rows, total: rows.length })

    useTransactionStore.getState().setSort('amount', 'asc')
    const first = useTransactionStore.getState().transactions.map((t) => (t as { id: string }).id)

    useTransactionStore.getState().setSort('amount', 'desc')
    useTransactionStore.getState().setSort('amount', 'asc')
    const second = useTransactionStore.getState().transactions.map((t) => (t as { id: string }).id)

    expect(first).toEqual(second)
    expect(first).toEqual(['txn_a', 'txn_b', 'txn_c'])
  })

  it('places missing values last regardless of sort direction', () => {
    const rows = [
      makeRow('txn_missing', { amount: null }),
      makeRow('txn_low', { amount: 1 }),
      makeRow('txn_high', { amount: 9 }),
    ]
    useTransactionStore.setState({ transactions: rows, total: rows.length })

    useTransactionStore.getState().setSort('amount', 'asc')
    expect(useTransactionStore.getState().transactions.map((t) => (t as { id: string }).id)).toEqual([
      'txn_low',
      'txn_high',
      'txn_missing',
    ])

    useTransactionStore.getState().setSort('amount', 'desc')
    expect(useTransactionStore.getState().transactions.map((t) => (t as { id: string }).id)).toEqual([
      'txn_high',
      'txn_low',
      'txn_missing',
    ])
  })

  it('sorts numeric values numerically rather than lexically', () => {
    const rows = [makeRow('txn_10', { amount: 10 }), makeRow('txn_2', { amount: 2 }), makeRow('txn_1', { amount: 1 })]
    useTransactionStore.setState({ transactions: rows, total: rows.length })

    useTransactionStore.getState().setSort('amount', 'asc')

    expect(useTransactionStore.getState().transactions.map((t) => (t as { id: string }).id)).toEqual([
      'txn_1',
      'txn_2',
      'txn_10',
    ])
  })

  it('sorts date-like values chronologically and treats invalid dates as missing', () => {
    const rows = [
      makeRow('txn_invalid', { createdAt: 'not-a-date' }),
      makeRow('txn_late', { createdAt: '2024-03-01T00:00:00.000Z' }),
      makeRow('txn_early', { createdAt: '2024-01-01T00:00:00.000Z' }),
    ]
    useTransactionStore.setState({ transactions: rows, total: rows.length })

    useTransactionStore.getState().setSort('createdAt', 'asc')

    expect(useTransactionStore.getState().transactions.map((t) => (t as { id: string }).id)).toEqual([
      'txn_early',
      'txn_late',
      'txn_invalid',
    ])
  })
})
