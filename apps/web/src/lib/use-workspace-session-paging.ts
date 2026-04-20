import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceSessionDirectory } from '@panda/protocol'
import { resolveConnectionTarget, type ConnectionTargetScope } from './client'

const DEFAULT_WORKSPACE_SESSION_PAGE_LIMIT = 24

export type WorkspaceSessionPageState = {
  sessions: WorkspaceSessionDirectory[]
  nextCursor: string | null
  totalCount: number
  isLoading: boolean
  error: string | null
  initialized: boolean
}

type BucketState = Record<string, WorkspaceSessionPageState>

type UseWorkspaceSessionPagingOptions = {
  scope?: ConnectionTargetScope
  selectedSessionId?: string | null
}

export const EMPTY_WORKSPACE_SESSION_PAGE_STATE: WorkspaceSessionPageState = {
  sessions: [],
  nextCursor: null,
  totalCount: 0,
  isLoading: false,
  error: null,
  initialized: false,
}

const getProjectBucketKey = (projectId: string) => projectId.trim()

const sortSessionsByActivity = (sessions: WorkspaceSessionDirectory[]) =>
  [...sessions].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      +new Date(b.last_event_at) - +new Date(a.last_event_at),
  )

const mergeSessionPages = (
  current: WorkspaceSessionDirectory[],
  incoming: WorkspaceSessionDirectory[],
) => {
  const sessionById = new Map<string, WorkspaceSessionDirectory>()
  for (const session of current) {
    sessionById.set(session.id, session)
  }
  for (const session of incoming) {
    sessionById.set(session.id, session)
  }
  return sortSessionsByActivity([...sessionById.values()])
}

const readBucketPageState = (
  bucketState: BucketState,
  projectId: string,
): WorkspaceSessionPageState =>
  bucketState[getProjectBucketKey(projectId)] ?? EMPTY_WORKSPACE_SESSION_PAGE_STATE

export function useWorkspaceSessionPaging(options?: UseWorkspaceSessionPagingOptions) {
  const [historyState, setHistoryState] = useState<BucketState>({})
  const [archivedState, setArchivedState] = useState<BucketState>({})

  const reset = useCallback(() => {
    setHistoryState({})
    setArchivedState({})
  }, [])

  useEffect(() => {
    reset()
  }, [
    options?.scope?.agentId,
    options?.scope?.projectId,
    options?.scope?.sessionId,
    options?.selectedSessionId,
    reset,
  ])

  const loadPage = useCallback(
    async (bucket: 'history' | 'archived', projectId: string) => {
      const bucketKey = getProjectBucketKey(projectId)
      if (!bucketKey) {
        return
      }

      const stateSetter = bucket === 'history' ? setHistoryState : setArchivedState
      const currentState = readBucketPageState(
        bucket === 'history' ? historyState : archivedState,
        bucketKey,
      )

      if (currentState.isLoading) {
        return
      }

      if (currentState.initialized && currentState.nextCursor === null) {
        return
      }

      stateSetter((current) => ({
        ...current,
        [bucketKey]: {
          ...readBucketPageState(current, bucketKey),
          isLoading: true,
          error: null,
        },
      }))

      try {
        const target = await resolveConnectionTarget(options?.scope)
        const page = await target.client.getWorkspaceSessionPage({
          bucket,
          projectId: bucketKey,
          cursor: currentState.initialized ? currentState.nextCursor : null,
          limit: DEFAULT_WORKSPACE_SESSION_PAGE_LIMIT,
          selectedSessionId: options?.selectedSessionId ?? null,
        })

        stateSetter((current) => {
          const previousState = readBucketPageState(current, bucketKey)
          return {
            ...current,
            [bucketKey]: {
              sessions: mergeSessionPages(previousState.sessions, page.sessions),
              nextCursor: page.next_cursor,
              totalCount: page.total_count,
              isLoading: false,
              error: null,
              initialized: true,
            },
          }
        })
      } catch (error) {
        stateSetter((current) => ({
          ...current,
          [bucketKey]: {
            ...readBucketPageState(current, bucketKey),
            isLoading: false,
            error: error instanceof Error ? error.message : '加载会话分页失败',
            initialized: true,
          },
        }))
      }
    },
    [
      archivedState,
      historyState,
      options?.scope,
      options?.selectedSessionId,
    ],
  )

  const loadMoreHistory = useCallback(
    async (projectId: string) => {
      await loadPage('history', projectId)
    },
    [loadPage],
  )

  const loadMoreArchived = useCallback(
    async (projectId: string) => {
      await loadPage('archived', projectId)
    },
    [loadPage],
  )

  return {
    historyState,
    archivedState,
    loadMoreHistory,
    loadMoreArchived,
    reset,
  }
}
