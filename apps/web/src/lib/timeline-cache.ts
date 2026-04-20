import {
  mergeTimelineAttachments,
  type SessionTimelineSnapshot,
  type TimelineEntry,
} from '@panda/protocol'

export const OPTIMISTIC_USER_ENTRY_PREFIX = 'optimistic-user:'
const OVERLAY_USER_ENTRY_PREFIX = 'overlay-user:'
const REPLACEABLE_USER_ENTRY_PREFIXES = [
  OPTIMISTIC_USER_ENTRY_PREFIX,
  OVERLAY_USER_ENTRY_PREFIX,
] as const
const USER_ENTRY_MATCH_EARLY_SKEW_MS = 5_000

export const getTimelineOptimisticQueryKey = (sessionId: string) =>
  ['timeline-optimistic', sessionId] as const

const isReplaceableUserEntry = (entry: TimelineEntry) =>
  entry.kind === 'user' &&
  REPLACEABLE_USER_ENTRY_PREFIXES.some((prefix) => entry.id.startsWith(prefix))

const isAuthoritativeUserEntry = (entry: TimelineEntry) =>
  entry.kind === 'user' && !isReplaceableUserEntry(entry)

const isOptimisticUserEntry = (entry: TimelineEntry) =>
  entry.kind === 'user' && entry.id.startsWith(OPTIMISTIC_USER_ENTRY_PREFIX)

const isOptimisticMatchSourceUserEntry = (entry: TimelineEntry) =>
  entry.kind === 'user' && !isOptimisticUserEntry(entry)

const normalizeUserEntryBody = (entry: Pick<TimelineEntry, 'body'>) =>
  entry.body.replace(/\r\n/g, '\n').trim()

const getTimestampMs = (value: string) => new Date(value).getTime()

const canMatchUserEntries = (
  replaceableEntry: Pick<TimelineEntry, 'body' | 'timestamp'>,
  authoritativeEntry: Pick<TimelineEntry, 'body' | 'timestamp'>,
) => {
  if (normalizeUserEntryBody(replaceableEntry) !== normalizeUserEntryBody(authoritativeEntry)) {
    return false
  }

  const replaceableTime = getTimestampMs(replaceableEntry.timestamp)
  const authoritativeTime = getTimestampMs(authoritativeEntry.timestamp)
  if (!Number.isFinite(replaceableTime) || !Number.isFinite(authoritativeTime)) {
    return true
  }

  return authoritativeTime >= replaceableTime - USER_ENTRY_MATCH_EARLY_SKEW_MS
}

const collectMatchedReplaceableUserEntryIds = (
  replaceableEntries: TimelineEntry[] | undefined,
  authoritativeEntries: TimelineEntry[],
) => {
  const authoritativeUsers = authoritativeEntries.filter(isAuthoritativeUserEntry)
  if (authoritativeUsers.length === 0) {
    return new Set<string>()
  }

  const usedAuthoritativeIndexes = new Set<number>()
  const matchedIds = new Set<string>()

  for (const entry of replaceableEntries ?? []) {
    if (!isReplaceableUserEntry(entry)) {
      continue
    }

    const matchedIndex = authoritativeUsers.findIndex(
      (authoritativeEntry, index) =>
        !usedAuthoritativeIndexes.has(index) &&
        canMatchUserEntries(entry, authoritativeEntry),
    )

    if (matchedIndex < 0) {
      continue
    }

    usedAuthoritativeIndexes.add(matchedIndex)
    matchedIds.add(entry.id)
  }

  return matchedIds
}

const collectReplaceableAttachmentMerges = (
  replaceableEntries: TimelineEntry[] | undefined,
  authoritativeEntries: TimelineEntry[],
) => {
  const authoritativeUsers = authoritativeEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isAuthoritativeUserEntry(entry))

  if (authoritativeUsers.length === 0) {
    return new Map<number, TimelineEntry['attachments']>()
  }

  const usedAuthoritativeIndexes = new Set<number>()
  const merges = new Map<number, TimelineEntry['attachments']>()

  for (const entry of replaceableEntries ?? []) {
    if (!isReplaceableUserEntry(entry)) {
      continue
    }

    const matched = authoritativeUsers.find(
      ({ entry: authoritativeEntry, index }) =>
        !usedAuthoritativeIndexes.has(index) &&
        canMatchUserEntries(entry, authoritativeEntry),
    )

    if (!matched) {
      continue
    }

    usedAuthoritativeIndexes.add(matched.index)
    if ((entry.attachments ?? []).length === 0) {
      continue
    }

    merges.set(
      matched.index,
      mergeTimelineAttachments(matched.entry.attachments, entry.attachments),
    )
  }

  return merges
}

const collectMatchedOptimisticUserEntryIds = (
  optimisticEntries: TimelineEntry[] | undefined,
  authoritativeEntries: TimelineEntry[],
) => {
  const authoritativeUsers = authoritativeEntries.filter(isOptimisticMatchSourceUserEntry)
  if (authoritativeUsers.length === 0) {
    return new Set<string>()
  }

  const usedAuthoritativeIndexes = new Set<number>()
  const matchedIds = new Set<string>()

  for (const entry of optimisticEntries ?? []) {
    if (!isOptimisticUserEntry(entry)) {
      continue
    }

    const matchedIndex = authoritativeUsers.findIndex(
      (authoritativeEntry, index) =>
        !usedAuthoritativeIndexes.has(index) &&
        canMatchUserEntries(entry, authoritativeEntry),
    )

    if (matchedIndex < 0) {
      continue
    }

    usedAuthoritativeIndexes.add(matchedIndex)
    matchedIds.add(entry.id)
  }

  return matchedIds
}

