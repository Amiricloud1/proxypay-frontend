import axios, { AxiosInstance, AxiosRequestConfig, CancelTokenSource } from 'axios'
import { recordPerformanceMetric } from './performance'
import { useInterceptorLogStore } from '../stores/interceptorLogStore'
import { useApiConfigStore } from '../stores/apiConfigStore'

export type TransactionStatus =
  | 'pending'
  | 'settled'
  | 'failed'
  | 'processing'
  | 'cancelled'
  | 'refunded'
  | 'duplicate'
  | (string & {})

export interface StatusTransition {
  id?: string
  fromStatus?: TransactionStatus | null
  toStatus: TransactionStatus
  timestamp: string
  actor?: string
  reason?: string
  details?: string
}

export interface AuditEvent {
  timestamp: string
  event: string
  details: string
  actor: string
  fromStatus?: TransactionStatus | null
  toStatus?: TransactionStatus
  reason?: string
}

export interface Transaction {
  id: string
  reference: string
  stellarHash: string
  mobileMoneyReference: string
  amount: number
  fee: number
  feeBreakdown: {
    platformFee: number
    networkFee: number
    providerFee: number
  }
  status: TransactionStatus
  provider: 'vodafone' | 'mtn' | 'airtel'
  timestamp: string
  settledAt?: string
  failureReason?: string
  auditTrail: AuditEvent[]
  statusHistory?: StatusTransition[]
  statusChanges?: StatusTransition[]
  duplicateOf?: string
  isDuplicate?: boolean
  mergedIntoId?: string
}

export interface TransactionFilters {
  dateFrom?: string
  dateTo?: string
  status?: string
  /** Single provider (legacy, kept for API compat) */
  provider?: string
  /** Multi-select providers for UI filtering (#495) */
  providers?: Array<'vodafone' | 'mtn' | 'airtel'>
  limit?: number
  offset?: number
}

export type DuplicateMatchReason =
  | 'stellarHash'
  | 'mobileMoneyReference'
  | 'reference'
  | 'transactionFingerprint'
  | 'manual'

export interface DuplicateTransactionGroup {
  id: string
  transactionIds: string[]
  canonicalId: string
  transactions: Transaction[]
  reason: DuplicateMatchReason
  confidence: number
  markedAsDuplicate?: boolean
}

export interface DuplicateMarkRequest {
  transactionIds: string[]
  duplicateOfId: string
  reason?: string
}

export interface MergeTransactionsRequest {
  canonicalId: string
  duplicateIds: string[]
  actor?: string
  reason?: string
}

export type ExportFrequency = 'daily' | 'weekly' | 'monthly'
export type ExportDeliveryType = 'email' | 'webhook'
export type ExportFormat = 'csv'

export interface ExportDelivery {
  type: ExportDeliveryType
  email?: string
  webhookUrl?: string
}

export interface ExportSchedule {
  id: string
  name: string
  frequency: ExportFrequency
  time: string
  timezone: string
  dayOfWeek?: number
  dayOfMonth?: number
  format: ExportFormat
  includeAuditTrail: boolean
  filters?: TransactionFilters
  delivery: ExportDelivery
  notifyOnCompletion: boolean
  active: boolean
  nextRunAt?: string
  lastRunAt?: string
  createdAt?: string
  updatedAt?: string
}

export type CreateExportSchedule = Omit<ExportSchedule, 'id' | 'nextRunAt' | 'lastRunAt' | 'createdAt' | 'updatedAt'> & {
  id?: string
  nextRunAt?: string
  lastRunAt?: string
}

export interface ExportCompletionNotification {
  id?: string
  scheduleId: string
  message: string
  completedAt: string
}

export interface NotificationSettings {
  eventType: string
  emailEnabled: boolean
  webhookEnabled: boolean
}

export interface NotificationConfig {
  settings: NotificationSettings[]
}

export interface ScheduledExport {
  id: string
  scheduledFor: string
  status: 'scheduled' | 'processing' | 'ready' | 'failed'
}

export interface DashboardNotification {
  id: string
  title: string
  message: string
  createdAt: string
  read: boolean
  actionUrl?: string
}

/**
 * Resolve a root-relative path against the configured base URL so that
 * local resources stay inside the deployed project path (e.g. GitHub Pages
 * `/proxypay-frontend/`). Absolute URLs and already-prefixed paths are
 * returned unchanged.
 */
