import { create } from 'zustand'
import {
  DashboardNotification,
  NotificationSettings,
  proxyPayAPI,
} from '../services/api'

export interface NotificationChange {
  eventType: string
  previous: NotificationSettings
  next: NotificationSettings
}

interface NotificationStore {
  settings: NotificationSettings[]
  loading: boolean
  error: string | null
  optimisticUpdates: Map<string, NotificationSettings>
  notifications: DashboardNotification[]
  notificationsLoading: boolean
  bulkReadInProgress: Set<string>
  pastChanges: NotificationChange[]
  futureChanges: NotificationChange[]

  // Actions
  fetchSettings: () => Promise<void>
  updateSetting: (
    eventType: string,
    emailEnabled: boolean,
    webhookEnabled: boolean
  ) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  clearError: () => void
  fetchNotifications: () => Promise<void>
  markNotificationRead: (id: string) => Promise<void>
  bulkMarkRead: (ids: string[]) => Promise<void>
}

const MAX_HISTORY_SIZE = 20

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  settings: [],
  loading: false,
  error: null,
  optimisticUpdates: new Map(),
  notifications: [],
  notificationsLoading: false,
  bulkReadInProgress: new Set(),
  pastChanges: [],
  futureChanges: [],

  fetchSettings: async () => {
    set({ loading: true, error: null })
    try {
      const config = await proxyPayAPI.getNotificationSettings()
      set({ settings: config.settings, loading: false })
    } catch (error) {
      set({
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch notification settings',
        loading: false,
      })
    }
  },

  updateSetting: async (
    eventType: string,
    emailEnabled: boolean,
    webhookEnabled: boolean
  ) => {
    const state = get()
    const optimisticUpdates = new Map(state.optimisticUpdates)

    // Store current state for rollback
    const previousSetting = state.settings.find((s) => s.eventType === eventType)

    // Optimistic update
    const optimisticSetting: NotificationSettings = {
      eventType,
      emailEnabled,
      webhookEnabled,
    }
    optimisticUpdates.set(eventType, optimisticSetting)

    set((state) => ({
      settings: state.settings.map((s) =>
        s.eventType === eventType ? optimisticSetting : s
      ),
      optimisticUpdates,
    }))

    try {
      // Attempt API call
      const updated = await proxyPayAPI.updateNotificationSetting(
        eventType,
        emailEnabled,
        webhookEnabled
      )

      optimisticUpdates.delete(eventType)

      set((state) => ({
        settings: state.settings.map((s) =>
          s.eventType === eventType ? updated : s
        ),
        optimisticUpdates,
        pastChanges: previousSetting
          ? [
              ...state.pastChanges,
              {
                eventType,
                previous: previousSetting,
                next: updated,
              },
            ].slice(-MAX_HISTORY_SIZE)
          : state.pastChanges,
        futureChanges: [],
      }))
    } catch (error) {
      // Rollback on failure
      optimisticUpdates.delete(eventType)

      set((state) => ({
        settings: previousSetting
          ? state.settings.map((s) =>
              s.eventType === eventType ? previousSetting : s
            )
          : state.settings,
        optimisticUpdates,
        error:
          error instanceof Error ? error.message : 'Failed to update setting',
      }))
    }
  },

  fetchNotifications: async () => {
    set({ notificationsLoading: true })
    try {
      const notifications = await proxyPayAPI.getNotifications()
      set({ notifications, notificationsLoading: false })
    } catch (error) {
      set({
        notificationsLoading: false,
        error:
          error instanceof Error ? error.message : 'Failed to fetch notifications',
      })
    }
  },

  markNotificationRead: async (id: string) => {
    try {
      await proxyPayAPI.markNotificationRead(id)
      set((state) => ({
        notifications: state.notifications.map((notification) =>
          notification.id === id ? { ...notification, read: true } : notification
        ),
      }))
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : 'Failed to update notification',
      })
    }
  },

  bulkMarkRead: async (ids: string[]) => {
    if (ids.length === 0) return

    const state = get()
    
    // Store previous state for rollback
    const previousNotifications = state.notifications
    const bulkReadInProgress = new Set(state.bulkReadInProgress)
    ids.forEach(id => bulkReadInProgress.add(id))

    // Optimistic update - mark all as read atomically
    const optimisticNotifications = previousNotifications.map((notification) =>
      ids.includes(notification.id) ? { ...notification, read: true } : notification
    )

    set({
      notifications: optimisticNotifications,
      bulkReadInProgress,
      error: null,
    })

    try {
      // Attempt API call - server returns updated notifications for atomic confirmation
      const updatedNotifications = await proxyPayAPI.markNotificationsRead(ids)
      
      bulkReadInProgress.forEach(id => bulkReadInProgress.delete(id))

      set({
        notifications: updatedNotifications,
        bulkReadInProgress,
      })
    } catch (error) {
      // Rollback on failure - restore previous state atomically
      bulkReadInProgress.forEach(id => bulkReadInProgress.delete(id))

      set({
        notifications: previousNotifications,
        bulkReadInProgress,
        error:
          error instanceof Error
            ? `Failed to mark notifications as read: ${error.message}`
            : 'Failed to mark notifications as read',
      })
    }
  },

  clearError: () => {
    set({ error: null })
  },

  undo: async () => {
    // Placeholder for future undo functionality
  },

  redo: async () => {
    // Placeholder for future redo functionality
  },
}))
