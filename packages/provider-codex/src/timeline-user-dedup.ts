import { mergeTimelineAttachments, type TimelineEntry } from '@panda/protocol'

const normalizeTimelineEntryBody = (entry: Pick<TimelineEntry, 'body'>) =>
  entry.body.replace(/\r\n/g, '\n').trim()

const areAdjacentDuplicateUserEntries = (
  previous: TimelineEntry | undefined,
  next: TimelineEntry,
  maxSkewMs: number,
) => {
  if (!previous || previous.kind !== 'user' || next.kind !== 'user') {
    return false
  }

  if (normalizeTimelineEntryBody(previous) !== normalizeTimelineEntryBody(next)) {
    return false
  }

  const previousTime = +new Date(previous.timestamp)
  const nextTime = +new Date(next.timestamp)
  if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime)) {
    return true
  }

  return Math.abs(nextTime - previousTime) <= maxSkewMs
}

export const collapseDuplicateUserEntries = (
  entries: TimelineEntry[],
  options?: {
    maxSkewMs?: number
  },
) => {
  const maxSkewMs = options?.maxSkewMs ?? 5_000
  const collapsed: TimelineEntry[] = []

  for (const entry of entries) {
    const previous = collapsed[collapsed.length - 1]
    if (!areAdjacentDuplicateUserEntries(previous, entry, maxSkewMs)) {
      collapsed.push(entry)
      continue
    }

    collapsed[collapsed.length - 1] = {
      ...entry,
      attachments: mergeTimelineAttachments(previous?.attachments, entry.attachments),
    }
  }

  return collapsed
}
