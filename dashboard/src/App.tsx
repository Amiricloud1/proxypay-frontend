import { useCallback, useEffect, useState } from 'react'
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

  useEffect(() => {
    fetchTransactions(filters)
  }, [])

  const handleRowClick = (transaction: Transaction) => {
    setSelectedTransaction(transaction)
    setFullPageTransaction(false)
    setDrawerOpen(true)
    void fetchTransactionDetail(transaction.id)
  }

  const handleDrawerClose = () => {
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
          ) : canManageNotifications ? (
            <div className="settings-page">
              <RenderProfiler id="NotificationSettings">
                <NotificationSettings />
              </RenderProfiler>
            </div>
          ) : null}
        </RenderProfiler>
      </main>

      <RenderProfiler id="TransactionDrawer">
        <TransactionDrawer
          transaction={selectedTransaction}
          isOpen={drawerOpen}
          loading={detailLoading}
          error={detailError}
          onClose={handleDrawerClose}
          fullPage={fullPageTransaction}
          onOpenFullPage={() => setFullPageTransaction(true)}
        />
      </RenderProfiler>
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
