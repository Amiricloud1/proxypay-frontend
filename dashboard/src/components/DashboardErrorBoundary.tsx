import React from 'react'
import * as Sentry from '@sentry/react'
import { captureScreenshot, storeScreenshot } from '../services/screenshotCapture'
import { ErrorScreenshotDialog } from './ErrorScreenshotDialog'

interface DashboardErrorBoundaryProps {
  children: React.ReactNode
}

interface DashboardErrorBoundaryState {
  error: Error | null
  eventId: string | null
  screenshotDataUrl: string | null
  showScreenshotDialog: boolean
}

export class DashboardErrorBoundary extends React.Component<
  DashboardErrorBoundaryProps,
  DashboardErrorBoundaryState
> {
  state: DashboardErrorBoundaryState = {
    error: null,
    eventId: null,
    screenshotDataUrl: null,
    showScreenshotDialog: false,
  }

  static getDerivedStateFromError(error: Error): Partial<DashboardErrorBoundaryState> {
    return { error, eventId: null, screenshotDataUrl: null, showScreenshotDialog: false }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Dashboard component error', error, info.componentStack)
    let eventId: string | undefined
    Sentry.withScope((scope) => {
      scope.setTag('error.component', 'DashboardApp')
      scope.setContext('react_component', {
        name: 'DashboardApp',
        props: Object.keys(this.props),
        componentStack: info.componentStack,
      })
      scope.setContext('user_action', {
        user: 'anonymous',
        page: window.location.pathname,
        action: 'render',
      })
      scope.setFingerprint(['{{ default }}', 'DashboardApp'])
      eventId = Sentry.captureException(error)
    })
    const capturedEventId = eventId ?? null
    this.setState({ eventId: capturedEventId })

    // Capture and store screenshot asynchronously
    const errorId = capturedEventId ?? `error-${Date.now()}`
    captureScreenshot()
      .then((dataUrl) => {
        if (dataUrl) {
          storeScreenshot(errorId, dataUrl)
          this.setState({ screenshotDataUrl: dataUrl })
        }
      })
      .catch((err) => {
        console.warn('Screenshot capture failed', err)
      })
  }

  render() {
    const { error, eventId, screenshotDataUrl, showScreenshotDialog } = this.state
    if (!error) return this.props.children

    return (
      <main className="dashboard-error-boundary" role="alert">
        <section>
          <h1>Dashboard unavailable</h1>
          <p>
            An unexpected error interrupted this page. The report contains component and page
            context, but does not include form values.
          </p>
          <div className="dashboard-error-boundary__actions">
            <button
              type="button"
              onClick={() =>
                this.setState({
                  error: null,
                  eventId: null,
                  screenshotDataUrl: null,
                  showScreenshotDialog: false,
                })
              }
            >
              Try again
            </button>
            {eventId && import.meta.env.VITE_SENTRY_DSN && (
              <button type="button" onClick={() => Sentry.showReportDialog({ eventId })}>
                Send feedback
              </button>
            )}
            <button
              type="button"
              onClick={() => this.setState({ showScreenshotDialog: true })}
            >
              View Screenshot
            </button>
          </div>
          {!import.meta.env.VITE_SENTRY_DSN && (
            <p className="dashboard-error-boundary__note">
              Error reporting is not configured for this deployment.
            </p>
          )}
        </section>

        <ErrorScreenshotDialog
          isOpen={showScreenshotDialog}
          onClose={() => this.setState({ showScreenshotDialog: false })}
          errorMessage={error.message}
          timestamp={new Date().toISOString()}
          screenshotDataUrl={screenshotDataUrl ?? undefined}
        />
      </main>
    )
  }
}