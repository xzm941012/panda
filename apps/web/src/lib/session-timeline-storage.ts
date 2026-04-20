import type { SessionTimelineSnapshot } from '@panda/protocol'

const SESSION_TIMELINE_STORAGE_KEY = 'panda:session-timeline-snapshots'
const SESSION_TIMELINE_STORAGE_VERSION = 1
const SESSION_TIMELINE_TTL_MS = 24 * 60 * 60 * 1000
const SESSION_TIMELINE_MAX_ITEMS = 12

const SESSION_AUTO_SCROLL_STORAGE_KEY = 'panda:session-initial-scroll'
const SESSION_AUTO_SCROLL_STORAGE_VERSION = 1
const SESSION_AUTO_SCROLL_TTL_MS = 14 * 24 * 60 * 60 * 1000
const SESSION_AUTO_SCROLL_MAX_ITEMS = 40

type StoredTimelineEntry = {
  sessionId: string
  storedAt: number
  snapshot: SessionTimelineSnapshot
}

type StoredTimelineState = {
  version: number
  items: StoredTimelineEntry[]
}

type StoredSessionMarker = {
  sessionId: string
  storedAt: number
}

type StoredSessionMarkerState = {
  version: number
  items: StoredSessionMarker[]
}

const readStorageJson = <T,>(key: string): T | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return null
    }

    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const writeStorageJson = (key: string, value: unknown) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore best-effort storage failures.
  }
}

const pruneSessionMarkers = (
  items: StoredSessionMarker[],
  options: {
    now: number
    ttlMs: number
    maxItems: number
  },
) =>
  items
    .filter((item) => options.now - item.storedAt <= options.ttlMs)
    .sort((left, right) => right.storedAt - left.storedAt)
    .slice(0, options.maxItems)

const readTimelineState = () => {
  const state = readStorageJson<StoredTimelineState>(SESSION_TIMELINE_STORAGE_KEY)
  if (!state || state.version !== SESSION_TIMELINE_STORAGE_VERSION || !Array.isArray(state.items)) {
    return {
      version: SESSION_TIMELINE_STORAGE_VERSION,
      items: [] as StoredTimelineEntry[],
    }
  }

  const now = Date.now()
  const items = state.items
    .filter((item) =>
      Boolean(
        item &&
        typeof item.sessionId === 'string' &&
        typeof item.storedAt === 'number' &&
        item.snapshot &&
        typeof item.snapshot === 'object',
      ),
    )
    .filter((item) => now - item.storedAt <= SESSION_TIMELINE_TTL_MS)
    .sort((left, right) => right.storedAt - left.storedAt)
    .slice(0, SESSION_TIMELINE_MAX_ITEMS)

  return {
    version: SESSION_TIMELINE_STORAGE_VERSION,
    items,
  }
}

export const readStoredSessionTimelineSnapshot = (sessionId: string) => {
  const state = readTimelineState()
  const match = state.items.find((item) => item.sessionId === sessionId)
  if (!match) {
    return null
  }

  return match.snapshot
}

export const writeStoredSessionTimelineSnapshot = (snapshot: SessionTimelineSnapshot | null) => {
  if (!snapshot || snapshot.view !== 'full_compact') {
    return
  }

  const now = Date.now()
  const state = readTimelineState()
  const nextItems = [
    {
      sessionId: snapshot.session_id,
      storedAt: now,
      snapshot,
    },
    ...state.items.filter((item) => item.sessionId !== snapshot.session_id),
  ].slice(0, SESSION_TIMELINE_MAX_ITEMS)

  writeStorageJson(SESSION_TIMELINE_STORAGE_KEY, {
    version: SESSION_TIMELINE_STORAGE_VERSION,
    items: nextItems,
  } satisfies StoredTimelineState)
}

const readAutoScrollState = () => {
  const state = readStorageJson<StoredSessionMarkerState>(SESSION_AUTO_SCROLL_STORAGE_KEY)
  if (
    !state ||
    state.version !== SESSION_AUTO_SCROLL_STORAGE_VERSION ||
    !Array.isArray(state.items)
  ) {
    return {
      version: SESSION_AUTO_SCROLL_STORAGE_VERSION,
      items: [] as StoredSessionMarker[],
    }
  }

  return {
    version: SESSION_AUTO_SCROLL_STORAGE_VERSION,
    items: pruneSessionMarkers(state.items, {
      now: Date.now(),
      ttlMs: SESSION_AUTO_SCROLL_TTL_MS,
      maxItems: SESSION_AUTO_SCROLL_MAX_ITEMS,
    }),
  }
}

export const hasSessionInitialAutoScroll = (sessionId: string) =>
  readAutoScrollState().items.some((item) => item.sessionId === sessionId)

export const markSessionInitialAutoScroll = (sessionId: string) => {
  const now = Date.now()
  const state = readAutoScrollState()
  const items = pruneSessionMarkers(
    [
      {
        sessionId,
        storedAt: now,
      },
      ...state.items.filter((item) => item.sessionId !== sessionId),
    ],
    {
      now,
      ttlMs: SESSION_AUTO_SCROLL_TTL_MS,
      maxItems: SESSION_AUTO_SCROLL_MAX_ITEMS,
    },
  )

  writeStorageJson(SESSION_AUTO_SCROLL_STORAGE_KEY, {
    version: SESSION_AUTO_SCROLL_STORAGE_VERSION,
    items,
  } satisfies StoredSessionMarkerState)
}
