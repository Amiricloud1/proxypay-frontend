import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
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

/**
 * #726 — Normalized sort value. `null` marks a missing/invalid value so it can
 * be placed deterministically (always last) regardless of sort direction.
 */
type NormalizedSortValue =
  | { kind: 'number'; value: number }
  | { kind: 'date'; value: number }
  | { kind: 'string'; value: string }
  | null

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * #726 — Normalize a raw transaction field into a comparable value.
 * Numbers (and numeric strings) compare numerically, date-like strings compare
 * by timestamp, everything else compares as a lowercased string. Empty,
 * null, undefined, NaN and unparseable date-like values normalize to `null`.
 */
const normalizeSortValue = (raw: unknown): NormalizedSortValue => {
  if (raw === null || raw === undefined) return null

  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { kind: 'number', value: raw } : null
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '') return null

    if (DATE_LIKE.test(trimmed)) {
      const time = Date.parse(trimmed)
      return Number.isNaN(time) ? null : { kind: 'date', value: time }
    }

    // Numeric strings (e.g. amounts serialized as strings) sort numerically.
    const asNumber = Number(trimmed)
    if (Number.isFinite(asNumber)) {
      return { kind: 'number', value: asNumber }
    }

    return { kind: 'string', value: trimmed.toLowerCase() }
  }

  return null
}

/**
 * #726 — Compare two normalized values. Missing values always sort last,
 * independent of direction. Mixed kinds fall back to a stable string compare.
 */
const compareNormalized = (
  a: NormalizedSortValue,
  b: NormalizedSortValue
): number => {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1

  if (a.kind === b.kind) {
    if (a.kind === 'string' && b.kind === 'string') {
      return a.value.localeCompare(b.value)
    }
    if (a.kind !== 'string' && b.kind !== 'string') {
      return a.value - b.value
    }
  }

  // Mixed kinds: deterministic string comparison of the raw normalized form.
  return String(a.value).localeCompare(String(b.value))
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
  /** #725 — Tracks a retry triggered from the error state so we can show a
   *  distinct "retrying" indicator instead of the initial skeleton. */
  const [retrying, setRetrying] = useState(false)
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

  // ── #725 — Retry the active filter request ─────────────────────────────────
  const handleRetry = useCallback(async () => {
    setRetrying(true)
    try {
      await fetchTransactions({
        search: searchQuery || undefined,
        startDate: dateRange.startDate || undefined,
        endDate: dateRange.endDate || undefined,
        statuses: selectedStatuses.length ? selectedStatuses : undefined,
        providers: selectedProviders.length ? selectedProviders : undefined,
      })
    } finally {
      setRetrying(false)
    }
  }, [
    fetchTransactions,
    searchQuery,
    dateRange.startDate,
    dateRange.endDate,
    selectedStatuses,
    selectedProviders,
  ])

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

    const col = sort.column as keyof Transaction
    const direction = sort.direction === 'asc' ? 1 : -1

    // #726 — Decorate with normalized values + original index so equal values
    // tie-break on stable input order (deterministic across renders/browsers).
    return filtered
      .map((tx, index) => ({
        tx,
        index,
        value: normalizeSortValue(tx[col]),
      }))
      .sort((a, b) => {
        const result = compareNormalized(a.value, b.value)
        // Missing values always last, regardless of direction.
        if (a.value === null || b.value === null) {
          if (result !== 0) return result
        } else if (result !== 0) {
          return result * direction
        }
        return a.index - b.index
      })
      .map((entry) => entry.tx)
  }, [transactions, searchQuery, dateRange, selectedStatuses, sort])

  const totalCount = (transactions ?? []).length

  // ── #725 — Error state with accessible retry action ────────────────────────
  // Only shown when there are no rows to preserve; if rows exist we keep the
  // table visible and surface the retry inline instead of blanking it.
  const renderErrorState = () => (
    <div className="transactions-error" role="alert" aria-live="assertive">
      <p className="transactions-error__message">
        {error || 'Failed to load transactions.'}
      </p>
      <button
        type="button"
        className="transactions-error__retry"
        onClick={handleRetry}
        disabled={retrying}
        aria-busy={retrying}
      >
        <RefreshCw
          size={16}
          className={retrying ? 'transactions-error__retry-icon spinning' : 'transactions-error__retry-icon'}
          aria-hidden="true"
        />
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )

  // ── SortHeader sub-component ─────────────────────────────────────────────────
  

/* … truncated 1865 chars — edit only what you need near the top … */
