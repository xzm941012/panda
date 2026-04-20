import type { PluginListenerHandle } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { createClient } from '@panda/sdk'
import { readHubUrl } from './client'
import { isAndroidApp, isNativeApp } from './platform'

export type CompletionNotificationSettings = {
  completionNotificationsEnabled: boolean
}

type StoredCompletionNotificationMap = Record<string, string>

type StoredWebPushSubscriptionState = {
  completionNotificationsEnabled: boolean
  endpoint: string
  updatedAt: string
}

type NavigatorWithStandalone = Navigator & {
  standalone?: boolean
}

const NOTIFICATION_SETTINGS_STORAGE_KEY = 'panda:notification-settings'
const NOTIFIED_COMPLETIONS_STORAGE_KEY = 'panda:notified-completions'
const WEB_PUSH_SUBSCRIPTION_STATE_STORAGE_KEY = 'panda:web-push-subscription-state'
const COMPLETION_NOTIFICATION_BODY_MAX_LENGTH = 280
const NATIVE_COMPLETION_NOTIFICATION_CHANNEL_ID = 'session-completions'

const DEFAULT_NOTIFICATION_SETTINGS: CompletionNotificationSettings = {
  completionNotificationsEnabled: false,
}

let nativeNotificationPermissionCache: NotificationPermission | 'unsupported' =
  isNativeApp() ? 'default' : 'unsupported'

const getHubPushClient = () => {
  const hubUrl = readHubUrl()
  if (!hubUrl) {
    throw new Error('尚未配置 Panda Hub 地址。')
  }

  return createClient(hubUrl)
}

const normalizeCompletionNotificationSettings = (
  settings: Partial<CompletionNotificationSettings> | null | undefined,
): CompletionNotificationSettings => ({
  completionNotificationsEnabled:
    settings?.completionNotificationsEnabled === true,
})

