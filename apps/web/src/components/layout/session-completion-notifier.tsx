import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HubRecentSessionsSnapshot, SessionRef, SocketEvent } from '@panda/protocol'
import { resolveConnectionTarget } from '../../lib/client'
import { syncHubRecentSessions } from '../../lib/directory-sync'
import {
  formatCompletionNotificationBody,
  hasActiveWebPushRegistrationHint,
  markCompletionNotificationShown,
  readCompletionNotificationPermission,
  readStoredCompletionNotificationSettings,
  showCompletionNotification,
  wasCompletionNotificationShown,
} from '../../lib/notifications'
import { isNativeApp } from '../../lib/platform'
import {
  readSelectedAgentConnectionHint,
  readStoredAgentId,
  readStoredSessionId,
} from '../../lib/session-selection'

type CompletionNotificationCandidate = {
  sessionId: string
  completedAt: string
  sessionTitle: string
  finalReply: string
}

const SNAPSHOT_REFRESH_DEBOUNCE_MS = 1200

const isVisibleCurrentSession = (sessionId: string) => {
  if (typeof document === 'undefined') {
    return false
  }

  return (
    document.visibilityState === 'visible' &&
    readStoredSessionId() === sessionId
  )
}

const readSessionTitle = (session: Pick<SessionRef, 'title'> | null | undefined) =>
  session?.title?.trim() || '当前会话'

const readCompletionTimestamp = (
  session: Pick<SessionRef, 'run_state' | 'run_state_changed_at'>,
) => {
  if (session.run_state !== 'completed') {
    return null
  }

  const completedAt =
    typeof session.run_state_changed_at === 'string'
      ? session.run_state_changed_at.trim()
      : ''
  return completedAt || null
}

const buildTurnCompletedCandidate = (
  payload: Record<string, unknown> | undefined,
  snapshot: HubRecentSessionsSnapshot | undefined,
): CompletionNotificationCandidate | null => {
  if (!payload) {
    return null
  }

  const completionReason =
    typeof payload.completionReason === 'string'
      ? payload.completionReason
      : 'completed'
  if (completionReason !== 'completed') {
    return null
  }

  const sessionId =
    typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
  const completedAt =
    typeof payload.completedAt === 'string' ? payload.completedAt.trim() : ''
  if (!sessionId || !completedAt) {
    return null
  }

  const session = snapshot?.recent_sessions.find((item) => item.id === sessionId) ?? null
  const sessionTitle =
    (typeof payload.sessionTitle === 'string' && payload.sessionTitle.trim()) ||
    readSessionTitle(session)
  const finalReply =
    (typeof payload.finalReply === 'string' ? payload.finalReply : '') ||
    session?.latest_assistant_message ||
    ''

  return {
    sessionId,
    completedAt,
    sessionTitle,
    finalReply,
  }
}

const buildSnapshotCompletionCandidates = (
  previousSnapshot: HubRecentSessionsSnapshot | undefined,
  nextSnapshot: HubRecentSessionsSnapshot,
) => {
  const previousSessions = new Map(
    (previousSnapshot?.recent_sessions ?? []).map((session) => [session.id, session]),
  )

  return nextSnapshot.recent_sessions.flatMap((session) => {
    const completedAt = readCompletionTimestamp(session)
    if (!completedAt) {
      return []
    }

    const finalReply = session.latest_assistant_message?.trim() ?? ''
    if (!finalReply) {
      return []
    }

    const previousSession = previousSessions.get(session.id)
    if (
      previousSession?.run_state === 'completed' &&
      previousSession.run_state_changed_at === completedAt
    ) {
      return []
    }

    return [
      {
        sessionId: session.id,
        completedAt,
        sessionTitle: readSessionTitle(session),
        finalReply,
      },
    ]
  })
}

const applyRecentSessionPatch = (
  snapshot: HubRecentSessionsSnapshot | undefined,
  sessionId: string,
  patch: Record<string, unknown> | null | undefined,
) => {
  if (!snapshot || !patch) {
    return snapshot
  }

  let changed = false
  const nextSessions = snapshot.recent_sessions.map((session) => {
    if (session.id !== sessionId) {
      return session
    }

    const nextRunState =
      patch.run_state === 'idle' || patch.run_state === 'running' || patch.run_state === 'completed'
        ? patch.run_state
        : null
    const nextSession: HubRecentSessionsSnapshot['recent_sessions'][number] = {
      ...session,
      ...(typeof patch.title === 'string' ? { title: patch.title } : null),
      ...(nextRunState ? { run_state: nextRunState } : null),
      ...(patch.run_state_changed_at === null || typeof patch.run_state_changed_at === 'string'
        ? { run_state_changed_at: patch.run_state_changed_at }
        : null),
      ...(patch.latest_assistant_message === null || typeof patch.latest_assistant_message === 'string'
        ? { latest_assistant_message: patch.latest_assistant_message }
        : null),
    }

    changed =
      changed ||
      nextSession.title !== session.title ||
      nextSession.run_state !== session.run_state ||
      nextSession.run_state_changed_at !== session.run_state_changed_at ||
      nextSession.latest_assistant_message !== session.latest_assistant_message

    return nextSession
  })

  if (!changed) {
    return snapshot
  }

  return {
    ...snapshot,
    recent_sessions: nextSessions,
  }
}

