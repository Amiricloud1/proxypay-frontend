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
import { TransactionRowPreview } from './TransactionRowPreview'
import { usePreviewState } from '../hooks/usePreviewState'
import '../styles/TransactionsTable.css'

interface SortState {
  column: keyof Transaction | null
  direction: 'asc' | 'desc'
}

interface TransactionPreviewPosition {
  top: number
  left: number
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
  const [activeRowIndex, setActiveRowIndex] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTriggered = useRef(false)
  const virtuosoRef = useRef<TableVirtuosoHandle>(null)
  const pendingFocusIndex = useRef<number | null>(null)
  const previewContainerRef = useRef<HTMLDivElement>(null)

  // ── Filter state ────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [dateRange, setDateRange] = useState<DateRange>({
    preset: 'all',
    startDate: '',
    endDate: '',
  })
  const [selectedStatuses, setSelectedStatuses] = useState<TransactionStatus[]>([])

  // ── Fetch on mount — pass empty filters so store defaults are preserved ─────
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
  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query)
  }, [])

  const handleDateRange = useCallback((range: DateRange) => {
    setDateRange(range)
  }, [])

  const handleStatusChange = useCallback((statuses: TransactionStatus[]) => {
    setSelectedStatuses(statuses)
  }, [])

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

  // ── Preview management ────────────────────────────────────────────────────────

  const schedulePreview = useCallback((tx: Transaction, row: HTMLTableRowElement) => {
    // Clear any existing preview timer
    if (previewTimer.current) clearTimeout(previewTimer.current)

    previewTimer.current = setTimeout(() => {
      const position = previewForRow(row)
      setPreview({ transaction: tx, position })
    }, 200) // PREVIEW_DELAY_MS
  }, [])

  const hidePreview = useCallback(() => {
    if (previewTimer.current) {
      clearTimeout(previewTimer.current)
      previewTimer.current = null
    }
    setPreview(null)
  }, [])

  // ── Touch long-press handling ────────────────────────────────────────────────

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLTableRowElement> | React.TouchEvent<HTMLTableCellElement>, 
     row: HTMLTableRowElement, 
     tx: Transaction) => {
      if (touchTimer.current) clearTimeout(touchTimer.current)
      longPressTriggered.current = false

      touchTimer.current = setTimeout(() => {
        longPressTriggered.current = true
        schedulePreview(tx, row)
        setAnnouncement(`Preview for transaction ${tx.reference} opened. Press Escape to close.`)
      }, 500) // LONG_PRESS_DELAY_MS
    },
    [schedulePreview]
  )

  const handleTouchEnd = useCallback(() => {
    if (touchTimer.current) {
      clearTimeout(touchTimer.current)
      touchTimer.current = null
    }
  }, [])

  // ── Keyboard handling ────────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLTableRowElement> | React.KeyboardEvent<HTMLTableCellElement>,
      tx?: Transaction
    ) => {
      // Escape key: dismiss preview
      if (event.key === 'Escape') {
        event.preventDefault()
        hidePreview()
        setAnnouncement('Preview closed')
        return
      }

      // Enter/Space: open row or trigger preview
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (preview?.transaction.id === tx?.id) {
          hidePreview()
          onRowClick(tx)
        } else if (tx && !preview) {
          const row = event.currentTarget as HTMLTableRowElement
          schedulePreview(tx, row)
          setAnnouncement(`Preview for transaction ${tx.reference} opened. Press Enter to open details, Escape to close.`)
        }
        return
      }

      // Arrow keys: navigate between rows
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        const direction = event.key === 'ArrowUp' ? -1 : 1
        const newIndex = Math.max(
          0,
          Math.min((activeRowIndex ?? 0) + direction, filteredAndSorted.length - 1)
        )
        setActiveRowIndex(newIndex)
        pendingFocusIndex.current = newIndex
        hidePreview()

        const targetTx = filteredAndSorted[newIndex]
        if (targetTx) {
          setAnnouncement(`Navigated to transaction ${targetTx.reference}`)
        }
        return
      }
    },
    [preview, hidePreview, onRowClick, schedulePreview, activeRowIndex, filteredAndSorted]
  )

  // ── Outside-click handler: dismiss preview when clicking outside ──────────────

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        previewContainerRef.current &&
        !previewContainerRef.current.contains(event.target as Node)
      ) {
        hidePreview()
      }
    }

    if (preview) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [preview, hidePreview])

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

  if (error) {
    return <div className="error-message">{error}</div>
  }

  if (loading && totalCount === 0) {
    return <TransactionTableSkeleton rows={5} />
  }

  return (
    <div
      className="transactions-table-container"
      ref={previewContainerRef}
      role="region"
      aria-label="Transactions table with preview"
    >
      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="filter-bar">
        <TransactionSearch
          onSearch={handleSearch}
          resultCount={filteredAndSorted.length}
          totalCount={totalCount}
        />
        <div className="filter-bar-right">
          <DateRangePicker
            transactions={transactions ?? []}
            onRangeChange={handleDateRange}
            filteredCount={filteredAndSorted.length}
          />
          <StatusFilter
            transactions={transactions ?? []}
            onStatusChange={handleStatusChange}
          />
        </div>
      </div>

      {/* ── Results summary ─────────────────────────────────────────────────── */}
      <div className="results-summary">
        <span>
          Showing{' '}
          <strong>{filteredAndSorted.length}</strong> of{' '}
          <strong>{totalCount}</strong> transaction{totalCount !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      <table className="transactions-table">
        <thead>
          <tr>
            <SortHeader column="reference" label="Reference" />
            <SortHeader column="amount" label="Amount" />
            <SortHeader column="status" label="Status" />
            <SortHeader column="provider" label="Provider" />
            <SortHeader column="timestamp" label="Date" />
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredAndSorted.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty-cell">
                {totalCount === 0
                  ? 'No transactions found'
                  : 'No transactions match the current filters'}
              </td>
            </tr>
          ) : (
            filteredAndSorted.map((tx, index) => (
              <tr
                key={tx.id}
                data-testid={`transaction-row-${tx.id}`}
                className="transaction-row"
                tabIndex={activeRowIndex === index ? 0 : -1}
                onKeyDown={(event) => handleKeyDown(event, tx)}
                onMouseEnter={(event) => schedulePreview(tx, event.currentTarget)}
                onMouseLeave={hidePreview}
                onFocus={() => {
                  setActiveRowIndex(index)
                  schedulePreview(tx, event.currentTarget as HTMLTableRowElement)
                }}
                onBlur={() => hidePreview()}
                onTouchStart={(event) => handleTouchStart(event, event.currentTarget, tx)}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
                onTouchMove={handleTouchEnd}
                onClick={() => {
                  if (longPressTriggered.current) {
                    longPressTriggered.current = false
                    return
                  }
                  hidePreview()
                  onRowClick(tx)
                }}
                aria-label={`View transaction ${tx.reference}, $${tx.amount.toFixed(
                  2
                )}, ${tx.status}, ${tx.provider}`}
                aria-describedby={
                  preview?.transaction.id === tx.id
                    ? 'transaction-row-preview'
                    : undefined
                }
              >
                <td>
                  <HighlightMatch text={tx.reference} query={searchQuery} />
                </td>
                <td className="amount">${tx.amount.toFixed(2)}</td>
                <td>
                  <span className={`status-badge status-${tx.status}`}>
                    {tx.status}
                  </span>
                </td>
                <td>
                  <HighlightMatch text={tx.provider} query={searchQuery} />
                </td>
                <td>{format(new Date(tx.timestamp), 'MMM dd, yyyy')}</td>
                <td className="action-cell">
                  <button
                    className="view-button"
                    onClick={(event) => {
                      event.stopPropagation()
                      hidePreview()
                      onRowClick(tx)
                    }}
                  >
                    View Details
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* ── Announcements for screen readers ────────────────────────────────── */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>

      {/* ── Preview popup ──────────────────────────────────────────────────── */}
      {preview && (
        <TransactionRowPreview
          transaction={preview.transaction}
          position={preview.position}
          visible
        />
      )}
    </div>
  )
}

export default TransactionsTable
