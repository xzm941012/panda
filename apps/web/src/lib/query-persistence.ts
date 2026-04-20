import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryClient,
} from '@tanstack/react-query'

const PERSISTED_QUERY_CACHE_VERSION = 1
const PERSISTED_QUERY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const QUERY_PERSIST_DB_NAME = 'panda-web-cache'
const QUERY_PERSIST_STORE_NAME = 'app-state'
const QUERY_PERSIST_RECORD_KEY = 'react-query'
const STORAGE_PERSIST_RESULT_KEY = 'panda:storage-persist-result'
const PERSISTED_QUERY_ROOT_KEYS = new Set([
  'directory',
  'bootstrap',
  'timeline',
  'timeline-optimistic',
  'change-sets',
  'plan',
  'interactions',
  'codex-commands',
  'project-skills',
  'settings-connection',
])

type PersistedQueryCachePayload = {
  version: number
  persistedAt: number
  clientState: DehydratedState
}

const canUseBrowserPersistence = () =>
  typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined'

const shouldPersistQueryKey = (queryKey: readonly unknown[]) =>
  typeof queryKey[0] === 'string' && PERSISTED_QUERY_ROOT_KEYS.has(queryKey[0])

const openPersistenceDatabase = async () => {
  if (!canUseBrowserPersistence()) {
    return null
  }

  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(QUERY_PERSIST_DB_NAME, 1)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(QUERY_PERSIST_STORE_NAME)) {
        database.createObjectStore(QUERY_PERSIST_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open Panda cache database.'))
  })
}

const readPersistenceRecord = async () => {
  const database = await openPersistenceDatabase()
  if (!database) {
    return null
  }

  try {
    return await new Promise<PersistedQueryCachePayload | null>((resolve, reject) => {
      const transaction = database.transaction(QUERY_PERSIST_STORE_NAME, 'readonly')
      const store = transaction.objectStore(QUERY_PERSIST_STORE_NAME)
      const request = store.get(QUERY_PERSIST_RECORD_KEY)
      request.onsuccess = () =>
        resolve((request.result as PersistedQueryCachePayload | undefined) ?? null)
      request.onerror = () =>
        reject(request.error ?? new Error('Unable to read Panda cache record.'))
    })
  } finally {
    database.close()
  }
}

const writePersistenceRecord = async (payload: PersistedQueryCachePayload) => {
  const database = await openPersistenceDatabase()
  if (!database) {
    return
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(QUERY_PERSIST_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(QUERY_PERSIST_STORE_NAME)
      store.put(payload, QUERY_PERSIST_RECORD_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Unable to write Panda cache record.'))
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Writing Panda cache record was aborted.'))
    })
  } finally {
    database.close()
  }
}

export const clearPersistedQueryCache = async () => {
  if (!canUseBrowserPersistence()) {
    return
  }

  await new Promise<void>((resolve) => {
    const request = window.indexedDB.deleteDatabase(QUERY_PERSIST_DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

export const restorePersistedQueryCache = async (queryClient: QueryClient) => {
  if (!canUseBrowserPersistence()) {
    return
  }

  try {
    const payload = await readPersistenceRecord()
    if (!payload) {
      return
    }

    const isExpired = Date.now() - payload.persistedAt > PERSISTED_QUERY_CACHE_MAX_AGE_MS
    if (payload.version !== PERSISTED_QUERY_CACHE_VERSION || isExpired) {
      await clearPersistedQueryCache()
      return
    }

    hydrate(queryClient, payload.clientState)
  } catch {
    await clearPersistedQueryCache().catch(() => {})
  }
}

const persistBrowserStorageRequest = async () => {
  if (
    typeof navigator === 'undefined' ||
    typeof window === 'undefined' ||
    !('storage' in navigator) ||
    typeof navigator.storage.persist !== 'function'
  ) {
    return
  }

  try {
    const existingResult = window.localStorage.getItem(STORAGE_PERSIST_RESULT_KEY)
    if (existingResult) {
      return
    }

    const granted = await navigator.storage.persist()
    window.localStorage.setItem(STORAGE_PERSIST_RESULT_KEY, granted ? 'granted' : 'denied')
  } catch {
    // Ignore persistent-storage failures; regular storage still works best-effort.
  }
}

export const startPersistingQueryCache = (queryClient: QueryClient) => {
  if (typeof window === 'undefined') {
    return () => {}
  }

  void persistBrowserStorageRequest()

  let persistTimer: number | null = null
  let flushPromise: Promise<void> | null = null
  let flushQueued = false
  let stopped = false

  const flush = async () => {
    if (stopped) {
      return
    }

    if (flushPromise) {
      flushQueued = true
      return
    }

    flushPromise = (async () => {
      const clientState = dehydrate(queryClient, {
        shouldDehydrateQuery: (query) => shouldPersistQueryKey(query.queryKey),
      })

      await writePersistenceRecord({
        version: PERSISTED_QUERY_CACHE_VERSION,
        persistedAt: Date.now(),
        clientState,
      })
    })()

    try {
      await flushPromise
    } catch {
      // Ignore persistence failures; in-memory cache remains authoritative.
    } finally {
      flushPromise = null
      if (flushQueued) {
        flushQueued = false
        void flush()
      }
    }
  }

  const scheduleFlush = (immediate = false) => {
    if (stopped) {
      return
    }

    if (persistTimer !== null) {
      window.clearTimeout(persistTimer)
      persistTimer = null
    }

    if (immediate) {
      void flush()
      return
    }

    persistTimer = window.setTimeout(() => {
      persistTimer = null
      void flush()
    }, 1200)
  }

  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    scheduleFlush(false)
  })

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      scheduleFlush(true)
    }
  }
  const handlePageHide = () => {
    scheduleFlush(true)
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', handlePageHide)

  return () => {
    stopped = true
    unsubscribe()
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('pagehide', handlePageHide)
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer)
      persistTimer = null
    }
  }
}
