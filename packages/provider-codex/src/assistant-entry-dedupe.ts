import type { TimelineEntry } from '@panda/protocol'

type AssistantEntryCandidate = Pick<
  TimelineEntry,
  'kind' | 'title' | 'body' | 'timestamp' | 'accent'
> & {
  attachments?: TimelineEntry['attachments']
  body_truncated?: TimelineEntry['body_truncated']
  detail_available?: TimelineEntry['detail_available']
  patch_summary?: TimelineEntry['patch_summary']
  session_ids?: TimelineEntry['session_ids']
}

const ASSISTANT_DUPLICATE_WINDOW_MS = 5_000

const normalizeTimelineEntryBody = (value: string) =>
  value.replace(/\r\n/g, '\n').trim()

const normalizeTimelineEntryTitle = (value: string) => value.trim().toLowerCase()

const isGenericAssistantTitle = (value: string) =>
  normalizeTimelineEntryTitle(value) === 'assistant'

const toFiniteTimestamp = (value: string) => {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

export const areMergeableAssistantEntries = (
  previous: AssistantEntryCandidate | undefined,
  next: AssistantEntryCandidate,
) => {
  if (previous?.kind !== 'assistant' || next.kind !== 'assistant') {
    return false
  }

  const previousBody = normalizeTimelineEntryBody(previous.body)
  const nextBody = normalizeTimelineEntryBody(next.body)
  if (!previousBody || previousBody !== nextBody) {
    return false
  }

  const previousTitle = normalizeTimelineEntryTitle(previous.title)
  const nextTitle = normalizeTimelineEntryTitle(next.title)
  const titlesCompatible =
    previousTitle === nextTitle ||
    isGenericAssistantTitle(previous.title) ||
    isGenericAssistantTitle(next.title)
  if (!titlesCompatible) {
    return false
  }

  const previousTime = toFiniteTimestamp(previous.timestamp)
  const nextTime = toFiniteTimestamp(next.timestamp)
  if (previousTime === null || nextTime === null) {
    return previousTitle === nextTitle
  }

  return Math.abs(nextTime - previousTime) <= ASSISTANT_DUPLICATE_WINDOW_MS
}

export const choosePreferredAssistantEntry = (
  previous: TimelineEntry,
  next: AssistantEntryCandidate,
): TimelineEntry => {
  const previousHasSpecificTitle = !isGenericAssistantTitle(previous.title)
  const nextHasSpecificTitle = !isGenericAssistantTitle(next.title)

  if (previousHasSpecificTitle && !nextHasSpecificTitle) {
    return previous
  }

  if (nextHasSpecificTitle && !previousHasSpecificTitle) {
    return {
      id: previous.id,
      kind: next.kind,
      title: next.title,
      body: next.body,
      body_truncated: next.body_truncated ?? previous.body_truncated,
      detail_available: next.detail_available ?? previous.detail_available,
      patch_summary: next.patch_summary ?? previous.patch_summary,
      session_ids: next.session_ids ?? previous.session_ids,
      timestamp: next.timestamp,
      accent: next.accent,
      attachments: next.attachments ?? previous.attachments ?? [],
    }
  }

  const previousTime = toFiniteTimestamp(previous.timestamp)
  const nextTime = toFiniteTimestamp(next.timestamp)
  if (
    previousTime !== null &&
    nextTime !== null &&
    previousTime > nextTime
  ) {
    return previous
  }

  return {
    id: previous.id,
    kind: next.kind,
    title: next.title,
    body: next.body,
    body_truncated: next.body_truncated ?? previous.body_truncated,
    detail_available: next.detail_available ?? previous.detail_available,
    patch_summary: next.patch_summary ?? previous.patch_summary,
    session_ids: next.session_ids ?? previous.session_ids,
    timestamp: next.timestamp,
    accent: next.accent,
    attachments: next.attachments ?? previous.attachments ?? [],
  }
}
