import { clearPersistedQueryCache } from './query-persistence'

export const clearSiteData = async () => {
  await clearPersistedQueryCache().catch(() => {})

  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((registration) => registration.unregister()))
  }

  if ('caches' in window) {
    const cacheKeys = await window.caches.keys()
    await Promise.all(cacheKeys.map((cacheKey) => window.caches.delete(cacheKey)))
  }

  const indexedDbApi = window.indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>
  }

  if (typeof indexedDbApi.databases === 'function') {
    const databases = await indexedDbApi.databases()
    await Promise.all(
      databases
        .map((database) => database.name)
        .filter((name): name is string => Boolean(name))
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const request = indexedDbApi.deleteDatabase(name)
              request.onsuccess = () => resolve()
              request.onerror = () => resolve()
              request.onblocked = () => resolve()
            }),
        ),
    )
  }

  window.localStorage.clear()
  window.sessionStorage.clear()
}
