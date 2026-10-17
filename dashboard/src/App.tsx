import { Profiler, useState, useEffect } from 'react'
import { useTransactionStore } from './stores/transactionStore'
import { useFeatureFlagStore } from './stores/featureFlagStore'
import { TransactionsTable } from './components/TransactionsTable'
import { TransactionDrawer } from './components/TransactionDrawer'
import { ExportButton } from './components/ExportButton'
import { NotificationSettings } from './components/NotificationSettings'
import { NotificationCenter } from './components/NotificationCenter'
import { canAccess } from './auth/access'
import './App.css'

type Page = 'transactions' | 'reconciliation' | 'settings'

// Issue #707: keep the selected transaction addressable via the URL so that
// deep-linked selections survive search / deprecation filter changes.
const SELECTED_TX_PARAM = 'tx'

function readSelectedTxFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(SELECTED_TX_PARAM)
}

function writeSelectedTxToUrl(id: string | null) {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  if (id) {
    url.searchParams.set(SELECTED_TX_PARAM, id)
  } else {
    url.searchParams.delete(SELECTED_TX_PARAM)
  }
  window.history.replaceState(window.history.state, '', url.toString())
}

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('transactions')
  const {
    selectedTransaction,
    setSelectedTransaction,
    detailLoading,
    fetchTransactionDetail,
    fetchTransactions,
    filters,
    transactions,
  } = useTransactionStore()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [fullPageTransaction, setFullPageTransaction] = useState(false)
  const canManageNotifications = canAccess('notification-settings')

  // Initialize transactions on mount
  useEffect(() => {
    fetchTransactions(filters)
  }, [])

  // Issue #707: restore a deep-linked selection from the URL on mount.
  useEffect(() => {
    const txId = readSelectedTxFromUrl()
    if (!txId) return
    const match = transactions.find((tx) => tx.id === txId)
    if (match) {
      setSelectedTransaction(match)
      setFullPageTransaction(false)
      setDrawerOpen(true)
      void fetchTransactionDetail(match.id)
    } else {
      void fetchTransactionDetail(txId)
    }
  }, [])

  // Issue #707: keep the URL in sync with the current selection.
  useEffect(() => {
    writeSelectedTxToUrl(selectedTransaction?.id ?? null)
  }, [selectedTransaction?.id])

  const handleRowClick = (tx: Transaction) => {
    setSelectedTransaction(tx)
    setFullPageTransaction(false)
    setDrawerOpen(true)
    void fetchTransactionDetail(tx.id)
  }

  const handleDrawerClose = () => {
    setDrawerOpen(false)
    setFullPageTransaction(false)
    setTimeout(() => setSelectedTransaction(null), 300) // Delay to allow animation
  }

  const handleMerged = (result: TransactionMergeResult) => {
    setSelectedTransaction(result.transaction)
    void fetchTransactions(filters)
  }

  return (
    <div className="app">
      {/* Global toast notifications — Issue #447 */}
      <ToastNotifications />

      {/* Header Navigation */}
      <header className="app-header">
        <div className="header-content">
          <h1 className="app-title">ProxyPay Dashboard</h1>
          <NotificationCenter />
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

      {/* Main Content */}
      <main className="app-main">
        <Profiler id="dashboard-main" onRender={handleProfile}>
          {currentPage === 'transactions' ? (
            <div className="transactions-page">
              <div className="page-header">
                <h2>Transaction History</h2>
                <ExportButton />
              </div>
              <TransactionsTable onRowClick={handleRowClick} loadOnMount={false} />
              <DuplicateReview transactions={transactions} onMerged={handleMerged} />
            </div>
            <TransactionsTable onRowClick={handleRowClick} loadOnMount={false} />
            <DuplicateReview transactions={transactions} onMerged={handleMerged} />
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
      </main>

      {/* Transaction Detail Drawer */}
      <TransactionDrawer
        transaction={selectedTransaction}
        isOpen={drawerOpen}
        loading={detailLoading}
        error={detailError}
        onClose={handleDrawerClose}
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
    </div>
  )
}
