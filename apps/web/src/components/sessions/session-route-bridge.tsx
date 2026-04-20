import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { WorkspaceDirectorySnapshot } from '@panda/protocol'
import { WORKSPACE_DIRECTORY_QUERY_KEY } from '../../lib/bootstrap-query'
import {
  queuePendingSessionId,
  readPendingSessionHandoff,
  readStoredAgentId,
  writeStoredAgentId,
  writeStoredSessionId,
} from '../../lib/session-selection'
import { useSnapshot } from '../../lib/use-snapshot'

const findCachedSessionAgentId = (
  snapshots: Array<[readonly unknown[], WorkspaceDirectorySnapshot | undefined]>,
  sessionId: string,
) => {
  for (const [, snapshot] of snapshots) {
    const matchedSession = snapshot?.sessions.find((session) => session.id === sessionId)
    if (matchedSession?.agent_id) {
      return matchedSession.agent_id
    }
  }

  return null
}

export const SessionRouteBridge = () => {
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string }
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pendingSessionHandoff = readPendingSessionHandoff(sessionId)
  const snapshotQuery = useSnapshot({
    queryKey: ['session-route-bridge', sessionId ?? ''],
  })

  const cachedSessionAgentId = sessionId
    ? findCachedSessionAgentId(
        queryClient.getQueriesData<WorkspaceDirectorySnapshot>({
          queryKey: WORKSPACE_DIRECTORY_QUERY_KEY,
        }),
        sessionId,
      )
    : null
  const snapshotSessionAgentId =
    sessionId
      ? snapshotQuery.data?.sessions.find((session) => session.id === sessionId)?.agent_id ?? null
      : null
  const resolvedAgentId =
    pendingSessionHandoff?.agentId ??
    cachedSessionAgentId ??
    snapshotSessionAgentId ??
    readStoredAgentId()

  useEffect(() => {
    if (!sessionId) {
      void navigate({ to: '/', replace: true })
      return
    }

    if (!resolvedAgentId && (snapshotQuery.isPending || snapshotQuery.isFetching)) {
      return
    }

    writeStoredSessionId(sessionId)
    queuePendingSessionId(sessionId)
    if (resolvedAgentId) {
      writeStoredAgentId(resolvedAgentId)
    }

    void navigate({ to: '/', replace: true })
  }, [
    navigate,
    resolvedAgentId,
    sessionId,
    snapshotQuery.isFetching,
    snapshotQuery.isPending,
  ])

  return null
}
