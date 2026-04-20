import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { WorkspaceAgentSummary, WorkspaceDirectorySnapshot } from '@panda/protocol'
import {
  deriveAgentIndicatorState,
  type AgentIndicatorState,
  type AgentTransportState,
} from '../../lib/agent-presence'
import { WORKSPACE_DIRECTORY_QUERY_KEY } from '../../lib/bootstrap-query'
import { resolveConnectionTarget } from '../../lib/client'
import {
  getWorkspaceDirectoryQueryKey,
  syncHubDirectory,
  syncWorkspaceDirectory,
} from '../../lib/directory-sync'
import {
  clearStoredSessionSelection,
  consumePendingDirectoryPicker,
  consumePendingProjectId,
  consumePendingSessionId,
  queuePendingDirectoryPicker,
  queuePendingProjectId,
  queuePendingSessionId,
  readSelectedAgentConnectionHint,
  readStoredAgentId,
  readStoredSessionId,
  writeStoredAgentId,
  writeStoredSessionId,
} from '../../lib/session-selection'
import { agentDisplayName } from '../../lib/format'
import { useUiStore } from '../../store/ui-store'
import { useHubDirectory } from '../../lib/use-hub-directory'
import { useWorkspaceDirectory } from '../../lib/use-workspace-directory'
import { useWorkspaceSessionPaging } from '../../lib/use-workspace-session-paging'
import {
  hasWorkspaceSession,
  patchWorkspaceProjectIfMatched,
  toWorkspaceSessionDirectoryPatch,
  patchWorkspaceSessionWithSafeLastEventAt,
  patchWorkspaceSessions,
  removeWorkspaceProject,
  removeWorkspaceSessions,
  reorderWorkspaceProjects,
  upsertWorkspaceSession,
} from '../../lib/workspace-directory-cache'
import { ConversationSidebar } from './conversation-sidebar'
import { NewThreadPane } from './new-thread-pane'
import { SessionDetailPage } from './session-detail-page'
import { SessionEmptyState } from './session-empty-state'

const DESKTOP_SIDEBAR_BREAKPOINT = 1100
const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = 'panda:desktop-sidebar-width'
const DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION_KEY = 'panda:desktop-sidebar-width-version'
const DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION = '2026-03-24-narrow'
const LEGACY_DESKTOP_SIDEBAR_WIDTH_DEFAULT = 300
const DESKTOP_SIDEBAR_WIDTH_MIN = 232
const DESKTOP_SIDEBAR_WIDTH_DEFAULT = DESKTOP_SIDEBAR_WIDTH_MIN
const DESKTOP_SIDEBAR_WIDTH_MAX = 460
const SIDEBAR_CLOSE_THRESHOLD = 0.4
const SIDEBAR_OPEN_THRESHOLD_PX = 56
const PREVIEW_OPEN_THRESHOLD_PX = 56
const DIRECTORY_SYNC_DEBOUNCE_MS = 160
const WORKSPACE_CONNECTION_MAX_ATTEMPTS = 5

const LazySessionFilePreviewPage = lazy(async () => {
  const module = await import('./session-file-preview-page')
  return { default: module.SessionFilePreviewPage }
})

type WorkspaceConnectionStatus = {
  state: AgentTransportState
  attempt: number
  maxAttempts: number
  error?: string
}

const getWorkspaceDirectoryGeneratedAtMs = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
) => {
  const generatedAt = new Date(snapshot?.generated_at ?? '').getTime()
  return Number.isFinite(generatedAt) ? generatedAt : 0
}

const findCachedWorkspaceDirectoryForAgent = (
  snapshots: Array<[readonly unknown[], WorkspaceDirectorySnapshot | undefined]>,
  agentId: string | null,
) => {
  if (!agentId) {
    return undefined
  }

  let matchedSnapshot: WorkspaceDirectorySnapshot | undefined
  for (const [, snapshot] of snapshots) {
    if (!snapshot) {
      continue
    }

    const matchesAgent =
      snapshot.agent?.id === agentId ||
      snapshot.projects.some((project) => project.agent_id === agentId) ||
      snapshot.sessions.some((session) => session.agent_id === agentId)
    if (!matchesAgent) {
      continue
    }

    if (
      !matchedSnapshot ||
      getWorkspaceDirectoryGeneratedAtMs(snapshot) >
        getWorkspaceDirectoryGeneratedAtMs(matchedSnapshot)
    ) {
      matchedSnapshot = snapshot
    }
  }

  return matchedSnapshot
}

const getSidebarShiftMax = () => {
  if (typeof window === 'undefined') {
    return 248
  }

  return Math.max(0, Math.min(248, window.innerWidth - 84))
}

const getPreviewShiftMax = () => {
  if (typeof window === 'undefined') {
    return 0
  }

  return Math.max(window.innerWidth, 0)
}

const clampDesktopSidebarWidth = (value: number) =>
  Math.max(DESKTOP_SIDEBAR_WIDTH_MIN, Math.min(DESKTOP_SIDEBAR_WIDTH_MAX, value))

const readDesktopSidebarWidth = () => {
  if (typeof window === 'undefined') {
    return DESKTOP_SIDEBAR_WIDTH_DEFAULT
  }

  try {
    const raw = window.localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY)
    const version = window.localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION_KEY)
    if (!raw) {
      window.localStorage.setItem(
        DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION_KEY,
        DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION,
      )
      return DESKTOP_SIDEBAR_WIDTH_DEFAULT
    }

    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      window.localStorage.setItem(
        DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION_KEY,
        DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION,
      )
      return DESKTOP_SIDEBAR_WIDTH_DEFAULT
    }

    const isLegacyStoredWidth =
      version !== DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION ||
      parsed === LEGACY_DESKTOP_SIDEBAR_WIDTH_DEFAULT ||
      parsed > DESKTOP_SIDEBAR_WIDTH_DEFAULT
    const nextWidth = isLegacyStoredWidth ? DESKTOP_SIDEBAR_WIDTH_DEFAULT : parsed
    window.localStorage.setItem(
      DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION_KEY,
      DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION,
    )
    return clampDesktopSidebarWidth(nextWidth)
  } catch {
    return DESKTOP_SIDEBAR_WIDTH_DEFAULT
  }
}