export function resolveBaseUrl(path: string): string {
  if (!path || /^([a-z][a-z0-9+.-]*:)?\/\//i.test(path)) {
    return path
  }
  const baseUrl = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
  if (!baseUrl) {
    return path
  }
  if (path === baseUrl || path.startsWith(`${baseUrl}/`)) {
    return path
  }
  return path.startsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`
}

class ProxyPayAPI {
  private client: AxiosInstance
  private authToken: string | null = null

  constructor(baseURL = resolveBaseUrl('/api')) {
    this.client = axios.create({
      baseURL: resolvedBase,
      withCredentials: true,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    const token = typeof localStorage !== 'undefined'
      ? localStorage.getItem('auth_token')
      : null
    if (token) {
      this.client.defaults.headers.common['Authorization'] = `Bearer ${token}`
    }

    // ── Subscribe to base-URL changes so the client stays in sync (#598) ─────
    useApiConfigStore.subscribe((state) => {
      const newBase = state.getEffectiveBaseUrl()
      if (this.client.defaults.baseURL !== newBase) {
        this.client.defaults.baseURL = newBase
      }
    })

    const requestStartedAt = new WeakMap<object, number>()
    // Maps config → interceptor log entry id (#597)
    const requestLogId = new WeakMap<object, string>()
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

    // ── Request interceptor: timing + logging (#597) ──────────────────────────
    this.client.interceptors.request.use((config) => {
      const startMs = now()
      requestStartedAt.set(config, startMs)

      // #597 — log the outgoing request
      const logStore = useInterceptorLogStore.getState()
      const rawHeaders = config.headers
        ? Object.fromEntries(
            Object.entries(config.headers).filter(
              ([, v]) => v !== undefined && v !== null,
            ) as [string, string][],
          )
        : {}
      const logId = logStore.addRequest(
        config.method ?? 'get',
        config.url ?? '',
        (config.params as Record<string, unknown>) ?? {},
        rawHeaders,
      )
      requestLogId.set(config, logId)

      return config
    })

    // ── Response interceptor: timing + logging (#597) ─────────────────────────
    this.client.interceptors.response.use(
      (response) => {
        const startMs = requestStartedAt.get(response.config)
        const durationMs = startMs !== undefined ? now() - startMs : 0
        requestStartedAt.delete(response.config)

        recordPerformanceMetric('api-response', durationMs, {
          endpoint: response.config.url || 'unknown',
          method: (response.config.method || 'get').toUpperCase(),
        })

        // #597 — resolve the log entry
        const logId = requestLogId.get(response.config)
        if (logId) {
          const responseHeaders: Record<string, string> = {}
          if (response.headers) {
            Object.entries(response.headers).forEach(([k, v]) => {
              if (typeof v === 'string') responseHeaders[k] = v
            })
          }
          useInterceptorLogStore
            .getState()
            .resolveRequest(logId, response.status, responseHeaders, durationMs)
          requestLogId.delete(response.config)
        }

        return response
      },
      (error: unknown) => {
        const axiosError = error as {
          config?: AxiosRequestConfig & object
          response?: { status?: number; headers?: Record<string, string> }
          message?: string
        }

        if (axiosError.config) {
          const startMs = requestStartedAt.get(axiosError.config)
          const durationMs = startMs !== undefined ? now() - startMs : 0
          requestStartedAt.delete(axiosError.config)

          recordPerformanceMetric('api-response', durationMs, {
            endpoint: axiosError.config.url || 'unknown',
            method: (axiosError.config.method || 'get').toUpperCase(),
          })

          // #597 — reject the log entry
          const logId = requestLogId.get(axiosError.config)
          if (logId) {
            useInterceptorLogStore.getState().rejectRequest(
              logId,
              axiosError.message ?? 'Request failed',
              durationMs,
              axiosError.response?.status,
            )
            requestLogId.delete(axiosError.config)
          }
        }

        return Promise.reject(error)
      },
    )
  }

  // ── #599: deduplicated GET helper ────────────────────────────────────────────
  private async getDeduped<T>(
    url: string,
    config?: AxiosRequestConfig,
  ): Promise<T> {
    const key = requestKey('GET', url, config?.params)
    const existing = inFlightRequests.get(key)

    if (existing) {
      // Mark the log entry that was just created by the request interceptor as
      // deduplicated — we'll re-use the in-flight promise instead.
      // The newest entry is at index 0 in the store.
      const logStore = useInterceptorLogStore.getState()
      const latestPendingId = logStore.entries.find(
        (e) => e.url === url && e.status === 'pending',
      )?.id
      if (latestPendingId && latestPendingId !== existing.logId) {
        logStore.markDeduplicated(latestPendingId)
      }
      return existing.promise as Promise<T>
    }

    const cancelSource = axios.CancelToken.source()
    const promise = this.client
      .get<T>(url, { ...config, cancelToken: cancelSource.token })
      .then((res) => res.data)
      .finally(() => {
        inFlightRequests.delete(key)
      })

    // Capture the log id of the request that just fired
    const logId =
      useInterceptorLogStore.getState().entries.find(
        (e) => e.url === url && e.status === 'pending',
      )?.id ?? ''

    inFlightRequests.set(key, { promise, cancelSource, logId })
    return promise
  }

  private unwrap<T>(payload: ApiPayload<T>): T {
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return payload.data
    }
    return payload as T
  }

  async getTransactions(filters: TransactionFilters): Promise<{
    data: Transaction[]
    total: number
  }> {
    // #599 — deduplicate identical in-flight list requests
    return this.getDeduped<{ data: Transaction[]; total: number }>(
      '/transactions',
      { params: filters },
    )
  }

  async getTransactionDetail(id: string): Promise<Transaction> {
    // #599 — deduplicate identical detail requests
    const raw = await this.getDeduped<ApiPayload<Transaction>>(
      `/transactions/${encodeURIComponent(id)}`,
    )
    return this.unwrap<Transaction>(raw as ApiPayload<Transaction>)
  }

  async getStatusHistory(id: string): Promise<StatusTransition[]> {
    const { data } = await this.client.get(
      `/transactions/${encodeURIComponent(id)}/status-history`
    )
    return this.unwrap<StatusTransition[]>(data) || []
  }

  async getDuplicateTransactions(
    filters?: TransactionFilters
  ): Promise<DuplicateTransactionGroup[]> {
    const { data } = await this.client.get('/transactions/duplicates', {
      params: filters,
    })
    return this.unwrap<DuplicateTransactionGroup[]>(data) || []
  }

  getDuplicateCandidates(
    filters?: TransactionFilters
  ): Promise<DuplicateTransactionGroup[]> {
    return this.getDuplicateTransactions(filters)
  }

  async markTransactionsAsDuplicates(
    request: DuplicateMarkRequest
  ): Promise<DuplicateTransactionGroup | DuplicateTransactionGroup[]> {
    const { data } = await this.client.post('/transactions/duplicates/mark', request)
    return this.unwrap<DuplicateTransactionGroup | DuplicateTransactionGroup[]>(data)
  }

  markDuplicateTransactions(
    request: DuplicateMarkRequest
  ): Promise<DuplicateTransactionGroup | DuplicateTransactionGroup[]> {
    return this.markTransactionsAsDuplicates(request)
  }

  async mergeTransactions(
    canonicalId: string,
    duplicateIds: string[],
    metadata?: Pick<MergeTransactionsRequest, 'actor' | 'reason'>
  ): Promise<Transaction> {
    const { data } = await this.client.post('/transactions/merge', {
      canonicalId,
      duplicateIds,
      ...metadata,
    })
    return this.unwrap<Transaction>(data)
  }

  mergeDuplicateTransactions(
    canonicalId: string,
    duplicateIds: string[]
  ): Promise<Transaction> {
    return this.mergeTransactions(canonicalId, duplicateIds)
  }

  async getExportSchedules(): Promise<ExportSchedule[]> {
    const { data } = await this.client.get('/transactions/exports/schedules')
    return this.unwrap<ExportSchedule[]>(data) || []
  }

  async createExportSchedule(
    schedule: CreateExportSchedule
  ): Promise<ExportSchedule> {
    const { data } = await this.client.post(
      '/transactions/exports/schedules',
      schedule
    )
    return this.unwrap<ExportSchedule>(data)
  }

  async updateExportSchedule(
    id: string,
    schedule: Partial<CreateExportSchedule>
  ): Promise<ExportSchedule> {
    const { data } = await this.client.put(
      `/transactions/exports/schedules/${encodeURIComponent(id)}`,
      schedule
    )
    return this.unwrap<ExportSchedule>(data)
  }

  async deleteExportSchedule(id: string): Promise<void> {
    await this.client.delete(
      `/transactions/exports/schedules/${encodeURIComponent(id)}`
    )
  }

  async runExportSchedule(id: string): Promise<ScheduledExport> {
    const { data } = await this.client.post(
      `/transactions/exports/schedules/${encodeURIComponent(id)}/run`
    )
    return this.unwrap<ScheduledExport>(data)
  }

  async getNotificationConfig(): Promise<NotificationConfig> {
    const { data } = await this.client.get('/notifications/config')
    return this.unwrap<NotificationConfig>(data)
  }

  async updateNotificationConfig(
    config: NotificationConfig
  ): Promise<NotificationConfig> {
    const { data } = await this.client.put('/notifications/config', config)
    return this.unwrap<NotificationConfig>(data)
  }

  async getNotifications(): Promise<DashboardNotification[]> {
    const { data } = await this.client.get('/notifications')
    return this.unwrap<DashboardNotification[]>(data) || []
  }

  async markNotificationRead(id: string): Promise<DashboardNotification> {
    const { data } = await this.client.post(
      `/notifications/${encodeURIComponent(id)}/read`
    )
    return this.unwrap<DashboardNotification>(data)
  }
}

type ApiPayload<T> = T | { data: T }

export const api = new ProxyPayAPI()
export default api
