/// <reference lib="webworker" />

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{
    revision: string | null
    url: string
  }>
}

type PushNotificationPayload = {
  title?: string
  body?: string
  url?: string
  tag?: string
  sessionId?: string | null
}

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

self.addEventListener('push', (event) => {
  const payload = (() => {
    try {
      return (event.data?.json() as PushNotificationPayload | undefined) ?? {}
    } catch {
      return {}
    }
  })()

  const normalizedUrl = (() => {
    try {
      return new URL(payload.url ?? '/', self.location.origin).toString()
    } catch {
      return self.location.origin
    }
  })()

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      const hasVisibleMatchingClient = windowClients.some((client) => {
        if ('visibilityState' in client && client.visibilityState === 'visible') {
          return client.url === normalizedUrl
        }

        return false
      })

      if (hasVisibleMatchingClient) {
        return
      }

      await self.registration.showNotification(payload.title ?? 'Panda', {
        body: payload.body ?? '点开查看最新会话进展。',
        tag: payload.tag ?? 'panda-web-push',
        icon: '/pwa-512.png',
        badge: '/pwa-192.png',
        data: {
          url: normalizedUrl,
          sessionId: payload.sessionId ?? null,
        },
      })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  const targetUrl =
    typeof event.notification.data?.url === 'string'
      ? event.notification.data.url
      : self.location.origin

  event.notification.close()
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      for (const client of windowClients) {
        if ('focus' in client) {
          if (client.url === targetUrl) {
            await client.focus()
            return
          }

          if ('navigate' in client) {
            await client.navigate(targetUrl)
            await client.focus()
            return
          }
        }
      }

      await self.clients.openWindow(targetUrl)
    })(),
  )
})