export const SessionCompletionNotifier = ({
}: {}) => {
  const queryClient = useQueryClient()
  const snapshotRef = useRef<HubRecentSessionsSnapshot | undefined>(undefined)
  const pendingNotificationKeysRef = useRef(new Set<string>())
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshInFlightRef = useRef(false)
  const selectedAgentId = readStoredAgentId()
  const selectedAgentConnectionHint = readSelectedAgentConnectionHint(selectedAgentId)
  const scopedAgentId =
    selectedAgentId && selectedAgentConnectionHint
      ? selectedAgentId
      : null

  useEffect(() => {
    const maybeShowNotification = async (
      candidate: CompletionNotificationCandidate,
    ) => {
      const settings = readStoredCompletionNotificationSettings()
      if (!isNativeApp() && !settings.completionNotificationsEnabled) {
        return
      }

      if (readCompletionNotificationPermission() !== 'granted') {
        return
      }

      if (hasActiveWebPushRegistrationHint()) {
        markCompletionNotificationShown(candidate.sessionId, candidate.completedAt)
        return
      }

      const notificationKey = `${candidate.sessionId}:${candidate.completedAt}`
      if (pendingNotificationKeysRef.current.has(notificationKey)) {
        return
      }

      if (
        wasCompletionNotificationShown(candidate.sessionId, candidate.completedAt)
      ) {
        return
      }

      if (isVisibleCurrentSession(candidate.sessionId)) {
        markCompletionNotificationShown(candidate.sessionId, candidate.completedAt)
        return
      }

      pendingNotificationKeysRef.current.add(notificationKey)
      try {
        const shown = await showCompletionNotification({
          sessionId: candidate.sessionId,
          completedAt: candidate.completedAt,
          title: candidate.sessionTitle,
          body: formatCompletionNotificationBody(candidate.finalReply),
          url: `/session/${candidate.sessionId}`,
        })
        if (shown) {
          markCompletionNotificationShown(candidate.sessionId, candidate.completedAt)
        }
      } finally {
        pendingNotificationKeysRef.current.delete(notificationKey)
      }
    }

    const maybeShowNotifications = async (
      candidates: CompletionNotificationCandidate[],
    ) => {
      for (const candidate of candidates) {
        await maybeShowNotification(candidate)
      }
    }

    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let hasConnectedOnce = false
    let shouldRefreshOnConnected = false
    let ignoreNextAgentOnline = false

    const syncRecentSessions = async () => {
      if (!scopedAgentId) {
        return syncHubRecentSessions(queryClient)
      }

      const target = await resolveConnectionTarget({ agentId: scopedAgentId })
      const snapshot = await target.client.getPhaseOneSnapshot({
        fallbackToMock: false,
      })

      return {
        generated_at: snapshot.generated_at,
        recent_sessions: [...snapshot.sessions]
          .sort(
            (left, right) =>
              +new Date(right.last_event_at) - +new Date(left.last_event_at),
          )
          .slice(0, 24)
          .map((session) => ({
            id: session.id,
            title: session.title,
            run_state: session.run_state,
            run_state_changed_at: session.run_state_changed_at,
            latest_assistant_message: session.latest_assistant_message,
          })),
      } satisfies HubRecentSessionsSnapshot
    }

    void syncRecentSessions()
      .then((snapshot) => {
        if (!cancelled) {
          snapshotRef.current = snapshot
        }
      })
      .catch(() => {
        // Ignore boot-time snapshot failures; websocket refresh can recover later.
      })

    const refreshSnapshot = async () => {
      if (refreshInFlightRef.current) {
        return
      }

      refreshInFlightRef.current = true
      try {
        const nextSnapshot = await syncRecentSessions()

        if (cancelled) {
          return
        }

        const previousSnapshot = snapshotRef.current
        snapshotRef.current = nextSnapshot

        if (!previousSnapshot) {
          return
        }

        await maybeShowNotifications(
          buildSnapshotCompletionCandidates(previousSnapshot, nextSnapshot),
        )
      } catch {
        // Ignore best-effort refresh failures; websocket recovery will retry.
      } finally {
        refreshInFlightRef.current = false
      }
    }

    const scheduleSnapshotRefresh = () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current)
      }

      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null
        void refreshSnapshot()
      }, SNAPSHOT_REFRESH_DEBOUNCE_MS)
    }

    const handleEvent = (event: SocketEvent) => {
      if (event.type === 'turn.completed') {
        const candidate = buildTurnCompletedCandidate(
          event.payload,
          snapshotRef.current,
        )
        if (candidate) {
          void maybeShowNotification(candidate)
        }
        return
      }

      if (event.type === 'session.updated') {
        const sessionId =
          typeof event.payload?.sessionId === 'string'
            ? event.payload.sessionId.trim()
            : ''
        const sessionPatch =
          event.payload?.sessionPatch &&
          typeof event.payload.sessionPatch === 'object'
            ? event.payload.sessionPatch as Record<string, unknown>
            : null

        if (sessionId && sessionPatch) {
          snapshotRef.current = applyRecentSessionPatch(
            snapshotRef.current,
            sessionId,
            sessionPatch,
          )
        }
        return
      }

      if (event.type === 'agent.online' && ignoreNextAgentOnline) {
        ignoreNextAgentOnline = false
      }
    }

    void resolveConnectionTarget(
      scopedAgentId ? { agentId: scopedAgentId } : undefined,
    ).then((target) => {
      if (cancelled) {
        return
      }

      unsubscribe = target.client.connectEvents(handleEvent, {
        reconnectWhenHidden: true,
        onStatus: (status) => {
          if (status.state === 'connected') {
            ignoreNextAgentOnline = true
            if (hasConnectedOnce && shouldRefreshOnConnected) {
              shouldRefreshOnConnected = false
              scheduleSnapshotRefresh()
            }

            hasConnectedOnce = true
            return
          }

          if (hasConnectedOnce) {
            shouldRefreshOnConnected = true
          }
        },
      })
    })

    return () => {
      cancelled = true
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
      unsubscribe?.()
    }
  }, [queryClient, scopedAgentId])

  return null
}
