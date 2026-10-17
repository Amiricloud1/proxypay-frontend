import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { TableVirtuoso, type TableVirtuosoHandle } from 'react-virtuoso'
import { useTransactionStore } from '../stores/transactionStore'
import { trackFeatureFlagEvaluation, useFeatureFlagStore } from '../stores/featureFlagStore'
import { Transaction } from '../services/api'
import { TransactionTableSkeleton } from './TransactionTableSkeleton'
import { TransactionSearch, matchesSearch, HighlightMatch } from './TransactionSearch'
import { DateRangePicker, DateRange, matchesDateRange } from './DateRangePicker'
import { StatusFilter, TransactionStatus, matchesStatus } from './StatusFilter'
import '../styles/TransactionsTable.css'

interface SortState {
  column: keyof Transaction | null
  direction: 'asc' | 'desc'
}

interface PreviewState {
  transaction: Transaction
  position: TransactionPreviewPosition
}

const VirtualizedTable = React.forwardRef<
  HTMLTableElement,
  React.ComponentProps<'table'>
>(({ style, ...props }, ref) => (
  <table
    {...props}
    ref={ref}
    className="transactions-table"
    style={{ ...style, borderCollapse: 'separate', borderSpacing: 0 }}
  />
))

VirtualizedTable.displayName = 'VirtualizedTable'

const virtuosoComponents = { Table: VirtualizedTable }

const previewForRow = (
  row: HTMLTableRowElement
): TransactionPreviewPosition => {
  const rect = row.getBoundingClientRect()
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight
  const previewWidth = Math.min(310, Math.max(240, viewportWidth - 32))
  const left = Math.min(
    Math.max(8, rect.left),
    Math.max(8, viewportWidth - previewWidth - 8)
  )
  const estimatedHeight = 250
  const below = rect.bottom + 8
  const top =
    below + estimatedHeight > viewportHeight
      ? Math.max(8, rect.top - estimatedHeight - 8)
      : below

  return { top, left }
}