const collapseReplaceableUserEntries = (
  entries: TimelineEntry[] | undefined,
) => {
  const nextEntries = [...(entries ?? [])]
  const authoritativeUsers = nextEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isAuthoritativeUserEntry(entry))

  if (authoritativeUsers.length === 0) {
    return nextEntries
  }

  const usedAuthoritativeIndexes = new Set<number>()
  const replacedIds = new Set<string>()

  for (const entry of nextEntries) {
    if (!isReplaceableUserEntry(entry)) {
      continue
    }

    const matched = authoritativeUsers.find(
      ({ entry: authoritativeEntry, index }) =>
        !usedAuthoritativeIndexes.has(index) &&
        canMatchUserEntries(entry, authoritativeEntry),
    )

    if (!matched) {
      continue
    }

    usedAuthoritativeIndexes.add(matched.index)
    replacedIds.add(entry.id)
  }

  if (replacedIds.size === 0) {
    return nextEntries
  }

  return nextEntries.filter((entry) => !replacedIds.has(entry.id))
}

export const appendTimelineEntry = (
  entries: TimelineEntry[] | undefined,
  nextEntry: TimelineEntry,
) => [...(entries ?? []), nextEntry]

export const mergeTimelineEntries = (
  currentEntries: TimelineEntry[] | undefined,
  incomingEntries: TimelineEntry[],
) => {
  const attachmentMerges = collectReplaceableAttachmentMerges(
    currentEntries,
    incomingEntries,
  )
  const matchedReplaceableIds = collectMatchedReplaceableUserEntryIds(
    currentEntries,
    incomingEntries,
  )

  const nextEntries = [...(currentEntries ?? [])].filter((entry) => {
    return !matchedReplaceableIds.has(entry.id)
  })
  const seenIds = new Set(nextEntries.map((entry) => entry.id))

  for (const [index, entry] of incomingEntries.entries()) {
    if (seenIds.has(entry.id)) {
      continue
    }

    seenIds.add(entry.id)
    nextEntries.push(
      attachmentMerges.has(index)
        ? {
            ...entry,
            attachments: attachmentMerges.get(index) ?? entry.attachments,
          }
        : entry,
    )
  }

  return nextEntries
}

export const reconcileResetTimelineEntries = (
  currentEntries: TimelineEntry[] | undefined,
  nextEntries: TimelineEntry[],
) => {
  return [...mergeTimelineEntries(currentEntries, nextEntries)].sort((left, right) => {
    const leftTime = new Date(left.timestamp).getTime()
    const rightTime = new Date(right.timestamp).getTime()

    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
      return 0
    }

    return leftTime - rightTime
  })
}

export const reconcileOptimisticTimelineEntries = (
  optimisticEntries: TimelineEntry[] | undefined,
  authoritativeEntries: TimelineEntry[],
) =>
  (optimisticEntries ?? []).filter(
    (entry) =>
      isOptimisticUserEntry(entry) &&
      !collectMatchedOptimisticUserEntryIds([entry], authoritativeEntries).has(entry.id),
  )

export const mergeDisplayedTimelineEntries = (
  authoritativeEntries: TimelineEntry[] | undefined,
  optimisticEntries: TimelineEntry[] | undefined,
) => {
  const collapsedAuthoritativeEntries = collapseReplaceableUserEntries(authoritativeEntries)
  const remainingOptimisticEntries = reconcileOptimisticTimelineEntries(
    optimisticEntries,
    collapsedAuthoritativeEntries,
  )

  return reconcileResetTimelineEntries(
    remainingOptimisticEntries,
    collapsedAuthoritativeEntries,
  )
}

export const mergeSessionTimelineSnapshots = (
  currentSnapshot: SessionTimelineSnapshot | undefined,
  incomingSnapshot: SessionTimelineSnapshot,
): SessionTimelineSnapshot => {
  if (!currentSnapshot || currentSnapshot.session_id !== incomingSnapshot.session_id) {
    return {
      ...incomingSnapshot,
      entries: reconcileResetTimelineEntries(undefined, incomingSnapshot.entries),
    }
  }

  const shouldPreserveExpandedHistory =
    currentSnapshot.view === 'full_compact' && incomingSnapshot.view === 'tail'
  const mergedEntries = reconcileResetTimelineEntries(
    shouldPreserveExpandedHistory ? currentSnapshot.entries : currentSnapshot.entries,
    incomingSnapshot.entries,
  )

  return {
    session_id: incomingSnapshot.session_id,
    generated_at: incomingSnapshot.generated_at,
    view: shouldPreserveExpandedHistory ? currentSnapshot.view : incomingSnapshot.view,
    anchor_entry_id:
      shouldPreserveExpandedHistory
        ? currentSnapshot.anchor_entry_id ?? incomingSnapshot.anchor_entry_id
        : incomingSnapshot.anchor_entry_id,
    has_earlier_entries:
      shouldPreserveExpandedHistory
        ? false
        : incomingSnapshot.has_earlier_entries,
    entries: mergedEntries,
  }
}

export const removeOptimisticTimelineEntry = (
  entries: TimelineEntry[] | undefined,
  optimisticEntryId: string,
) => (entries ?? []).filter((entry) => entry.id !== optimisticEntryId)
