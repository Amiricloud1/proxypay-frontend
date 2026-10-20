import { create } from 'zustand'
import { Transaction, TransactionFilters, proxyPayAPI } from '../services/api'
import { showRetryToast } from '../components/RetryToast'

interface TransactionStore {
  transactions: Transaction[]
  selectedTransaction: Transaction | null
  loading: boolean
  detailLoading: boolean
  error: string | null
  detailError: string | null
  total: number
  filters: TransactionFilters
  
  // Actions
  fetchTransactions: (filters: TransactionFilters) => Promise<void>
  fetchTransactionDetail: (id: string) => Promise<void>
  setSelectedTransaction: (tx: Transaction | null) => void
  setFilters: (filters: Partial<TransactionFilters>) => void
  resetFilters: () => void
  clearError: () => void
}

const defaultFilters: TransactionFilters = {
  limit: 50,
  offset: 0,
}

let latestDetailRequest = 0
let latestListRequest = 0

export const useTransactionStore = create<TransactionStore>((set) => ({
  transactions: [],
  selectedTransaction: null,
  loading: false,
  detailLoading: false,
  error: null,
  detailError: null,
  total: 0,
  filters: defaultFilters,

  fetchTransactions: async (filters: TransactionFilters) => {
    const requestId = ++latestListRequest
    set({ loading: true, error: null })
    try {
      const result = await proxyPayAPI.getTransactions(filters)
      if (requestId !== latestListRequest) return
      set({
        transactions: result.data,
        total: result.total,
        filters,
        loading: false,
      })
    } catch (error) {
      if (requestId !== latestListRequest) return
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to fetch transactions'
      set({ error: errorMessage, loading: false })

      // Issue #600 — show error toast with retry button
      showRetryToast({
        message: 'Failed to load transactions.',
        label: 'GET /transactions',
        onRetry: () => proxyPayAPI.getTransactions(filters),
        onSuccess: (result) => {
          set({
            transactions: result.data,
            total: result.total,
            filters,
            loading: false,
            error: null,
          })
        },
      })
    }
  },

  fetchTransactionDetail: async (id: string) => {
    const requestId = ++latestDetailRequest
    set({ detailLoading: true, detailError: null })
    try {
      const transaction = await proxyPayAPI.getTransactionDetail(id)
      let statusHistory = transaction.statusHistory || []
      if (statusHistory.length === 0) {
        try {
          statusHistory = await proxyPayAPI.getStatusHistory(id)
        } catch {
          statusHistory = transaction.statusHistory || []
        }
      }
      if (requestId !== latestDetailRequest) return
      set({
        selectedTransaction: { ...transaction, statusHistory },
        detailLoading: false,
      })
    } catch (error) {
      if (requestId !== latestDetailRequest) return
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to fetch transaction details'
      set({ detailError: errorMessage, detailLoading: false })

      // Issue #600 — retry button for detail fetch failures
      showRetryToast({
        message: 'Failed to load transaction details.',
        label: `GET /transactions/${id}`,
        onRetry: () => proxyPayAPI.getTransactionDetail(id),
        onSuccess: (transaction) => {
          set({ selectedTransaction: transaction, detailLoading: false, detailError: null })
        },
      })
    }
  },

  setSelectedTransaction: (tx: Transaction | null) => {
    latestDetailRequest += 1
    set({ selectedTransaction: tx, detailError: null })
  },

  setFilters: (newFilters: Partial<TransactionFilters>) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters, offset: newFilters.offset ?? 0 },
    }))
  },

  resetFilters: () => {
    set({ filters: defaultFilters })
  },

  clearError: () => {
    set({ error: null })
  },
}))