export const SessionWorkspacePage = () => {
  const openSettingsOverlay = useUiStore((state) => state.openSettingsOverlay)
  const { agentId: routeAgentId } = useParams({ strict: false }) as { agentId?: string }
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => readStoredAgentId())
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => consumePendingSessionId() ?? readStoredSessionId(),
  )
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(() => consumePendingProjectId())
  const [newThreadEntryView, setNewThreadEntryView] = useState<'composer' | 'directory-picker'>(
    () => (consumePendingDirectoryPicker() ? 'directory-picker' : 'composer'),
  )
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [isDesktopSidebar, setIsDesktopSidebar] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_SIDEBAR_BREAKPOINT,
  )
  const [desktopSidebarWidth, setDesktopSidebarWidth] = useState(() => readDesktopSidebarWidth())
  const [isDesktopSidebarResizing, setIsDesktopSidebarResizing] = useState(false)
  const [workspaceConnectionStatus, setWorkspaceConnectionStatus] = useState<WorkspaceConnectionStatus>({
    state: 'connected',
    attempt: 0,
    maxAttempts: WORKSPACE_CONNECTION_MAX_ATTEMPTS,
  })
  const [sidebarDragShift, setSidebarDragShift] = useState<number | null>(null)
  const [previewDragShift, setPreviewDragShift] = useState<number | null>(null)
  const sidebarDragShiftRef = useRef<number | null>(null)
  const previewDragShiftRef = useRef<number | null>(null)
  const horizontalTouchPendingRef = useRef<{ startX: number; startY: number } | null>(null)
  const dragStateRef = useRef<{
    target: 'sidebar' | 'preview'
    mode: 'open' | 'close'
    startX: number
    startY: number
    axis: 'pending' | 'x' | 'y'
    pointerId?: number
  } | null>(null)
  const desktopSidebarResizeRef = useRef<{
    startX: number
    startWidth: number
  } | null>(null)
  const desktopSidebarWidthRef = useRef(desktopSidebarWidth)
  const desktopSidebarResizeTargetRef = useRef<number | null>(null)
  const desktopSidebarResizeFrameRef = useRef<number | null>(null)
  const workspaceEventStreamRef = useRef<{
    key: string
    stream: {
      close: () => void
    }
  } | null>(null)
  const workspaceEventRequestIdRef = useRef(0)
  const workspaceEventSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceEventHasConnectedOnceRef = useRef(false)
  const workspaceEventShouldSyncOnConnectedRef = useRef(false)
  const workspaceEventIgnoreNextAgentOnlineRef = useRef(false)
  const previousHubAgentStatusRef = useRef<'online' | 'offline' | null>(null)
  const workspacePresenceRecoveryKeyRef = useRef<string | null>(null)
  const effectiveAgentId = routeAgentId ?? selectedAgentId ?? null
  const workspaceScope = effectiveAgentId ? { agentId: effectiveAgentId } : undefined
  const exactCachedWorkspaceDirectory = queryClient.getQueryData<WorkspaceDirectorySnapshot>(
    getWorkspaceDirectoryQueryKey({
      scope: workspaceScope,
    }),
  )
  const cachedWorkspaceDirectory =
    exactCachedWorkspaceDirectory ??
    findCachedWorkspaceDirectoryForAgent(
      queryClient.getQueriesData<WorkspaceDirectorySnapshot>({
        queryKey: WORKSPACE_DIRECTORY_QUERY_KEY,
      }),
      effectiveAgentId,
    )
  const workspaceDirectorySelectedSessionIdHint =
    selectedSessionId &&
    !cachedWorkspaceDirectory?.sessions.some((session) => session.id === selectedSessionId)
      ? selectedSessionId
      : null
  const workspaceEventScopeRef = useRef<{
    agentId: string | null
    selectedSessionIdHint: string | null
  }>({
    agentId: effectiveAgentId,
    selectedSessionIdHint: workspaceDirectorySelectedSessionIdHint,
  })
  const selectedAgentConnectionHint = readSelectedAgentConnectionHint(effectiveAgentId)
  void selectedAgentConnectionHint
  const hubDirectoryQuery = useHubDirectory({
    enabled: false,
  })
  const hubDirectory = hubDirectoryQuery.data
  const workspaceDirectoryQuery = useWorkspaceDirectory({
    scope: workspaceScope,
    selectedSessionId: workspaceDirectorySelectedSessionIdHint,
    enabled: Boolean(effectiveAgentId),
  })
  const workspaceDirectory = workspaceDirectoryQuery.data ?? cachedWorkspaceDirectory
  const {
    historyState,
    archivedState,
    loadMoreHistory,
    loadMoreArchived,
    reset: resetSessionPaging,
  } = useWorkspaceSessionPaging({
    scope: workspaceScope,
    selectedSessionId: selectedSessionId ?? null,
  })
  const loadedPagedSessions = [
    ...Object.values(historyState).flatMap((state) => state.sessions),
    ...Object.values(archivedState).flatMap((state) => state.sessions),
  ]

  useEffect(() => {
    if (routeAgentId) {
      setSelectedAgentId(routeAgentId)
      writeStoredAgentId(routeAgentId)
      setSelectedSessionId(null)
    }
  }, [routeAgentId])

  useEffect(() => {
    if (!workspaceDirectory) {
      return
    }

    setSelectedAgentId((current) => {
      if (
        current &&
        (workspaceDirectory.agent?.id === current ||
          hubDirectory?.agents.some((agent) => agent.id === current))
      ) {
        return current
      }

      return null
    })
    setSelectedSessionId((current) => {
      if (!current) {
        return null
      }

      if (workspaceDirectory.sessions.some((session) => session.id === current)) {
        return current
      }

      if (loadedPagedSessions.some((session) => session.id === current)) {
        return current
      }

      if (
        workspaceDirectoryQuery.isPending ||
        workspaceDirectoryQuery.isFetching ||
        workspaceDirectoryQuery.isError
      ) {
        return current
      }

      return null
    })
  }, [
    hubDirectory?.agents,
    loadedPagedSessions,
    workspaceDirectory,
    workspaceDirectoryQuery.isError,
    workspaceDirectoryQuery.isFetching,
    workspaceDirectoryQuery.isPending,
  ])

  useEffect(() => {
    if (routeAgentId) {
      return
    }

    if (selectedAgentId) {
      return
    }

    clearStoredSessionSelection()
    void navigate({ to: '/nodes', replace: true })
  }, [navigate, routeAgentId, selectedAgentId])

  useEffect(() => {
    if (!workspaceDirectory || routeAgentId || !selectedAgentId) {
      return
    }

    if (selectedSessionId) {
      return
    }

    const storedSessionId = readStoredSessionId()
    const storedSession =
      workspaceDirectory.sessions.find((session) => session.id === storedSessionId) ?? null

    if (!storedSession) {
      return
    }

    setSelectedSessionId(storedSession.id)
    writeStoredSessionId(storedSession.id)
  }, [routeAgentId, selectedAgentId, selectedSessionId, workspaceDirectory])

  const hubCurrentAgent =
    (effectiveAgentId
      ? hubDirectory?.agents.find((agent) => agent.id === effectiveAgentId) ?? null
      : null) ??
    null
  const currentAgent = useMemo<WorkspaceAgentSummary | null>(() => {
    const baseAgent =
      workspaceDirectory?.agent ??
      (hubCurrentAgent
        ? {
            id: hubCurrentAgent.id,
            name: hubCurrentAgent.name,
            display_name: hubCurrentAgent.display_name,
            status: hubCurrentAgent.status,
          }
        : null)

    if (!baseAgent) {
      return null
    }

    const authoritativeStatus = hubCurrentAgent?.status ?? baseAgent.status
    const authoritativeName = hubCurrentAgent?.name ?? baseAgent.name
    const authoritativeDisplayName = hubCurrentAgent?.display_name ?? baseAgent.display_name
    if (
      baseAgent.status === authoritativeStatus &&
      baseAgent.name === authoritativeName &&
      baseAgent.display_name === authoritativeDisplayName
    ) {
      return baseAgent
    }

    return {
      ...baseAgent,
      name: authoritativeName,
      display_name: authoritativeDisplayName,
      status: authoritativeStatus,
    }
  }, [hubCurrentAgent, workspaceDirectory?.agent])
  const sidebarAgentIndicatorState: AgentIndicatorState | undefined = currentAgent
    ? deriveAgentIndicatorState(currentAgent.status, workspaceConnectionStatus.state)
    : undefined

  const projects = workspaceDirectory?.projects ?? []
  const sessions = workspaceDirectory?.sessions ?? []
  const projectStats = workspaceDirectory?.project_stats ?? []

  const activeSession =
    selectedSessionId
      ? sessions.find((session) => session.id === selectedSessionId) ?? null
      : null
  const activeProject =
    activeSession
      ? projects.find((project) => project.id === activeSession.project_id) ?? null
      : null
  const canOpenFilePreview = Boolean(activeSession && activeProject)

  useEffect(() => {
    setPreviewOpen(false)
    setPreviewDragShift(null)
    previewDragShiftRef.current = null
  }, [activeSession?.id, activeProject?.id])

  const isAwaitingAgentRestore =
    Boolean(effectiveAgentId) &&
    !currentAgent &&
    (hubDirectoryQuery.isPending ||
      hubDirectoryQuery.isFetching ||
      workspaceDirectoryQuery.isPending ||
      workspaceDirectoryQuery.isFetching)
  const isAwaitingStoredSessionRestore =
    Boolean(selectedSessionId) &&
    !sessions.some((session) => session.id === selectedSessionId) &&
    (workspaceDirectoryQuery.isPending || workspaceDirectoryQuery.isFetching)
  const isRestoringWorkspace = isAwaitingAgentRestore || isAwaitingStoredSessionRestore
  const visibleSessionId =
    activeSession?.id ??
    (isRestoringWorkspace ? selectedSessionId ?? null : null)
  workspaceEventScopeRef.current = {
    agentId: currentAgent?.id ?? effectiveAgentId,
    selectedSessionIdHint: workspaceDirectorySelectedSessionIdHint,
  }

  useEffect(() => {
    const currentHubStatus = hubCurrentAgent?.status ?? null
    const previousHubStatus = previousHubAgentStatusRef.current
    previousHubAgentStatusRef.current = currentHubStatus

    const agentId = effectiveAgentId?.trim() ?? ''
    if (!agentId || currentHubStatus !== 'online') {
      if (currentHubStatus !== 'online') {
        workspacePresenceRecoveryKeyRef.current = null
      }
      return
    }

    const shouldSyncWorkspaceDirectory =
      previousHubStatus !== 'online' || !workspaceDirectory
    if (!shouldSyncWorkspaceDirectory) {
      return
    }

    const recoveryKey = `${agentId}:${previousHubStatus !== 'online' ? 'online' : 'missing'}:${
      workspaceDirectorySelectedSessionIdHint ?? ''
    }`
    if (workspacePresenceRecoveryKeyRef.current === recoveryKey) {
      return
    }

    workspacePresenceRecoveryKeyRef.current = recoveryKey
    void syncWorkspaceDirectory(queryClient, {
      scope: { agentId },
      selectedSessionId: workspaceDirectorySelectedSessionIdHint,
    })
  }, [
    effectiveAgentId,
    hubCurrentAgent?.status,
    queryClient,
    workspaceDirectory,
    workspaceDirectorySelectedSessionIdHint,
  ])

  useEffect(() => {
    if (!workspaceEventScopeRef.current.agentId) {
      if (workspaceEventSyncTimerRef.current !== null) {
        clearTimeout(workspaceEventSyncTimerRef.current)
        workspaceEventSyncTimerRef.current = null
      }
      workspaceEventStreamRef.current?.stream.close()
      workspaceEventStreamRef.current = null
      workspaceEventHasConnectedOnceRef.current = false
      workspaceEventShouldSyncOnConnectedRef.current = false
      workspaceEventIgnoreNextAgentOnlineRef.current = false
      return
    }

    let cancelled = false
    const requestId = ++workspaceEventRequestIdRef.current

    const clearSyncTimer = () => {
      if (workspaceEventSyncTimerRef.current !== null) {
        clearTimeout(workspaceEventSyncTimerRef.current)
        workspaceEventSyncTimerRef.current = null
      }
    }

    const scheduleDirectorySync = (options?: { includeHubDirectory?: boolean }) => {
      const includeHubDirectory = options?.includeHubDirectory ?? false
      clearSyncTimer()
      workspaceEventSyncTimerRef.current = setTimeout(() => {
        workspaceEventSyncTimerRef.current = null
        const currentScope = workspaceEventScopeRef.current
        const syncTasks: Array<Promise<unknown>> = [
          syncWorkspaceDirectory(queryClient, {
            scope: currentScope.agentId ? { agentId: currentScope.agentId } : undefined,
            selectedSessionId: currentScope.selectedSessionIdHint,
          }),
        ]
        if (includeHubDirectory) {
          syncTasks.unshift(syncHubDirectory(queryClient))
        }
        void Promise.allSettled(syncTasks)
      }, DIRECTORY_SYNC_DEBOUNCE_MS)
    }

    void resolveConnectionTarget({
      agentId: workspaceEventScopeRef.current.agentId,
    }).then((target) => {
      if (cancelled || workspaceEventRequestIdRef.current !== requestId) {
        return
      }

      const nextKey = target.client.getConnectionKey()
      if (workspaceEventStreamRef.current?.key === nextKey) {
        return
      }

      workspaceEventStreamRef.current?.stream.close()
      workspaceEventHasConnectedOnceRef.current = false
      workspaceEventShouldSyncOnConnectedRef.current = false
      workspaceEventIgnoreNextAgentOnlineRef.current = false

      const stream = target.client.createEventStream((event) => {
        const payloadSessionId =
          typeof event.payload?.sessionId === 'string'
            ? event.payload.sessionId
            : null
        const payloadProjectId =
          typeof event.payload?.projectId === 'string'
            ? event.payload.projectId
            : null

        if (event.type === 'agent.online') {
          if (workspaceEventIgnoreNextAgentOnlineRef.current) {
            workspaceEventIgnoreNextAgentOnlineRef.current = false
            return
          }

          resetSessionPaging()
          scheduleDirectorySync({ includeHubDirectory: true })
          return
        }

        if (event.type === 'thread.updated' && payloadProjectId) {
          const action =
            typeof event.payload?.action === 'string'
              ? event.payload.action
              : ''
          const projectPatch =
            event.payload?.projectPatch &&
            typeof event.payload.projectPatch === 'object'
              ? event.payload.projectPatch as Partial<WorkspaceDirectorySnapshot['projects'][number]>
              : null
          const orderedProjectIds = Array.isArray(event.payload?.orderedProjectIds)
            ? event.payload.orderedProjectIds.filter(
                (item): item is string => typeof item === 'string' && item.trim().length > 0,
              )
            : []

          if ((action === 'pin' || action === 'unpin' || action === 'rename') && projectPatch) {
            queryClient.setQueriesData<WorkspaceDirectorySnapshot | undefined>(
              { queryKey: WORKSPACE_DIRECTORY_QUERY_KEY },
              (currentSnapshot) =>
                patchWorkspaceProjectIfMatched(
                  currentSnapshot,
                  payloadProjectId,
                  projectPatch,
                ),
            )
            return
          }

          if (action === 'reorder' && orderedProjectIds.length > 0) {
            queryClient.setQueriesData<WorkspaceDirectorySnapshot | undefined>(
              { queryKey: WORKSPACE_DIRECTORY_QUERY_KEY },
              (currentSnapshot) =>
                reorderWorkspaceProjects(currentSnapshot, orderedProjectIds),
            )
            return
          }

          if (action === 'remove' || action === 'archive') {
            resetSessionPaging()
            queryClient.setQueriesData<WorkspaceDirectorySnapshot | undefined>(
              { queryKey: WORKSPACE_DIRECTORY_QUERY_KEY },
              (currentSnapshot) =>
                removeWorkspaceProject(currentSnapshot, payloadProjectId),
            )
            return
          }

          if (action === 'unarchive') {
            resetSessionPaging()
            const currentScope = workspaceEventScopeRef.current
            void syncWorkspaceDirectory(queryClient, {
              scope: currentScope.agentId ? { agentId: currentScope.agentId } : undefined,
              selectedSessionId: currentScope.selectedSessionIdHint,
            })
            return
          }
        }

        if (event.type === 'session.updated' && payloadSessionId) {
          const sessionPatch =
            event.payload?.sessionPatch &&
            typeof event.payload.sessionPatch === 'object'
              ? toWorkspaceSessionDirectoryPatch(
                  event.payload.sessionPatch as Record<string, unknown>,
                )
              : null

          const currentScope = workspaceEventScopeRef.current
          const workspaceSnapshot = queryClient.getQueryData<WorkspaceDirectorySnapshot>(
            getWorkspaceDirectoryQueryKey({
              scope: currentScope.agentId ? { agentId: currentScope.agentId } : undefined,
              selectedSessionId: currentScope.selectedSessionIdHint,
            }),
          )
          const hasCachedWorkspaceSession = hasWorkspaceSession(
            workspaceSnapshot,
            payloadSessionId,
          )
          if (sessionPatch && hasCachedWorkspaceSession) {
            queryClient.setQueriesData<WorkspaceDirectorySnapshot | undefined>(
              { queryKey: WORKSPACE_DIRECTORY_QUERY_KEY },
              (currentSnapshot) =>
                patchWorkspaceSessionWithSafeLastEventAt(
                  currentSnapshot,
                  payloadSessionId,
                  sessionPatch,
                ),
            )
            return
          }

          if (hasCachedWorkspaceSession) {
            return
          }

          void syncWorkspaceDirectory(queryClient, {
            scope: currentScope.agentId ? { agentId: currentScope.agentId } : undefined,
            selectedSessionId: currentScope.selectedSessionIdHint,
          })
        }
      }, {
        onStatus: (status) => {
          setWorkspaceConnectionStatus(status)
          if (status.state === 'connected') {
            workspaceEventIgnoreNextAgentOnlineRef.current = true
            if (
              workspaceEventHasConnectedOnceRef.current &&
              workspaceEventShouldSyncOnConnectedRef.current
            ) {
              workspaceEventShouldSyncOnConnectedRef.current = false
              resetSessionPaging()
              scheduleDirectorySync({
                includeHubDirectory: target.mode === 'hub',
              })
            }

            workspaceEventHasConnectedOnceRef.current = true
            return
          }

          if (workspaceEventHasConnectedOnceRef.current) {
            workspaceEventShouldSyncOnConnectedRef.current = true
          }
        },
      })
      workspaceEventStreamRef.current = {
        key: nextKey,
        stream,
      }
    }).catch((error) => {
      if (cancelled || workspaceEventRequestIdRef.current !== requestId) {
        return
      }

      setWorkspaceConnectionStatus({
        state: 'failed',
        attempt: 0,
        maxAttempts: WORKSPACE_CONNECTION_MAX_ATTEMPTS,
        error: error instanceof Error ? error.message : '无法建立节点工作区连接',
      })
    })

    return () => {
      cancelled = true
    }
  }, [
    currentAgent?.id,
    currentAgent?.status,
    effectiveAgentId,
    queryClient,
    resetSessionPaging,
  ])

  useEffect(() => () => {
    workspaceEventRequestIdRef.current += 1
    if (workspaceEventSyncTimerRef.current !== null) {
      clearTimeout(workspaceEventSyncTimerRef.current)
      workspaceEventSyncTimerRef.current = null
    }
    workspaceEventStreamRef.current?.stream.close()
    workspaceEventStreamRef.current = null
  }, [])

  useEffect(() => {
    desktopSidebarWidthRef.current = desktopSidebarWidth
  }, [desktopSidebarWidth])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(
        DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY,
        String(clampDesktopSidebarWidth(desktopSidebarWidth)),
      )
      window.localStorage.setItem(
        DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION_KEY,
        DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION,
      )
    } catch {
      // Ignore storage failures; width persistence is best-effort only.
    }
  }, [desktopSidebarWidth])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleResize = () => {
      const nextIsDesktopSidebar = window.innerWidth >= DESKTOP_SIDEBAR_BREAKPOINT
      setIsDesktopSidebar(nextIsDesktopSidebar)
      if (nextIsDesktopSidebar) {
        setSidebarOpen(false)
        setSidebarDragShift(null)
      }
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    if (!isDesktopSidebarResizing) {
      return
    }

    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = desktopSidebarResizeRef.current
      if (!resizeState) {
        return
      }

      const deltaX = event.clientX - resizeState.startX
      const nextWidth = clampDesktopSidebarWidth(resizeState.startWidth + deltaX)
      desktopSidebarResizeTargetRef.current = nextWidth

      if (desktopSidebarResizeFrameRef.current !== null) {
        return
      }

      desktopSidebarResizeFrameRef.current = window.requestAnimationFrame(() => {
        desktopSidebarResizeFrameRef.current = null
        const targetWidth = desktopSidebarResizeTargetRef.current
        if (targetWidth !== null) {
          setDesktopSidebarWidth(targetWidth)
        }
      })
    }

    const handlePointerUp = () => {
      if (desktopSidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(desktopSidebarResizeFrameRef.current)
        desktopSidebarResizeFrameRef.current = null
      }

      const nextWidth =
        desktopSidebarResizeTargetRef.current ?? desktopSidebarWidthRef.current
      desktopSidebarResizeTargetRef.current = null
      desktopSidebarResizeRef.current = null
      setIsDesktopSidebarResizing(false)
      desktopSidebarWidthRef.current = nextWidth
      setDesktopSidebarWidth(nextWidth)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [isDesktopSidebarResizing])

  useEffect(() => {
    return () => {
      if (desktopSidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(desktopSidebarResizeFrameRef.current)
      }
    }
  }, [])

  const sessionActionMutation = useMutation({
    mutationFn: async (payload: { sessionId: string; action: 'pin' | 'unpin' | 'delete' | 'rename'; name?: string }) => {
      const target = await resolveConnectionTarget({
        sessionId: payload.sessionId,
      })
      return target.client.updateSession(payload) as Promise<{
        nextSessionId?: string | null
        affectedSessionIds?: string[]
      }>
    },
  })

  const threadActionMutation = useMutation({
    mutationFn: async (payload: {
      projectId: string
      agentId: string
      action: 'pin' | 'unpin' | 'rename' | 'remove' | 'archive' | 'unarchive' | 'reorder'
      name?: string
      orderedProjectIds?: string[]
    }) => {
      const target = await resolveConnectionTarget({
        projectId: payload.projectId,
        agentId: payload.agentId,
      })
      return target.client.updateThread(payload) as Promise<{
        nextSessionId?: string | null
      }>
    },
  })

  const patchWorkspaceQueries = (
    updater: (
      snapshot: WorkspaceDirectorySnapshot | undefined,
    ) => WorkspaceDirectorySnapshot | undefined,
  ) => {
    queryClient.setQueriesData<WorkspaceDirectorySnapshot | undefined>(
      { queryKey: WORKSPACE_DIRECTORY_QUERY_KEY },
      updater,
    )
  }

  const findLoadedSessionById = (sessionId: string) =>
    sessions.find((session) => session.id === sessionId) ??
    loadedPagedSessions.find((session) => session.id === sessionId) ??
    (activeSession?.id === sessionId ? activeSession : null)

  const handleSessionAction = async (
    targetSessionId: string,
    action: 'pin' | 'unpin' | 'delete' | 'rename',
    name?: string,
  ) => {
    const result = await sessionActionMutation.mutateAsync({
      sessionId: targetSessionId,
      action,
      name,
    })

    const affectedSessionIds = result.affectedSessionIds?.length
      ? result.affectedSessionIds
      : [targetSessionId]

    if (action === 'delete') {
      patchWorkspaceQueries((currentSnapshot) =>
        removeWorkspaceSessions(currentSnapshot, affectedSessionIds),
      )
      resetSessionPaging()
    } else {
      patchWorkspaceQueries((currentSnapshot) =>
        patchWorkspaceSessions(currentSnapshot, affectedSessionIds, {
            ...(action === 'rename' && name?.trim()
              ? { title: name.trim() }
              : { pinned: action === 'pin' }),
          }),
      )
    }

    if (action === 'delete' && selectedSessionId === targetSessionId) {
      const nextSessionId = result.nextSessionId
      if (nextSessionId) {
        writeStoredSessionId(nextSessionId)
        setSelectedSessionId(nextSessionId)
      } else {
        writeStoredSessionId(null)
        setSelectedSessionId(null)
      }
    }
  }

  const handleThreadAction = async (
    projectId: string,
    action: 'pin' | 'unpin' | 'rename' | 'remove' | 'archive' | 'unarchive' | 'reorder',
    payload?: {
      name?: string
      orderedProjectIds?: string[]
    },
  ) => {
    const result = await threadActionMutation.mutateAsync({
      projectId,
      agentId: currentAgent?.id ?? selectedAgentId ?? routeAgentId ?? '',
      action,
      name: payload?.name,
      orderedProjectIds: payload?.orderedProjectIds,
    })

    const nextName = payload?.name?.trim()

    if (action === 'pin' || action === 'unpin') {
      patchWorkspaceQueries((currentSnapshot) =>
        patchWorkspaceProjectIfMatched(currentSnapshot, projectId, {
          pinned: action === 'pin',
        }),
      )
    } else if (action === 'rename' && nextName) {
      patchWorkspaceQueries((currentSnapshot) =>
        patchWorkspaceProjectIfMatched(currentSnapshot, projectId, {
          display_name: nextName,
        }),
      )
    } else if (action === 'reorder' && payload?.orderedProjectIds?.length) {
      patchWorkspaceQueries((currentSnapshot) =>
        reorderWorkspaceProjects(currentSnapshot, payload.orderedProjectIds ?? []),
      )
    } else if (action === 'remove' || action === 'archive') {
      patchWorkspaceQueries((currentSnapshot) =>
        removeWorkspaceProject(currentSnapshot, projectId),
      )
      resetSessionPaging()
    } else if (action === 'unarchive') {
      resetSessionPaging()
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY })
    }

    if (
      activeSession &&
      activeSession.project_id === projectId &&
      (action === 'remove' || action === 'archive' || action === 'unarchive')
    ) {
      if (result.nextSessionId) {
        writeStoredSessionId(result.nextSessionId)
        setSelectedSessionId(result.nextSessionId)
      } else {
        writeStoredSessionId(null)
        setSelectedSessionId(null)
      }
    }
  }

  const openNewThreadComposer = async (projectId: string | null) => {
    if (!currentAgent) {
      return
    }

    writeStoredAgentId(currentAgent.id)
    writeStoredSessionId(null)
    queuePendingSessionId(null)
    queuePendingDirectoryPicker(false)
    queuePendingProjectId(projectId)
    setPendingProjectId(projectId)
    setNewThreadEntryView('composer')
    setSelectedSessionId(null)
    await navigate({ to: '/' })
  }

  const handleCreateDirectoryThread = async () => {
    if (!currentAgent) {
      return
    }

    if (!isDesktopSidebar) {
      setSidebarOpen(false)
      updateSidebarDragShift(null)
    }

    writeStoredAgentId(currentAgent.id)
    writeStoredSessionId(null)
    queuePendingSessionId(null)
    queuePendingProjectId(null)
    queuePendingDirectoryPicker(true)
    setPendingProjectId(null)
    setNewThreadEntryView('directory-picker')
    setSelectedSessionId(null)
    await navigate({ to: '/' })
  }

  const openNewThreadPage = async (projectId: string) => {
    await openNewThreadComposer(projectId)
  }

  const selectSession = async (sessionId: string) => {
    const nextSession = findLoadedSessionById(sessionId)

    setPendingProjectId(null)
    setNewThreadEntryView('composer')
    queuePendingDirectoryPicker(false)
    queuePendingProjectId(null)
    queuePendingSessionId(null)
    if (nextSession && !sessions.some((session) => session.id === sessionId)) {
      patchWorkspaceQueries((currentSnapshot) =>
        upsertWorkspaceSession(currentSnapshot, nextSession),
      )
    }

    setSelectedSessionId(sessionId)
    writeStoredSessionId(sessionId)

    const nextAgentId = nextSession?.agent_id ?? currentAgent?.id ?? effectiveAgentId
    if (nextAgentId) {
      setSelectedAgentId(nextAgentId)
      writeStoredAgentId(nextAgentId)
    }

    if (routeAgentId) {
      await navigate({ to: '/', replace: true })
    }
  }

  const sidebarShiftMax = isDesktopSidebar ? 0 : getSidebarShiftMax()
  const previewShiftMax = isDesktopSidebar ? 0 : getPreviewShiftMax()
  const effectiveSidebarOpen = isDesktopSidebar || sidebarOpen
  const sidebarShift = isDesktopSidebar
    ? 0
    : sidebarDragShift ?? (sidebarOpen ? sidebarShiftMax : 0)
  const previewShift = isDesktopSidebar
    ? 0
    : previewDragShift ?? (previewOpen ? previewShiftMax : 0)
  const sidebarProgress = isDesktopSidebar
    ? 1
    : sidebarShiftMax > 0
      ? sidebarShift / sidebarShiftMax
      : 0
  const isSidebarDragging = !isDesktopSidebar && sidebarDragShift !== null
  const isPreviewDragging = !isDesktopSidebar && previewDragShift !== null
  const conversationPageStyle = isDesktopSidebar
    ? ({
        '--desktop-sidebar-width': `${desktopSidebarWidth}px`,
      } as CSSProperties)
    : ({
        '--workspace-preview-shift': `${previewShift}px`,
      } as CSSProperties)

  const updateSidebarDragShift = (value: number | null) => {
    sidebarDragShiftRef.current = value
    setSidebarDragShift(value)
  }

  const updatePreviewDragShift = (value: number | null) => {
    previewDragShiftRef.current = value
    setPreviewDragShift(value)
  }

  const isInteractiveTarget = (target: EventTarget | null) =>
    target instanceof Element &&
    Boolean(target.closest('button, textarea, input, a, [role="dialog"]'))

  const shouldIgnoreSidebarDragStart = (target: EventTarget | null) => isInteractiveTarget(target)

  const beginSidebarDrag = (startX: number, startY: number, pointerId?: number) => {
    dragStateRef.current = {
      target: 'sidebar',
      mode: sidebarOpen ? 'close' : 'open',
      startX,
      startY,
      axis: 'pending',
      pointerId,
    }

    return true
  }

  const beginPreviewDrag = (startX: number, startY: number, pointerId?: number) => {
    if (!canOpenFilePreview) {
      return false
    }

    dragStateRef.current = {
      target: 'preview',
      mode: 'open',
      startX,
      startY,
      axis: 'pending',
      pointerId,
    }

    return true
  }

  const moveHorizontalDrag = (clientX: number, clientY: number) => {
    const state = dragStateRef.current
    if (!state) {
      return false
    }

    const deltaX = clientX - state.startX
    const deltaY = clientY - state.startY

    if (state.axis === 'pending') {
      if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) {
        return false
      }

      state.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y'

      if (state.axis === 'y') {
        dragStateRef.current = null
        updateSidebarDragShift(null)
        return false
      }
    }

    if (state.target === 'preview') {
      const nextShift = Math.max(0, Math.min(previewShiftMax, -deltaX))
      updatePreviewDragShift(nextShift)
      return true
    }

    const nextShift =
      state.mode === 'open'
        ? Math.max(0, Math.min(sidebarShiftMax, deltaX))
        : Math.max(0, Math.min(sidebarShiftMax, sidebarShiftMax + deltaX))
    updateSidebarDragShift(nextShift)
    return true
  }

  const endHorizontalDrag = (clientX: number, clientY: number) => {
    const state = dragStateRef.current
    if (!state) {
      return
    }

    const deltaX = clientX - state.startX
    const deltaY = clientY - state.startY

    if (state.axis === 'pending' && Math.abs(deltaY) > 48) {
      dragStateRef.current = null
      updateSidebarDragShift(null)
      return
    }

    if (state.target === 'preview') {
      const finalShift =
        state.axis === 'x'
          ? previewDragShiftRef.current ?? Math.max(0, Math.min(previewShiftMax, -deltaX))
          : previewOpen
            ? previewShiftMax
            : 0
      const shouldOpen =
        finalShift >= Math.min(PREVIEW_OPEN_THRESHOLD_PX, previewShiftMax * SIDEBAR_CLOSE_THRESHOLD)

      setPreviewOpen(shouldOpen)
      if (shouldOpen) {
        setSidebarOpen(false)
        updateSidebarDragShift(null)
      }
      dragStateRef.current = null
      updatePreviewDragShift(null)
      return
    }

    const finalShift =
      state.axis === 'x'
        ? sidebarDragShiftRef.current ?? (state.mode === 'open'
            ? Math.max(0, Math.min(sidebarShiftMax, deltaX))
            : Math.max(0, Math.min(sidebarShiftMax, sidebarShiftMax + deltaX)))
        : sidebarOpen
          ? sidebarShiftMax
          : 0

    const shouldOpen =
      state.mode === 'open'
        ? finalShift >= Math.min(SIDEBAR_OPEN_THRESHOLD_PX, sidebarShiftMax * SIDEBAR_CLOSE_THRESHOLD)
        : finalShift >= sidebarShiftMax * SIDEBAR_CLOSE_THRESHOLD
    setSidebarOpen(shouldOpen)
    dragStateRef.current = null
    updateSidebarDragShift(null)
  }

  useEffect(() => {
    const workspaceElement = workspaceRef.current
    if (!workspaceElement || isDesktopSidebar) {
      return
    }

    const handleTouchStart = (event: TouchEvent) => {
      if (previewOpen) {
        return
      }

      const touch = event.touches[0]
      if (
        event.touches.length !== 1 ||
        !touch ||
        shouldIgnoreSidebarDragStart(event.target)
      ) {
        return
      }

      horizontalTouchPendingRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
      }
    }

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return
      }

      const touch = event.touches[0]
      if (!dragStateRef.current) {
        const pendingTouch = horizontalTouchPendingRef.current
        if (!pendingTouch) {
          return
        }

        const deltaX = touch.clientX - pendingTouch.startX
        const deltaY = touch.clientY - pendingTouch.startY
        if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) {
          return
        }

        if (Math.abs(deltaX) <= Math.abs(deltaY)) {
          horizontalTouchPendingRef.current = null
          return
        }

        const shouldStartSidebarClose = sidebarOpen && deltaX < 0
        const shouldStartSidebarOpen = !previewOpen && !sidebarOpen && deltaX > 0
        const shouldStartPreviewOpen = !sidebarOpen && !previewOpen && deltaX < 0 && canOpenFilePreview
        const started =
          shouldStartSidebarClose || shouldStartSidebarOpen
            ? beginSidebarDrag(pendingTouch.startX, pendingTouch.startY)
            : shouldStartPreviewOpen
              ? beginPreviewDrag(pendingTouch.startX, pendingTouch.startY)
              : false

        horizontalTouchPendingRef.current = null
        if (!started) {
          return
        }
      }

      const isDraggingHorizontalPanel = moveHorizontalDrag(touch.clientX, touch.clientY)
      if (isDraggingHorizontalPanel && event.cancelable) {
        event.preventDefault()
      }
    }

    const handleTouchEnd = (event: TouchEvent) => {
      horizontalTouchPendingRef.current = null
      if (!dragStateRef.current) {
        return
      }

      const touch = event.changedTouches[0]
      if (!touch) {
        dragStateRef.current = null
        updateSidebarDragShift(null)
        updatePreviewDragShift(null)
        return
      }

      endHorizontalDrag(touch.clientX, touch.clientY)
    }

    const handleTouchCancel = () => {
      horizontalTouchPendingRef.current = null
      dragStateRef.current = null
      updateSidebarDragShift(null)
      updatePreviewDragShift(null)
    }

    workspaceElement.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true })
    workspaceElement.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true })
    workspaceElement.addEventListener('touchend', handleTouchEnd, { capture: true })
    workspaceElement.addEventListener('touchcancel', handleTouchCancel, { capture: true })

    return () => {
      workspaceElement.removeEventListener('touchstart', handleTouchStart, { capture: true })
      workspaceElement.removeEventListener('touchmove', handleTouchMove, { capture: true })
      workspaceElement.removeEventListener('touchend', handleTouchEnd, { capture: true })
      workspaceElement.removeEventListener('touchcancel', handleTouchCancel, { capture: true })
    }
  }, [canOpenFilePreview, isDesktopSidebar, previewOpen, sidebarOpen])

  const renderNodeEmptyPane = () => (
    <>
      <div
        className={`conversation-main ${isDesktopSidebar ? 'has-desktop-sidebar' : ''}`}
        style={{
          transform: `translateX(${sidebarShift}px)`,
          transition: isSidebarDragging ? 'none' : undefined,
        }}
      >
        <div className="conversation-topbar">
          {!isDesktopSidebar ? (
            <button
              type="button"
              className="conversation-menu"
              onClick={() => setSidebarOpen(true)}
              aria-label="打开侧边栏"
            >
              <span />
              <span className="short" />
            </button>
          ) : null}
        </div>

        <div className="conversation-scroll conversation-scroll--empty">
          <div className="conversation-thread conversation-thread--empty">
            <SessionEmptyState
              mode="node"
              agentName={currentAgent ? agentDisplayName(currentAgent) : undefined}
              agentStatus={currentAgent?.status ?? null}
              onOpenNodes={() => {
                void navigate({ to: '/nodes' })
              }}
            />
          </div>
        </div>
      </div>
    </>
  )

  return (
    <div
      ref={workspaceRef}
      className={`conversation-page ${isDesktopSidebar ? 'has-desktop-sidebar' : ''}`}
      style={conversationPageStyle}
      onPointerDown={(event) => {
        if (isDesktopSidebar) {
          return
        }

        if (previewOpen) {
          return
        }

        if (event.pointerType === 'touch') {
          return
        }

        if (event.pointerType === 'mouse' && event.button !== 0) {
          return
        }

        if (shouldIgnoreSidebarDragStart(event.target)) {
          return
        }

        const started = beginSidebarDrag(event.clientX, event.clientY, event.pointerId)
        if (!started) {
          return
        }

        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (isDesktopSidebar) {
          return
        }

        if (event.pointerType === 'touch') {
          return
        }

        const state = dragStateRef.current
        if (!state || state.pointerId !== event.pointerId) {
          return
        }

        const isDraggingHorizontalPanel = moveHorizontalDrag(event.clientX, event.clientY)
        if (!isDraggingHorizontalPanel) {
          return
        }

        event.preventDefault()
      }}
      onPointerUp={(event) => {
        if (isDesktopSidebar) {
          return
        }

        if (event.pointerType === 'touch') {
          return
        }

        const state = dragStateRef.current
        if (!state || state.pointerId !== event.pointerId) {
          return
        }

        endHorizontalDrag(event.clientX, event.clientY)
      }}
      onPointerCancel={(event) => {
        if (isDesktopSidebar) {
          return
        }

        if (event.pointerType === 'touch') {
          return
        }

        const state = dragStateRef.current
        if (!state || state.pointerId !== event.pointerId) {
          return
        }

        dragStateRef.current = null
        updateSidebarDragShift(null)
        updatePreviewDragShift(null)
      }}
    >
      <ConversationSidebar
        open={effectiveSidebarOpen}
        progress={sidebarProgress}
        isDragging={isSidebarDragging}
        desktopPinned={isDesktopSidebar}
        isDesktopResizing={isDesktopSidebarResizing}
        onClose={() => {
          if (isDesktopSidebar) {
            return
          }

          setSidebarOpen(false)
          updateSidebarDragShift(null)
        }}
        onDesktopResizeStart={(clientX) => {
          desktopSidebarResizeTargetRef.current = desktopSidebarWidthRef.current
          desktopSidebarResizeRef.current = {
            startX: clientX,
            startWidth: desktopSidebarWidthRef.current,
          }
          setIsDesktopSidebarResizing(true)
        }}
        currentAgent={currentAgent ?? undefined}
        agentIndicatorState={sidebarAgentIndicatorState}
        projects={projects}
        sessions={sessions}
        projectStats={projectStats}
        historySessionsByProject={Object.fromEntries(
          Object.entries(historyState).map(([projectId, state]) => [projectId, state.sessions]),
        )}
        archivedSessionsByProject={Object.fromEntries(
          Object.entries(archivedState).map(([projectId, state]) => [projectId, state.sessions]),
        )}
        historyPageStateByProject={historyState}
        archivedPageStateByProject={archivedState}
        activeSessionId={activeSession?.id}
        onCreateSession={(projectId) => {
          void openNewThreadPage(projectId)
        }}
        onCreateDirectoryThread={() => {
          void handleCreateDirectoryThread()
        }}
        onSelectSession={(sessionId) => {
          void selectSession(sessionId)
        }}
        onSessionAction={handleSessionAction}
        onThreadAction={handleThreadAction}
        onOpenSettings={openSettingsOverlay}
        onLoadMoreHistory={(projectId) => {
          void loadMoreHistory(projectId)
        }}
        onLoadMoreArchived={(projectId) => {
          void loadMoreArchived(projectId)
        }}
        pendingSessionActionId={sessionActionMutation.isPending ? sessionActionMutation.variables?.sessionId ?? null : null}
        pendingThreadActionId={threadActionMutation.isPending ? threadActionMutation.variables?.projectId ?? null : null}
      />

      <div
        className={`conversation-workspace-stack ${
          previewOpen || isPreviewDragging ? 'is-preview-open' : ''
        } ${isPreviewDragging ? 'is-dragging' : ''}`}
      >
        <div className="conversation-workspace-stack__page is-primary">
          {visibleSessionId
            ? (
                <SessionDetailPage
                  sessionId={visibleSessionId}
                  workspaceDirectorySnapshot={workspaceDirectory ?? null}
                  workspaceAgentIndicatorState={sidebarAgentIndicatorState}
                  embedded
                  isDesktopSidebar={isDesktopSidebar}
                  sidebarOffset={sidebarShift}
                  isSidebarDragging={isSidebarDragging}
                  onOpenSidebar={() => {
                    setPreviewOpen(false)
                    setSidebarOpen(true)
                  }}
                  onSelectSession={(sessionId) => {
                    if (sessionId) {
                      void selectSession(sessionId)
                    }
                  }}
                  onExitToNodes={() => {
                    queuePendingSessionId(null)
                    writeStoredSessionId(null)
                    setSelectedSessionId(null)
                    void navigate({ to: '/nodes' })
                  }}
                />
              )
            : !currentAgent
            ? renderNodeEmptyPane()
            : !activeSession
              ? (
                <NewThreadPane
                  currentAgent={currentAgent}
                  projects={projects}
                  sessions={sessions}
                  initialProjectId={pendingProjectId}
                  entryView={newThreadEntryView}
                  isDesktopSidebar={isDesktopSidebar}
                  sidebarOffset={sidebarShift}
                  isSidebarDragging={isSidebarDragging}
                  onOpenSidebar={() => {
                    setPreviewOpen(false)
                    setSidebarOpen(true)
                  }}
                  onProjectSelected={(projectId) => {
                    setPendingProjectId(projectId)
                    setNewThreadEntryView('composer')
                    queuePendingDirectoryPicker(false)
                  }}
                  onSessionCreated={(sessionId) => {
                    void selectSession(sessionId)
                  }}
                />
              ) : null}
        </div>

        <div className="conversation-workspace-stack__page is-preview">
          <div className="session-file-preview-pane">
            {activeSession && activeProject && (previewOpen || previewDragShift !== null) ? (
              <Suspense fallback={<div className="session-file-preview-pane__fallback">正在载入预览页…</div>}>
                <LazySessionFilePreviewPage
                  key={activeSession.id}
                  agentId={currentAgent?.id ?? effectiveAgentId}
                  sessionId={activeSession.id}
                  projectName={activeProject.display_name || activeProject.name}
                  projectPath={activeProject.path}
                  isActive={previewOpen}
                  onBack={() => {
                    setPreviewOpen(false)
                    updatePreviewDragShift(null)
                  }}
                />
              </Suspense>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
