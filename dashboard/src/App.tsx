import { Profiler, useState, useEffect, useRef } from 'react'
import { useTransactionStore } from './stores/transactionStore'
import { TransactionsTable } from './components/TransactionsTable'
import { TransactionDrawer } from './components/TransactionDrawer'
import { ExportButton } from './components/ExportButton'
import { NotificationSettings } from './components/NotificationSettings'
import { NotificationCenter } from './components/NotificationCenter'
import { DuplicateReview } from './components/DuplicateReview'
import { ReconciliationTab } from './components/ReconciliationTab'
import { SessionExpirationDialog } from './components/SessionExpirationDialog'
import { ToastNotifications } from './components/ToastNotifications'
import { ComponentRenderDebugPanel } from './components/ComponentRenderDebugPanel'
import { RenderProfiler } from './components/RenderProfiler'
import { canAccess } from './auth/access'
import { useSessionExpiration } from './hooks/useSessionExpiration'
import type { Transaction } from './services/api'
import type { TransactionMergeResult } from './services/duplicateDetection'
import './App.css'

type Page = 'transactions' | 'reconciliation' | 'settings'

// Issue #717: reasonable timeout for in-flight detail requests (ms)
const REQUEST_TIMEOUT_MS = 15000

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('transactions')
  const {
    selectedTransaction,
    setSelectedTransaction,
    detailLoading,
    detailError,
    fetchTransactionDetail,
    fetchTransactions,
    filters,
    transactions,
  } = useTransactionStore()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [fullPageTransaction, setFullPageTransaction] = useState(false)
  const canManageNotifications = canAccess('notification-settings')
  const handleSessionExpired = useCallback(() => {
    setDrawerOpen(false)
    setSelectedTransaction(null)
  }, [setSelectedTransaction])
  const { showWarning, secondsRemaining, extendSession, signOut } =
    useSessionExpiration(handleSessionExpired)

  // Issue #717: track the in-flight detail request so it can be cancelled
  const detailAbortRef = useRef<AbortController | null>(null)
  const detailTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearDetailRequest = () => {
    if (detailTimeoutRef.current) {
      clearTimeout(detailTimeoutRef.current)
      detailTimeoutRef.current = null
    }
    detailAbortRef.current = null
  }

  const cancelDetailRequest = () => {
    if (detailAbortRef.current) {
      detailAbortRef.current.abort()
    }
    clearDetailRequest()
  }

  // Initialize transactions on mount
  useEffect(() => {
    fetchTransactions(filters)
  }, [])

  // Issue #717: abort any in-flight request on unmount
  useEffect(() => {
    return () => {
      cancelDetailRequest()
    }
  }, [])

  const handleRowClick = (tx: Transaction) => {
    // Cancel any previous in-flight request before starting a new one
    cancelDetailRequest()

    const controller = new AbortController()
    detailAbortRef.current = controller
    detailTimeoutRef.current = setTimeout(() => {
      controller.abort()
    }, REQUEST_TIMEOUT_MS)

    setSelectedTransaction(tx)
    setFullPageTransaction(false)
    setDrawerOpen(true)
    void fetchTransactionDetail(tx.id, { signal: controller.signal }).finally(() => {
      clearDetailRequest()
    })
  }

  const handleCancelRequest = () => {
    cancelDetailRequest()
  }

  const handleDrawerClose = () => {
    cancelDetailRequest()
    setDrawerOpen(false)
    setFullPageTransaction(false)
    setTimeout(() => setSelectedTransaction(null), 300)
  }

  const handleMerged = (result: TransactionMergeResult) => {
    setSelectedTransaction(result.transaction)
    void fetchTransactions(filters)
  }

  return (
    <div className="app">
      <RenderProfiler id="ToastNotifications">
        <ToastNotifications />
      </RenderProfiler>

      <header className="app-header">
        <div className="header-content">
          <h1 className="app-title">ProxyPay Dashboard</h1>
          <RenderProfiler id="NotificationCenter">
            <NotificationCenter />
          </RenderProfiler>
          <nav className="nav-tabs">
            <button
              className={`nav-tab ${currentPage === 'transactions' ? 'active' : ''}`}
              onClick={() => setCurrentPage('transactions')}
            >
              Transactions
            </button>
            {canManageNotifications && (
              <button
                className={`nav-tab ${currentPage === 'settings' ? 'active' : ''}`}
                onClick={() => setCurrentPage('settings')}
              >
                Notification Settings
              </button>
            )}
          </nav>
        </div>
      </header>

      <main className="app-main">
        <RenderProfiler id="Dashboard main">
          {currentPage === 'transactions' ? (
            <div className="transactions-page">
              <div className="page-header">
                <h2>Transaction History</h2>
                <RenderProfiler id="ExportButton">
                  <ExportButton />
                </RenderProfiler>
              </div>
              <RenderProfiler id="TransactionsTable">
                <TransactionsTable onRowClick={handleRowClick} loadOnMount={false} />
              </RenderProfiler>
              <RenderProfiler id="DuplicateReview">
                <DuplicateReview transactions={transactions} onMerged={handleMerged} />
              </RenderProfiler>
            </div>
          ) : currentPage === 'reconciliation' ? (
            <div className="reconciliation-page">
              <RenderProfiler id="ReconciliationTab">
                <ReconciliationTab />
              </RenderProfiler>
            </div>
          ) : currentPage === 'reconciliation' ? (
            <div className="reconciliation-page">
              <ReconciliationTab />
            </div>
          ) : canManageNotifications ? (
            <div className="settings-page">
              <NotificationSettings />
            </div>
          ) : null}
        </Profiler>
      </main>

      {/* Transaction Detail Drawer */}
      <TransactionDrawer
        transaction={selectedTransaction}
        isOpen={drawerOpen}
        loading={detailLoading}
        error={detailError}
        onClose={handleDrawerClose}
        onCancel={handleCancelRequest}
        fullPage={fullPageTransaction}
        onOpenFullPage={() => setFullPageTransaction(true)}
      />
      {showWarning && (
        <SessionExpirationDialog
          secondsRemaining={secondsRemaining}
          onExtend={() => void extendSession()}
          onSignOut={signOut}
        />
      )}
      {import.meta.env.DEV && <ComponentRenderDebugPanel />}
    </div>
  )
}
