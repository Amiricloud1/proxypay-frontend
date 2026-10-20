import axios, { AxiosInstance, AxiosError } from 'axios'
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

export type ApiErrorKind = 'cancelled' | 'timeout' | 'network' | 'server' | 'client' | 'unknown'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  readonly original?: unknown

  constructor(kind: ApiErrorKind, message: string, status?: number, original?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.original = original
  }

  get isCancelled(): boolean {
    return this.kind === 'cancelled'
  }

  get isTimeout(): boolean {
    return this.kind === 'timeout'
  }

  get isNetwork(): boolean {
    return this.kind === 'network'
  }

  get isServer(): boolean {
    return this.kind === 'server'
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (axios.isCancel(error)) {
    return new ApiError('cancelled', 'Request was cancelled', undefined, error)
  }
  const axiosError = error as AxiosError | undefined
  if (axiosError && axiosError.code === 'ECONNABORTED') {
    return new ApiError('timeout', 'Request timed out', undefined, error)
  }
  if (axiosError && axiosError.response) {
    const status = axiosError.response.status
    const kind: ApiErrorKind = status >= 500 ? 'server' : 'client'
    return new ApiError(kind, axiosError.message || `Request failed (${status})`, status, error)
  }
  if (axiosError && axiosError.request) {
    return new ApiError('network', 'Network error — unable to reach server', undefined, error)
  }
  return new ApiError('unknown', (error as Error)?.message || 'Unknown error', undefined, error)
}

class ProxyPayAPI {
  private client: AxiosInstance
  private authToken: string | null = null
  private inFlight = new Map<string, AbortController>()

  constructor(baseURL = resolveBaseUrl('/api')) {
    this.client = axios.create({
      baseURL: resolvedBase,
      withCredentials: true,
      timeout: DEFAULT_TIMEOUT_MS,
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
        return Promise.reject(toApiError(error))
      }
    )
  }

  /**
   * Register an in-flight request so it can be cancelled by key.
   * Returns the AbortSignal to pass to the request config.
   */
  private trackRequest(key: string, externalSignal?: AbortSignal): AbortSignal {
    const controller = new AbortController()
    this.inFlight.set(key, controller)
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort()
      } else {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
      }
    }
    return controller.signal
  }

  private releaseRequest(key: string): void {
    this.inFlight.delete(key)
  }

  /** Cancel a specific in-flight request by key. */
  cancelRequest(key: string): void {
    const controller = this.inFlight.get(key)
    if (controller) {
      controller.abort()
      this.inFlight.delete(key)
    }
  }

  /** Cancel all in-flight requests. */
  cancelAllRequests(): void {
    this.inFlight.forEach((controller) => controller.abort())
    this.inFlight.clear()
  }

  private unwrap<T>(payload: ApiPayload<T>): T {
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return payload.data
    }
    return payload as T
  }

  async getTransactions(
    filters: TransactionFilters,
    options: RequestOptions = {}
  ): Promise<{
    data: Transaction[]
    total: number
  }> {
    const key = 'getTransactions'
    const signal = this.trackRequest(key, options.signal)
    try {
      const { data } = await this.client.get('/transactions', {
        params: filters,
        signal,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      return data
    } finally {
      this.releaseRequest(key)
    }
  }

  async getTransactionDetail(id: string, options: RequestOptions = {}): Promise<Transaction> {
    const key = `getTransactionDetail:${id}`
    const signal = this.trackRequest(key, options.signal)
    try {
      const { data } = await this.client.get(`/transactions/${encodeURIComponent(id)}`, {
        signal,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      return this.unwrap<Transaction>(data)
    } finally {
      this.releaseRequest(key)
    }
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
}

type ApiPayload<T> = T | { data: T }

export const api = new ProxyPayAPI()
export default api