const truncateNotificationText = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`
}

const readStoredCompletionNotificationMap = (): StoredCompletionNotificationMap => {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(NOTIFIED_COMPLETIONS_STORAGE_KEY)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

const writeStoredCompletionNotificationMap = (
  completedAtBySessionId: StoredCompletionNotificationMap,
) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(
      NOTIFIED_COMPLETIONS_STORAGE_KEY,
      JSON.stringify(completedAtBySessionId),
    )
  } catch {
    // Ignore storage failures; notification dedupe is best-effort only.
  }
}

const normalizeStoredWebPushSubscriptionState = (
  value: unknown,
): StoredWebPushSubscriptionState | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const endpoint =
    typeof (value as { endpoint?: unknown }).endpoint === 'string'
      ? (value as { endpoint: string }).endpoint.trim()
      : ''
  const updatedAt =
    typeof (value as { updatedAt?: unknown }).updatedAt === 'string'
      ? (value as { updatedAt: string }).updatedAt.trim()
      : ''
  if (!endpoint || !updatedAt) {
    return null
  }

  return {
    completionNotificationsEnabled:
      (value as { completionNotificationsEnabled?: unknown })
        .completionNotificationsEnabled === true,
    endpoint,
    updatedAt,
  }
}

const readStoredWebPushSubscriptionState = () => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return normalizeStoredWebPushSubscriptionState(
      JSON.parse(
        window.localStorage.getItem(WEB_PUSH_SUBSCRIPTION_STATE_STORAGE_KEY) ??
          'null',
      ),
    )
  } catch {
    return null
  }
}

const writeStoredWebPushSubscriptionState = (
  state: StoredWebPushSubscriptionState,
) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(
      WEB_PUSH_SUBSCRIPTION_STATE_STORAGE_KEY,
      JSON.stringify(state),
    )
  } catch {
    // Ignore storage failures; backend push sync can recover next time.
  }
}

const clearStoredWebPushSubscriptionState = () => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.removeItem(WEB_PUSH_SUBSCRIPTION_STATE_STORAGE_KEY)
  } catch {
    // Ignore storage failures.
  }
}

const getServiceWorkerRegistration = async () => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('当前环境没有可用的 Service Worker。')
  }

  return navigator.serviceWorker.ready
}

const urlBase64ToUint8Array = (value: string) => {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)

  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index)
  }

  return output
}

const getBrowserPushSubscription = async () => {
  const registration = await getServiceWorkerRegistration()
  if (!('pushManager' in registration)) {
    return null
  }

  return registration.pushManager.getSubscription()
}

const serializePushSubscription = (subscription: PushSubscription) => {
  const json = subscription.toJSON()
  const endpoint = subscription.endpoint.trim()
  const p256dh =
    typeof json.keys?.p256dh === 'string' ? json.keys.p256dh.trim() : ''
  const auth = typeof json.keys?.auth === 'string' ? json.keys.auth.trim() : ''

  if (!endpoint || !p256dh || !auth) {
    throw new Error('浏览器返回的推送订阅信息不完整。')
  }

  return {
    endpoint,
    expirationTime:
      typeof subscription.expirationTime === 'number'
        ? subscription.expirationTime
        : null,
    keys: {
      p256dh,
      auth,
    },
  }
}

const resolveWebPushPublicConfig = async () => {
  try {
    return await getHubPushClient().getWebPushPublicConfig()
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : '无法读取 Hub Web Push 配置。',
    )
  }
}

export const readStoredCompletionNotificationSettings =
  (): CompletionNotificationSettings => {
    if (typeof window === 'undefined') {
      return DEFAULT_NOTIFICATION_SETTINGS
    }

    try {
      const raw = window.localStorage.getItem(NOTIFICATION_SETTINGS_STORAGE_KEY)
      if (!raw) {
        return DEFAULT_NOTIFICATION_SETTINGS
      }

      return normalizeCompletionNotificationSettings(
        JSON.parse(raw) as Partial<CompletionNotificationSettings>,
      )
    } catch {
      return DEFAULT_NOTIFICATION_SETTINGS
    }
  }

export const writeStoredCompletionNotificationSettings = (
  settings: CompletionNotificationSettings,
) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(
      NOTIFICATION_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalizeCompletionNotificationSettings(settings)),
    )
  } catch {
    // Ignore storage failures; notification settings are best-effort only.
  }
}

export const canUseCompletionNotifications = () => {
  if (isNativeApp()) {
    return true
  }

  if (typeof window === 'undefined') {
    return false
  }

  return (
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator
  )
}

export const canUseWebPushNotifications = () => {
  if (isNativeApp()) {
    return false
  }

  if (!canUseCompletionNotifications()) {
    return false
  }

  return 'PushManager' in window
}

export const readCompletionNotificationPermission = () => {
  if (isNativeApp()) {
    return nativeNotificationPermissionCache
  }

  if (!canUseCompletionNotifications()) {
    return 'unsupported' as const
  }

  return Notification.permission
}

const mapNativeNotificationPermission = (
  permission: string | undefined,
): NotificationPermission | 'unsupported' => {
  if (permission === 'granted') {
    return 'granted'
  }

  if (permission === 'denied') {
    return 'denied'
  }

  if (permission === 'prompt') {
    return 'default'
  }

  return 'unsupported'
}

const ensureNativeNotificationChannel = async () => {
  if (!isAndroidApp()) {
    return
  }

  await LocalNotifications.createChannel({
    id: NATIVE_COMPLETION_NOTIFICATION_CHANNEL_ID,
    name: '任务完成提醒',
    description: 'Panda 对话和任务完成提醒',
    importance: 4,
    visibility: 1,
    vibration: true,
    lights: true,
  }).catch(() => {
    // Re-creating an existing channel is harmless.
  })
}

export const refreshCompletionNotificationPermission = async () => {
  if (isNativeApp()) {
    const permissions = await LocalNotifications.checkPermissions()
    nativeNotificationPermissionCache = mapNativeNotificationPermission(
      permissions.display,
    )
    return nativeNotificationPermissionCache
  }

  if (!canUseCompletionNotifications()) {
    return 'unsupported' as const
  }

  return Notification.permission
}

export const requestCompletionNotificationPermission = async () => {
  if (isNativeApp()) {
    await ensureNativeNotificationChannel()
    const permissions = await LocalNotifications.requestPermissions()
    nativeNotificationPermissionCache = mapNativeNotificationPermission(
      permissions.display,
    )
    return nativeNotificationPermissionCache
  }

  if (!canUseCompletionNotifications()) {
    return 'unsupported' as const
  }

  return Notification.requestPermission()
}

export const readWebPushRegistrationHint = () =>
  readStoredWebPushSubscriptionState()

export const hasActiveWebPushRegistrationHint = () =>
  readStoredWebPushSubscriptionState()
    ?.completionNotificationsEnabled === true

export const syncCompletionWebPushSubscription = async (
  settings: CompletionNotificationSettings,
) => {
  if (
    !settings.completionNotificationsEnabled ||
    readCompletionNotificationPermission() !== 'granted'
  ) {
    return { synced: false as const, reason: 'notifications-disabled' as const }
  }

  if (!canUseWebPushNotifications()) {
    return { synced: false as const, reason: 'unsupported' as const }
  }

  const publicConfig = await resolveWebPushPublicConfig()
  if (!publicConfig.supported || !publicConfig.vapid_public_key) {
    clearStoredWebPushSubscriptionState()
    return { synced: false as const, reason: 'hub-unsupported' as const }
  }

  const subscription = await getBrowserPushSubscription()
  if (!subscription) {
    clearStoredWebPushSubscriptionState()
    return { synced: false as const, reason: 'missing-browser-subscription' as const }
  }

  const response = await getHubPushClient().upsertWebPushSubscription({
    subscription: serializePushSubscription(subscription),
    settings: {
      completion_notifications_enabled: settings.completionNotificationsEnabled,
    },
    device: {
      label: isPwaInstalled() ? 'installed-pwa' : 'browser-tab',
      user_agent:
        typeof navigator !== 'undefined' ? navigator.userAgent : null,
    },
  })

  writeStoredWebPushSubscriptionState({
    completionNotificationsEnabled: response.settings.completion_notifications_enabled,
    endpoint: response.endpoint,
    updatedAt: response.updated_at,
  })

  return { synced: true as const, endpoint: response.endpoint }
}

export const enableCompletionWebPushNotifications = async (
  settings: CompletionNotificationSettings,
) => {
  if (!canUseWebPushNotifications()) {
    throw new Error('当前环境不支持 Web Push。')
  }

  const publicConfig = await resolveWebPushPublicConfig()
  if (!publicConfig.supported || !publicConfig.vapid_public_key) {
    throw new Error(
      publicConfig.reason ?? 'Hub 当前没有可用的 Web Push 配置。',
    )
  }

  const registration = await getServiceWorkerRegistration()
  const existingSubscription =
    (await registration.pushManager.getSubscription()) ?? null
  const subscription =
    existingSubscription ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        publicConfig.vapid_public_key,
      ),
    }))

  const response = await getHubPushClient().upsertWebPushSubscription({
    subscription: serializePushSubscription(subscription),
    settings: {
      completion_notifications_enabled: settings.completionNotificationsEnabled,
    },
    device: {
      label: isPwaInstalled() ? 'installed-pwa' : 'browser-tab',
      user_agent:
        typeof navigator !== 'undefined' ? navigator.userAgent : null,
    },
  })

  writeStoredWebPushSubscriptionState({
    completionNotificationsEnabled: response.settings.completion_notifications_enabled,
    endpoint: response.endpoint,
    updatedAt: response.updated_at,
  })

  return response
}

export const disableCompletionWebPushNotifications = async () => {
  if (!canUseWebPushNotifications()) {
    clearStoredWebPushSubscriptionState()
    return { removed: false as const }
  }

  const subscription = await getBrowserPushSubscription()
  if (subscription) {
    try {
      await getHubPushClient().removeWebPushSubscription({
        endpoint: subscription.endpoint,
      })
    } catch {
      // Ignore server-side cleanup failures; browser unsubscribe still matters.
    }

    try {
      await subscription.unsubscribe()
    } catch {
      // Ignore browser unsubscribe failures; local state will be cleared.
    }
  }

  clearStoredWebPushSubscriptionState()
  return { removed: Boolean(subscription) }
}

export const sendCompletionWebPushTestNotification = async () => {
  if (!canUseWebPushNotifications()) {
    throw new Error('当前环境不支持 Web Push。')
  }

  if (readCompletionNotificationPermission() !== 'granted') {
    throw new Error('请先授予系统通知权限。')
  }

  const browserSubscription = await getBrowserPushSubscription()
  const hintedSubscription = readStoredWebPushSubscriptionState()
  const endpoint =
    browserSubscription?.endpoint?.trim() ||
    hintedSubscription?.endpoint?.trim() ||
    ''

  if (!endpoint) {
    throw new Error('当前设备还没有可用的 Web Push 订阅。')
  }

  await getHubPushClient().sendWebPushTest({ endpoint })
  return { ok: true as const, endpoint }
}

export const isPwaInstalled = () => {
  if (typeof window === 'undefined') {
    return false
  }

  const navigatorWithStandalone = navigator as NavigatorWithStandalone
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    navigatorWithStandalone.standalone === true
  )
}

export const isAndroidDevice = () => {
  if (typeof navigator === 'undefined') {
    return false
  }

  return /Android/i.test(navigator.userAgent)
}

export const formatCompletionNotificationBody = (
  value: string | null | undefined,
) => {
  if (typeof value !== 'string') {
    return ''
  }

  const normalized = value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  return truncateNotificationText(
    normalized,
    COMPLETION_NOTIFICATION_BODY_MAX_LENGTH,
  )
}

export const wasCompletionNotificationShown = (
  sessionId: string,
  completedAt: string,
) => readStoredCompletionNotificationMap()[sessionId] === completedAt

export const markCompletionNotificationShown = (
  sessionId: string,
  completedAt: string,
) => {
  const currentMap = readStoredCompletionNotificationMap()
  if (currentMap[sessionId] === completedAt) {
    return
  }

  writeStoredCompletionNotificationMap({
    ...currentMap,
    [sessionId]: completedAt,
  })
}

export const showCompletionNotification = async (input: {
  sessionId: string
  completedAt: string
  title: string
  body: string
  url: string
}) => {
  if (!canUseCompletionNotifications()) {
    return false
  }

  if (isNativeApp()) {
    if ((await refreshCompletionNotificationPermission()) !== 'granted') {
      return false
    }

    await ensureNativeNotificationChannel()

    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            id: Math.abs(
              Array.from(`${input.sessionId}:${input.completedAt}`).reduce(
                (hash, char) => (hash * 31 + char.charCodeAt(0)) | 0,
                17,
              ),
            ),
            title: input.title,
            body: input.body,
            channelId: NATIVE_COMPLETION_NOTIFICATION_CHANNEL_ID,
            schedule: {
              at: new Date(Date.now() + 250),
              allowWhileIdle: true,
            },
            extra: {
              url: input.url,
              sessionId: input.sessionId,
              completedAt: input.completedAt,
            },
          },
        ],
      })
      return true
    } catch {
      return false
    }
  }

  if (typeof window === 'undefined') {
    return false
  }

  const options: NotificationOptions = {
    body: input.body,
    tag: `session-completed:${input.sessionId}:${input.completedAt}`,
    icon: '/pwa-512.png',
    badge: '/pwa-192.png',
    data: {
      sessionId: input.sessionId,
      url: input.url,
      completedAt: input.completedAt,
    },
  }

  try {
    const registration = await navigator.serviceWorker.ready
    await registration.showNotification(input.title, options)
    return true
  } catch {
    try {
      const notification = new Notification(input.title, options)
      notification.onclick = () => {
        window.focus()
        window.location.assign(input.url)
      }
      return true
    } catch {
      return false
    }
  }
}

export const addCompletionNotificationOpenListener = async (
  onOpenUrl: (url: string) => void,
) => {
  if (!isNativeApp()) {
    return () => {}
  }

  const listener: PluginListenerHandle =
    await LocalNotifications.addListener(
      'localNotificationActionPerformed',
      (event) => {
        const url =
          typeof event.notification.extra?.url === 'string'
            ? event.notification.extra.url.trim()
            : ''
        if (url) {
          onOpenUrl(url)
        }
      },
    )

  return () => {
    void listener.remove()
  }
}
