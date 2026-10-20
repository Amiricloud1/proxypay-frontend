import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getNotificationSettings: vi.fn(),
  updateNotificationSetting: vi.fn(),
  getNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}))

vi.mock('../../services/api', () => ({ proxyPayAPI: api }))

import { useNotificationStore } from '../notificationStore'

const originalSetting = {
  eventType: 'payment.settled',
  emailEnabled: true,
  webhookEnabled: false,
}

const anotherSetting = {
  eventType: 'payment.failed',
  emailEnabled: false,
  webhookEnabled: true,
}

describe('notificationStore', () => {
  beforeEach(() => {
    api.getNotificationSettings.mockReset()
    api.updateNotificationSetting.mockReset()
    useNotificationStore.setState({
      settings: [],
      loading: false,
      error: null,
      optimisticUpdates: new Map(),
      requestVersions: new Map(),
      pendingRequests: new Map(),
      updateQueues: new Map(),
    })
  })

  // ============= Serialization Tests =============

  describe('Request serialization per event type', () => {
    it('queues multiple updates for the same event type', async () => {
      useNotificationStore.setState({ settings: [originalSetting] })

      api.updateNotificationSetting.mockResolvedValue({
        eventType: 'payment.settled',
        emailEnabled: false,
        webhookEnabled: true,
      })

      // Queue first update
      const firstUpdate = useNotificationStore
        .getState()
        .updateSetting('payment.settled', false, true)

      // Queue second update while first is in flight
      const secondUpdate = useNotificationStore
        .getState()
        .updateSetting('payment.settled', true, false)

      // Both should complete without error
      await firstUpdate
      await secondUpdate

      // API should have been called twice (serialized)
      expect(api.updateNotificationSetting).toHaveBeenCalledTimes(2)
    })

    it('allows concurrent updates for different event types', async () => {
      useNotificationStore.setState({
        settings: [originalSetting, anotherSetting],
      })

      api.updateNotificationSetting
        .mockResolvedValueOnce({
          eventType: 'payment.settled',
          emailEnabled: false,
          webhookEnabled: true,
        })
        .mockResolvedValueOnce({
          eventType: 'payment.failed',
          emailEnabled: true,
          webhookEnabled: false,
        })

      // Start updates for different event types
      const firstUpdate = useNotificationStore
        .getState()
        .updateSetting('payment.settled', false, true)

      const secondUpdate = useNotificationStore
        .getState()
        .updateSetting('payment.failed', true, false)

      // Both should complete concurrently
      await Promise.all([firstUpdate, secondUpdate])

      // Both should have been called
      expect(api.updateNotificationSetting).toHaveBeenCalledTimes(2)

      const settings = useNotificationStore.getState().settings
      expect(settings[0]).toMatchObject({
        eventType: 'payment.settled',
        emailEnabled: false,
        webhookEnabled: true,
      })
      expect(settings[1]).toMatchObject({
        eventType: 'payment.failed',
        emailEnabled: true,
        webhookEnabled: false,
      })
    })
  })

  // ============= Version Tracking Tests =============

  describe('Request versioning and stale response detection', () => {
    it('uses latest version number to track responses', async () => {
      useNotificationStore.setState({ settings: [originalSetting] })

      api.updateNotificationSetting
        .mockResolvedValueOnce({
          eventType: 'payment.settled',
          emailEnabled: false,
          webhookEnabled: false,
        })
        .mockResolvedValueOnce({
          eventType: 'payment.settled',
          emailEnabled: true,
          webhookEnabled: false,
        })

      // Queue two updates
      const first = useNotificationStore
        .getState()
        .updateSetting('payment.settled', false, false)

      const second = useNotificationStore
        .getState()
        .updateSetting('payment.settled', true, false)

      await Promise.all([first, second])

      // Both updates should have been processed
      expect(api.updateNotificationSetting).toHaveBeenCalledTimes(2)

      // Version tracking should have incremented
      expect(useNotificationStore.getState().requestVersions.get('payment.settled')).toBe(2)
    })

    it('tracks version numbers independently per event type', async () => {
      useNotificationStore.setState({
        settings: [originalSetting, anotherSetting],
      })

      api.updateNotificationSetting.mockResolvedValue({
        eventType: 'payment.settled',
        emailEnabled: false,
        webhookEnabled: false,
      })

      const store = useNotificationStore.getState()

      await store.updateSetting('payment.settled', false, false)
      expect(store.requestVersions.get('payment.settled')).toBe(1)

      await store.updateSetting('payment.failed', true, false)
      expect(store.requestVersions.get('payment.failed')).toBe(1)

      await store.updateSetting('payment.settled', true, false)
      expect(store.requestVersions.get('payment.settled')).toBe(2)
      expect(store.requestVersions.get('payment.failed')).toBe(1)
    })

    it('correctly identifies stale updates', () => {
      const store = useNotificationStore.getState()
      store.requestVersions.set('payment.settled', 5)

      expect(store._isUpdateStale('payment.settled', 4)).toBe(true)
      expect(store._isUpdateStale('payment.settled', 5)).toBe(false)
      expect(store._isUpdateStale('payment.settled', 6)).toBe(false)
    })
  })

  // ============= Optimistic Update Tests =============

  describe('Optimistic updates and rollback', () => {
    it('applies optimistic update immediately', async () => {
      useNotificationStore.setState({ settings: [originalSetting] })

      api.updateNotificationSetting.mockResolvedValue({
        eventType: 'payment.settled',
        emailEnabled: false,
        webhookEnabled: true,
      })

      const updatePromise = useNotificationStore
        .getState()
        .updateSetting('payment.settled', false, true)

      // Optimistic update should be visible immediately
      const state = useNotificationStore.getState()
      expect(state.settings[0]).toMatchObject({
        emailEnabled: false,
        webhookEnabled: true,
      })
      expect(state.optimisticUpdates.has('payment.settled')).toBe(true)

      await updatePromise

      // After confirmation, optimistic marker should be cleared
      expect(useNotificationStore.getState().optimisticUpdates.has('payment.settled')).toBe(false)
    })

    it('rolls back optimistic update on API failure', async () => {
      useNotificationStore.setState({ settings: [originalSetting] })

      api.updateNotificationSetting.mockRejectedValue(new Error('Network error'))

      await useNotificationStore.getState().updateSetting('payment.settled', false, true)

      // Should rollback to original state
      expect(useNotificationStore.getState().settings[0]).toEqual(originalSetting)
      expect(useNotificationStore.getState().optimisticUpdates.has('payment.settled')).toBe(false)
      expect(useNotificationStore.getState().error).toBe('Network error')
    })
  })

  // ============= Queue Management Tests =============

  describe('Update queue management', () => {
    it('processes queued updates after earlier update completes', async () => {
      useNotificationStore.setState({ settings: [originalSetting] })

      const calls: any[] = []

      api.updateNotificationSetting.mockImplementation((eventType, email, webhook) => {
        calls.push({ eventType, email, webhook })
        return Promise.resolve({
          eventType,
          emailEnabled: email,
          webhookEnabled: webhook,
        })
      })

      // Queue three updates in rapid succession
      const u1 = useNotificationStore.getState().updateSetting('payment.settled', false, false)
      const u2 = useNotificationStore.getState().updateSetting('payment.settled', true, false)
      const u3 = useNotificationStore.getState().updateSetting('payment.settled', false, true)

      await Promise.all([u1, u2, u3])

      // All three should have been called in order
      expect(calls.length).toBe(3)
      expect(calls[0]).toMatchObject({ email: false, webhook: false })
      expect(calls[1]).toMatchObject({ email: true, webhook: false })
      expect(calls[2]).toMatchObject({ email: false, webhook: true })
    })

    it('handles failures in queue without blocking subsequent updates', async () => {
      useNotificationStore.setState({ settings: [originalSetting] })

      api.updateNotificationSetting
        .mockRejectedValueOnce(new Error('First failed'))
        .mockResolvedValueOnce({
          eventType: 'payment.settled',
          emailEnabled: true,
          webhookEnabled: true,
        })

      const u1 = useNotificationStore.getState().updateSetting('payment.settled', false, false)
      const u2 = useNotificationStore.getState().updateSetting('payment.settled', true, true)

      await Promise.all([u1, u2])

      // Second update should have succeeded despite first failure
      expect(useNotificationStore.getState().settings[0]).toMatchObject({
        emailEnabled: true,
        webhookEnabled: true,
      })
      expect(api.updateNotificationSetting).toHaveBeenCalledTimes(2)
    })
  })

  // ============= Basic Functionality Tests =============

  describe('Basic functionality', () => {
    it('loads settings and clears the loading state', async () => {
      api.getNotificationSettings.mockResolvedValue({ settings: [originalSetting] })

      await useNotificationStore.getState().fetchSettings()

      expect(useNotificationStore.getState().settings).toEqual([originalSetting])
      expect(useNotificationStore.getState().loading).toBe(false)
    })

    it('clears error state', () => {
      useNotificationStore.setState({ error: 'Some error' })
      useNotificationStore.getState().clearError()
      expect(useNotificationStore.getState().error).toBeNull()
    })

    it('handles multiple concurrent notifications without blocking', async () => {
      useNotificationStore.setState({
        settings: [originalSetting, anotherSetting],
      })

      api.updateNotificationSetting.mockResolvedValue({
        eventType: 'payment.settled',
        emailEnabled: true,
        webhookEnabled: true,
      })

      const settledUpdate1 = useNotificationStore
        .getState()
        .updateSetting('payment.settled', true, true)
      const failedUpdate = useNotificationStore
        .getState()
        .updateSetting('payment.failed', true, true)
      const settledUpdate2 = useNotificationStore
        .getState()
        .updateSetting('payment.settled', false, true)

      await Promise.all([settledUpdate1, failedUpdate, settledUpdate2])

      // Should have processed all updates
      expect(api.updateNotificationSetting).toHaveBeenCalledTimes(3)
    })
  })
})
