export interface ExternalUrlValidation {
  url: URL
  trusted: boolean
}

export interface CorsDiagnostic {
  checkedAt: string
  allowOrigin: string | null
  allowCredentials: boolean
  status: 'permissive' | 'restricted' | 'unavailable'
}

let lastCorsDiagnostic: CorsDiagnostic | null = null
const corsDiagnosticListeners = new Set<(diagnostic: CorsDiagnostic) => void>()

export function validateExternalUrl(
  value: string,
  currentOrigin: string,
  trustedDomains: readonly string[] = []
): ExternalUrlValidation | null {
  try {
    const origin = new URL(currentOrigin)
    const url = new URL(value, origin)
    const sameOrigin = url.origin === origin.origin
    if ((!sameOrigin && url.protocol !== 'https:') || url.username || url.password) return null

    const trusted =
      sameOrigin ||
      trustedDomains.some((domain) => {
        const normalizedDomain = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
        const hostname = url.hostname.toLowerCase()
        return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
      })

    return { url, trusted }
  } catch {
    return null
  }
}

export function sanitizeErrorMessage(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred'
  const sanitized = message
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token)[=:]\s*)[^\s&,;]+/gi, '$1[REDACTED]')
  return secret ? sanitized.split(secret).join('[REDACTED]') : sanitized
}

/**
 * Authorization headers are secrets. Keep them out of persisted request
 * history and out of URLs/query strings so they cannot be shoulder-surfed
 * or accidentally copied.
 */
export function redactAuthorizationForHistory(
  headers: Record<string, string> | undefined
): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) =>
      name.toLowerCase() === 'authorization' ? [name, '[REDACTED]'] : [name, value]
    )
  )
}

/**
 * Strip any authorization value that may have leaked into a URL or query
 * string before it is displayed, copied, or persisted.
 */
export function stripAuthorizationFromUrl(value: string): string {
  try {
    const url = new URL(value, 'http://localhost')
    let changed = false
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(authorization|auth|token|api[_-]?key)$/i.test(key)) {
        url.searchParams.delete(key)
        changed = true
      }
    }
    if (url.username || url.password) {
      url.username = ''
      url.password = ''
      changed = true
    }
    return changed ? url.toString() : value
  } catch {
    return value
  }
}

export function getCorsDiagnostic(): CorsDiagnostic | null {
  return lastCorsDiagnostic
}

export function subscribeCorsDiagnostic(
  listener: (diagnostic: CorsDiagnostic) => void
): () => void {
  corsDiagnosticListeners.add(listener)
  return () => corsDiagnosticListeners.delete(listener)
}

export function inspectCorsHeaders(
  headers: Record<string, unknown>,
  expectedOrigin: string
): CorsDiagnostic {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([name, value]) => [name.toLowerCase(), String(value)])
  )
  const allowOrigin = normalizedHeaders['access-control-allow-origin'] || null
  const allowCredentials = normalizedHeaders['access-control-allow-credentials']?.toLowerCase() === 'true'
  const status: CorsDiagnostic['status'] =
    allowOrigin === '*'
      ? 'permissive'
      : allowOrigin === expectedOrigin
        ? 'restricted'
        : 'unavailable'

  const diagnostic = {
    checkedAt: new Date().toISOString(),
    allowOrigin,
    allowCredentials,
    status,
  }
  lastCorsDiagnostic = diagnostic
  corsDiagnosticListeners.forEach((listener) => listener(diagnostic))
  return diagnostic
}