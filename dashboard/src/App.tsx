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

const PAGE_METADATA: Record<Page, { title: string; description: string }> = {
  transactions: {
    title: 'Transactions | ProxyPay Dashboard',
    description: 'Review, export, and manage your ProxyPay transaction history.',
  },
  reconciliation: {
    title: 'Reconciliation | ProxyPay Dashboard',
    description: 'Reconcile ProxyPay transactions against your settlement records.',
  },
  settings: {
    title: 'Notification Settings | ProxyPay Dashboard',
    description: 'Configure how and when ProxyPay sends you notifications.',
  },
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

  // Keep document title and meta description in sync with the active route
  useEffect(() => {
    const { title, description } = PAGE_METADATA[currentPage]
    document.title = title

    let metaDescription = document.querySelector('meta[name="description"]')
    if (!metaDescription) {
      metaDescription = document.createElement('meta')
      metaDescription.setAttribute('name', 'description')
      document.head.appendChild(metaDescription)
    }
    metaDescription.setAttribute('content', description)
  }, [currentPage])

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
