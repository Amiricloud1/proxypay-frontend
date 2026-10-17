import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getNotificationSettings: vi.fn(),
  updateNotificationSetting: vi.fn(),
  markNotificationsRead: vi.fn(),
  getNotifications: vi.fn(),
  fetchNotifications: vi.fn(),
}))

vi.mock('../../services/api', () => ({ proxyPayAPI: api }))

import { useNotificationStore } from '../notificationStore'

const originalSetting = {
  eventType: 'payment.settled',
  emailEnabled: true,
  webhookEnabled: false,
}

describe('notificationStore', () => {
  beforeEach(() => {
    api.getNotificationSettings.mockReset()
    api.updateNotificationSetting.mockReset()
    api.markNotificationsRead.mockReset()
    api.getNotifications.mockReset()
    useNotificationStore.setState({
      settings: [],
      loading: false,
      error: null,
      optimisticUpdates: new Map(),
      notifications: [],
      notificationsLoading: false,
      bulkReadInProgress: new Set(),
      pastChanges: [],
      futureChanges: [],
    })
  })

  it('loads settings and clears the loading state', async () => {
    api.getNotificationSettings.mockResolvedValue({ settings: [originalSetting] })

    await useNotificationStore.getState().fetchSettings()

    expect(useNotificationStore.getState().settings).toEqual([originalSetting])
    expect(useNotificationStore.getState().loading).toBe(false)
  })

  it('keeps the optimistic value until the server confirms the update', async () => {
    useNotificationStore.setState({ settings: [originalSetting] })
    let resolveUpdate!: (value: typeof originalSetting) => void
    api.updateNotificationSetting.mockImplementation(() => new Promise((resolve) => {
      resolveUpdate = resolve
    }))

    const update = useNotificationStore.getState().updateSetting('payment.settled', false, true)
    expect(useNotificationStore.getState().settings[0]).toMatchObject({ emailEnabled: false, webhookEnabled: true })
    expect(useNotificationStore.getState().optimisticUpdates.has('payment.settled')).toBe(true)

    resolveUpdate({ ...originalSetting, emailEnabled: false, webhookEnabled: true })
    await update
    expect(useNotificationStore.getState().optimisticUpdates.has('payment.settled')).toBe(false)
    expect(useNotificationStore.getState().error).toBeNull()
  })

  it('rolls back a failed update and exposes an error for recovery', async () => {
    useNotificationStore.setState({ settings: [originalSetting] })
    api.updateNotificationSetting.mockRejectedValue(new Error('Network unavailable'))

    await useNotificationStore.getState().updateSetting('payment.settled', false, true)

    expect(useNotificationStore.getState().settings[0]).toEqual(originalSetting)
    expect(useNotificationStore.getState().optimisticUpdates.has('payment.settled')).toBe(false)
    expect(useNotificationStore.getState().error).toBe('Network unavailable')
    useNotificationStore.getState().clearError()
    expect(useNotificationStore.getState().error).toBeNull()
  })
})