export const TransactionsTable: React.FC<{
  onRowClick: (tx: Transaction) => void
}> = ({ onRowClick }) => {
  const { transactions, loading, error, fetchTransactions } = useTransactionStore()

  const [sort, setSort] = useState<SortState>({ column: null, direction: 'asc' })
  const [preview, setPreview] = useState<PreviewState | null>(null)
  /** #495 — Multi-select provider filter state (persisted in component state) */
  const [selectedProviders, setSelectedProviders] = useState<Provider[]>([])
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTriggered = useRef(false)
  const skipInitialFetch = useRef(!loadOnMount)

  // ── Filter state ────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [dateRange, setDateRange] = useState<DateRange>({
    preset: 'all',
    startDate: '',
    endDate: '',
  })
  const [selectedStatuses, setSelectedStatuses] = useState<TransactionStatus[]>([])

  // ── Fetch on mount — pass empty filters so store defaults are preserved ─────
  // App.tsx also calls fetchTransactions; we avoid a double fetch by relying on
  // the store's loading flag.  If the store already has data, skip the call.
  useEffect(() => {
    if (transactions.length === 0) {
      fetchTransactions({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchTransactions])

  // ── Sorting ─────────────────────────────────────────────────────────────────
  const handleSort = (column: keyof Transaction) => {
    setSort((prev) => ({
      column,
      direction:
        prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  // ── Filter callbacks (stable references via useCallback) ────────────────────
  // #724 — Any meaningful filter change resets pagination to the first page so
  // the table never stays on an offset that no longer has results.
  const handleSearch = useCallback((query: string) => {
    setSearchQuery((prev) => {
      if (prev !== query) resetPagination()
      return query
    })
  }, [resetPagination])

  const handleDateRange = useCallback((range: DateRange) => {
    setDateRange((prev) => {
      if (
        prev.preset !== range.preset ||
        prev.startDate !== range.startDate ||
        prev.endDate !== range.endDate
      ) {
        resetPagination()
      }
      return range
    })
  }, [resetPagination])

  const handleStatusChange = useCallback((statuses: TransactionStatus[]) => {
    setSelectedStatuses((prev) => {
      const changed =
        prev.length !== statuses.length ||
        prev.some((status, i) => status !== statuses[i])
      if (changed) resetPagination()
      return statuses
    })
  }, [resetPagination])

  const handleProvidersChange = useCallback((providers: Provider[]) => {
    setSelectedProviders((prev) => {
      const changed =
        prev.length !== providers.length ||
        prev.some((provider, i) => provider !== providers[i])
      if (changed) resetPagination()
      return providers
    })
  }, [resetPagination])

  // ── Composed filtering + sorting (AND logic) ─────────────────────────────────
  const filteredAndSorted = useMemo(() => {
    const filtered = (transactions ?? []).filter(
      (tx) =>
        matchesSearch(tx, searchQuery) &&
        matchesDateRange(tx, dateRange) &&
        matchesStatus(tx, selectedStatuses)
    )

    if (!sort.column) return filtered

    return [...filtered].sort((a, b) => {
      const col = sort.column as keyof Transaction
      const aVal = a[col]
      const bVal = b[col]
      if (aVal === bVal) return 0
      const result =
        typeof aVal === 'number' && typeof bVal === 'number'
          ? aVal - bVal
          : String(aVal).localeCompare(String(bVal))
      return sort.direction === 'asc' ? result : -result
    })
  }, [transactions, searchQuery, dateRange, selectedStatuses, sort])

  const totalCount = (transactions ?? []).length

  // ── SortHeader sub-component ─────────────────────────────────────────────────
  const SortHeader: React.FC<{
    column: keyof Transaction
    label: string
  }> = ({ column, label }) => {
    const direction = sort.column === column
      ? sort.direction === 'asc' ? 'ascending' : 'descending'
      : 'none'

    return (
      <th scope="col" aria-sort={direction}>
        <button type="button" onClick={() => handleSort(column)} className="sortable-header">
          <span className="header-content">
            {label}
            {sort.column === column &&
              (sort.direction === 'asc' ? (
                <ChevronUp size={16} />
              ) : (
                <ChevronDown size={16} />
              ))}
          </span>
        </button>
      </th>
    )
  }

  const renderTableHeader = () => (
    <tr>
      <SortHeader column="reference" label="Reference" />
      <SortHeader column="amount" label="Amount" />
      <SortHeader column="status" label="Status" />
      <SortHeader column="provider" label="Provider" />
      <SortHeader column="timestamp" label="Date" />
      <th scope="col">Actions</th>
    </tr>
  )

  const rowCellHandlers = (index: number, tx: Transaction) => ({
    onClick: (event: React.MouseEvent<HTMLTableCellElement>) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('button')
      ) {
        if (longPressTriggered.current) {
          longPressTriggered.current = false
          return
        }
        hidePreview()
        onRowClick(tx)
      }
    },
    onMouseEnter: (event: React.MouseEvent<HTMLTableCellElement>) => {
      const row = event.currentTarget.closest('tr')
      if (row) schedulePreview(tx, row)
    },
    onMouseLeave: (event: React.MouseEvent<HTMLTableCellElement>) => {
      const row = event.currentTarget.closest('tr')
      if (
        !row ||
        !(event.relatedTarget instanceof Node) ||
        !row.contains(event.relatedTarget)
      ) hidePreview()
    },
    onFocus: (event: React.FocusEvent<HTMLTableCellElement>) => {
      setActiveRowIndex(index)
      const row = event.currentTarget.closest('tr')
      if (row) schedulePreview(tx, row)
    },
    onBlur: (event: React.FocusEvent<HTMLTableCellElement>) => {
      const row = event.currentTarget.closest('tr')
      if (
        !row ||
        !(event.relatedTarget instanceof Node) ||
        !row.contains(event.relatedTarget)
      ) hidePreview()
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLTableCellElement>) => handleKeyDown(event, index, tx),
    onTouchStart: (event: React.TouchEvent<HTMLTableCellElement>) => {
      const row = event.currentTarget.closest('tr')
      if (row) handleTouchStart(event, row, tx)
    },
    onTouchEnd: handleTouchEnd,
    onTouchCancel: handleTouchEnd,
    onTouchMove: handleTouchEnd,
    onContextMenu: (event: React.MouseEvent<HTMLTableCellElement>) => {
      event.preventDefault()
      hidePreview()
    },
  })

  return null
}