// Bulk read tests
describe('notificationStore - Bulk read operations', () => {
  const mockNotifications = [
    { id: 'n1', title: 'Export Ready', message: 'Your export is ready', createdAt: '2024-01-01T00:00:00Z', read: false },
    { id: 'n2', title: 'Payment Settled', message: 'Payment has settled', createdAt: '2024-01-01T01:00:00Z', read: false },
    { id: 'n3', title: 'System Alert', message: 'System maintenance scheduled', createdAt: '2024-01-01T02:00:00Z', read: true },
  ]

  beforeEach(() => {
    api.markNotificationsRead.mockReset()
    useNotificationStore.setState({
      settings: [],
      loading: false,
      error: null,
      optimisticUpdates: new Map(),
      notifications: JSON.parse(JSON.stringify(mockNotifications)),
      notificationsLoading: false,
      bulkReadInProgress: new Set(),
    })
  })

  it('applies optimistic update immediately for bulk read', async () => {
    const idsToRead = ['n1', 'n2']
    let resolveUpdate!: (value: typeof mockNotifications) => void
    api.markNotificationsRead.mockImplementation(() => new Promise((resolve) => {
      resolveUpdate = resolve
    }))

    const bulkReadPromise = useNotificationStore.getState().bulkMarkRead(idsToRead)

    // Verify optimistic update: all specified notifications marked as read
    const state = useNotificationStore.getState()
    expect(state.notifications.find(n => n.id === 'n1')?.read).toBe(true)
    expect(state.notifications.find(n => n.id === 'n2')?.read).toBe(true)
    expect(state.notifications.find(n => n.id === 'n3')?.read).toBe(true) // unchanged

    // Verify tracking of in-flight operations
    expect(state.bulkReadInProgress.has('n1')).toBe(true)
    expect(state.bulkReadInProgress.has('n2')).toBe(true)
    expect(state.error).toBeNull()

    // Resolve with server confirmation
    const updatedNotifications = mockNotifications.map(n =>
      idsToRead.includes(n.id) ? { ...n, read: true } : n
    )
    resolveUpdate(updatedNotifications)
    await bulkReadPromise

    // Verify final state: in-flight tracking cleared, notifications confirmed
    const finalState = useNotificationStore.getState()
    expect(finalState.bulkReadInProgress.size).toBe(0)
    expect(finalState.notifications).toEqual(updatedNotifications)
    expect(finalState.error).toBeNull()
  })

  it('atomically updates all notifications or none on success', async () => {
    const idsToRead = ['n1', 'n2']
    const updatedNotifications = mockNotifications.map(n =>
      idsToRead.includes(n.id) ? { ...n, read: true } : n
    )
    api.markNotificationsRead.mockResolvedValue(updatedNotifications)

    await useNotificationStore.getState().bulkMarkRead(idsToRead)

    const state = useNotificationStore.getState()
    // Verify atomic update: no partial states
    expect(state.notifications.every(n => {
      if (idsToRead.includes(n.id)) return n.read === true
      return n.read === mockNotifications.find(m => m.id === n.id)?.read
    })).toBe(true)
    expect(state.error).toBeNull()
  })

  it('fully rolls back on persistence failure', async () => {
    const idsToRead = ['n1', 'n2']
    api.markNotificationsRead.mockRejectedValue(new Error('Server error'))

    await useNotificationStore.getState().bulkMarkRead(idsToRead)

    const state = useNotificationStore.getState()
    // Verify complete rollback: state restored to previous
    expect(state.notifications).toEqual(mockNotifications)
    expect(state.bulkReadInProgress.size).toBe(0)
    expect(state.error).toContain('Failed to mark notifications as read')
  })

  it('preserves individual notification history during bulk operations', async () => {
    const idsToRead = ['n1', 'n2']
    const updatedNotifications = mockNotifications.map(n =>
      idsToRead.includes(n.id) ? { ...n, read: true } : n
    )
    api.markNotificationsRead.mockResolvedValue(updatedNotifications)

    await useNotificationStore.getState().bulkMarkRead(idsToRead)

    const state = useNotificationStore.getState()
    // Verify notification fields preserved: title, message, createdAt unchanged
    state.notifications.forEach((notification, idx) => {
      const original = mockNotifications[idx]
      expect(notification.id).toBe(original.id)
      expect(notification.title).toBe(original.title)
      expect(notification.message).toBe(original.message)
      expect(notification.createdAt).toBe(original.createdAt)
    })
  })

  it('handles empty ID list gracefully', async () => {
    api.markNotificationsRead.mockResolvedValue(mockNotifications)
    
    await useNotificationStore.getState().bulkMarkRead([])

    expect(api.markNotificationsRead).not.toHaveBeenCalled()
    expect(useNotificationStore.getState().notifications).toEqual(mockNotifications)
  })

  it('maintains isolation between concurrent bulk operations', async () => {
    const idsToRead1 = ['n1']
    const idsToRead2 = ['n2']
    let resolve1!: (value: typeof mockNotifications) => void
    let resolve2!: (value: typeof mockNotifications) => void
    let callCount = 0

    api.markNotificationsRead.mockImplementation(() => new Promise((resolve) => {
      callCount++
      if (callCount === 1) resolve1 = resolve
      else resolve2 = resolve
    }))

    // Start first operation
    const promise1 = useNotificationStore.getState().bulkMarkRead(idsToRead1)
    
    let state = useNotificationStore.getState()
    expect(state.bulkReadInProgress.has('n1')).toBe(true)
    expect(state.bulkReadInProgress.has('n2')).toBe(false)

    // Start second operation while first is pending
    const promise2 = useNotificationStore.getState().bulkMarkRead(idsToRead2)

    state = useNotificationStore.getState()
    expect(state.bulkReadInProgress.has('n1')).toBe(true)
    expect(state.bulkReadInProgress.has('n2')).toBe(true)

    // Resolve first operation
    const updated1 = mockNotifications.map(n =>
      n.id === 'n1' ? { ...n, read: true } : n
    )
    resolve1(updated1)
    await promise1

    state = useNotificationStore.getState()
    expect(state.bulkReadInProgress.has('n1')).toBe(false)
    // Note: n2 may also be cleared if the second operation resolved or is still pending

    // Resolve second operation
    const updated2 = mockNotifications.map(n =>
      (n.id === 'n1' || n.id === 'n2') ? { ...n, read: true } : n
    )
    resolve2(updated2)
    await promise2

    state = useNotificationStore.getState()
    expect(state.bulkReadInProgress.size).toBe(0)
  })

  it('tracks in-flight IDs and clears them on completion', async () => {
    const idsToRead = ['n1', 'n2']
    const updatedNotifications = mockNotifications.map(n =>
      idsToRead.includes(n.id) ? { ...n, read: true } : n
    )
    api.markNotificationsRead.mockResolvedValue(updatedNotifications)

    await useNotificationStore.getState().bulkMarkRead(idsToRead)

    const state = useNotificationStore.getState()
    expect(state.bulkReadInProgress.size).toBe(0)
    idsToRead.forEach(id => {
      expect(state.bulkReadInProgress.has(id)).toBe(false)
    })
  })

  it('clears error state when bulk read succeeds after previous error', async () => {
    useNotificationStore.setState({ error: 'Previous error' })
    
    const idsToRead = ['n1']
    const updatedNotifications = mockNotifications.map(n =>
      n.id === 'n1' ? { ...n, read: true } : n
    )
    api.markNotificationsRead.mockResolvedValue(updatedNotifications)

    await useNotificationStore.getState().bulkMarkRead(idsToRead)

    const state = useNotificationStore.getState()
    expect(state.error).toBeNull()
  })

  it('provides descriptive error messages on bulk operation failure', async () => {
    const idsToRead = ['n1', 'n2']
    const errorMessage = 'Network timeout'
    api.markNotificationsRead.mockRejectedValue(new Error(errorMessage))

    await useNotificationStore.getState().bulkMarkRead(idsToRead)

    const state = useNotificationStore.getState()
    expect(state.error).toContain('Failed to mark notifications as read')
    expect(state.error).toContain(errorMessage)
  })

  it('handles unknown errors gracefully in bulk operations', async () => {
    const idsToRead = ['n1']
    api.markNotificationsRead.mockRejectedValue('Unknown error')

    await useNotificationStore.getState().bulkMarkRead(idsToRead)

    const state = useNotificationStore.getState()
    expect(state.error).toBe('Failed to mark notifications as read')
    expect(state.notifications).toEqual(mockNotifications)
  })
})