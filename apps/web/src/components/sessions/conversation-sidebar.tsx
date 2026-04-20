import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from '@tanstack/react-router'
import { Pin, Trash2 } from 'lucide-react'
import type {
  WorkspaceAgentSummary,
  WorkspaceProjectDirectory,
  WorkspaceProjectStats,
  WorkspaceSessionDirectory,
} from '@panda/protocol'
import {
  getAgentIndicatorLabel,
  type AgentIndicatorState,
} from '../../lib/agent-presence'
import { agentDisplayName } from '../../lib/format'
import {
  EMPTY_WORKSPACE_SESSION_PAGE_STATE,
  type WorkspaceSessionPageState,
} from '../../lib/use-workspace-session-paging'

const COMPLETED_STATE_TTL_MS = 3 * 60 * 1000
const DEFAULT_VISIBLE_THREAD_SESSION_COUNT = 6
const COMPLETED_SEEN_STORAGE_KEY = 'panda:completed-session-seen-at'
const THREAD_DRAG_START_DISTANCE_PX = 6
const THREAD_DRAG_LONG_PRESS_MS = 220
type SidebarProject = WorkspaceProjectDirectory
type SidebarSession = WorkspaceSessionDirectory

type OptimisticSessionPatch = {
  pinned?: boolean
  hidden?: boolean
}

type ThreadActionPayload = {
  name?: string
  orderedProjectIds?: string[]
}

type ThreadGroupRenderItem = {
  project: SidebarProject
  threadSessions: SidebarSession[]
  collapsedThreadSessions: SidebarSession[]
  hiddenSessionCount: number
  totalSessionCount: number
  pageState: WorkspaceSessionPageState
  remainingPageCount: number
  latestEventAt: string
}

type ThreadDragState = {
  pane: 'threads' | 'archived'
  projectId: string
  pointerId: number
  pointerType: string
  originIndex: number
  visibleProjectIds: string[]
  nextVisibleProjectIds: string[]
  nextGlobalProjectIds: string[]
  previewTop: number
  itemHeight: number
  itemWidth: number
  pointerOffsetY: number
}

type ThreadPressState = {
  pane: 'threads' | 'archived'
  projectId: string
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  currentX: number
  currentY: number
}

const preventThreadGroupTextSelection = (event: Event) => {
  if (event.cancelable) {
    event.preventDefault()
  }
}

const IconFolder = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
  </svg>
)

const IconPlus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

const IconNodes = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="6" height="6" rx="1.5" />
    <rect x="15" y="4" width="6" height="6" rx="1.5" />
    <rect x="3" y="14" width="6" height="6" rx="1.5" />
    <rect x="15" y="14" width="6" height="6" rx="1.5" />
  </svg>
)

const IconChat = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H11l-4.5 4v-4H7.5A2.5 2.5 0 0 1 5 12.5z" />
  </svg>
)

const IconDirectoryPlus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
    <path d="M16.5 10.5v5" />
    <path d="M14 13h5" />
  </svg>
)

const IconChevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={open ? 'is-open' : ''}>
    <path d="m9 6 6 6-6 6" />
  </svg>
)

const IconArrowRight = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m9 6 6 6-6 6" />
  </svg>
)

const IconArrowLeft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 6-6 6 6 6" />
  </svg>
)

const IconSettings = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.33 4.32c.6-1.76 2.74-1.76 3.34 0a1.78 1.78 0 0 0 2.66 1l.18-.1c1.6-.92 3.4.88 2.48 2.48l-.1.18a1.78 1.78 0 0 0 1 2.66c1.76.6 1.76 2.74 0 3.34a1.78 1.78 0 0 0-1 2.66l.1.18c.92 1.6-.88 3.4-2.48 2.48l-.18-.1a1.78 1.78 0 0 0-2.66 1c-.6 1.76-2.74 1.76-3.34 0a1.78 1.78 0 0 0-2.66-1l-.18.1c-1.6.92-3.4-.88-2.48-2.48l.1-.18a1.78 1.78 0 0 0-1-2.66c-1.76-.6-1.76-2.74 0-3.34a1.78 1.78 0 0 0 1-2.66l-.1-.18c-.92-1.6.88-3.4 2.48-2.48l.18.1a1.78 1.78 0 0 0 2.66-1Z" />
    <circle cx="12" cy="12" r="3.15" />
  </svg>
)

const IconMore = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1" fill="currentColor" stroke="none" />
  </svg>
)

type ConversationSidebarProps = {
  open: boolean
  progress?: number
  isDragging?: boolean
  desktopPinned?: boolean
  isDesktopResizing?: boolean
  onClose: () => void
  onDesktopResizeStart?: (clientX: number) => void
  currentAgent?: WorkspaceAgentSummary
  agentIndicatorState?: AgentIndicatorState
  projects: SidebarProject[]
  sessions: SidebarSession[]
  projectStats?: WorkspaceProjectStats[]
  historySessionsByProject?: Record<string, SidebarSession[]>
  archivedSessionsByProject?: Record<string, SidebarSession[]>
  historyPageStateByProject?: Record<string, WorkspaceSessionPageState>
  archivedPageStateByProject?: Record<string, WorkspaceSessionPageState>
  activeSessionId?: string
  onCreateSession: (projectId: string, projectName: string) => void
  onCreateDirectoryThread?: () => void
  onSelectSession?: (sessionId: string) => void
  onSessionAction?: (sessionId: string, action: 'pin' | 'unpin' | 'delete' | 'rename', name?: string) => Promise<void> | void
  onThreadAction?: (
    projectId: string,
    action: 'pin' | 'unpin' | 'rename' | 'remove' | 'archive' | 'unarchive' | 'reorder',
    payload?: ThreadActionPayload,
  ) => Promise<void> | void
  onOpenSettings?: () => void
  onLoadMoreHistory?: (projectId: string) => Promise<void> | void
  onLoadMoreArchived?: (projectId: string) => Promise<void> | void
  pendingSessionActionId?: string | null
  pendingThreadActionId?: string | null
}

const sessionTime = (value: string) =>
  {
    const now = Date.now()
    const target = new Date(value).getTime()
    const diff = Math.max(0, now - target)
    const minute = 60 * 1000
    const hour = 60 * minute
    const day = 24 * hour

    if (diff < hour) {
      const minutes = Math.max(1, Math.floor(diff / minute))
      return `${minutes}分钟`
    }

    if (diff < day) {
      const hours = Math.max(1, Math.floor(diff / hour))
      return `${hours}小时`
    }

    const days = Math.max(1, Math.floor(diff / day))
    return `${days}天`
  }

const getVisibleRunState = (session: SidebarSession) => {
  if (
    session.run_state === 'completed' &&
    session.run_state_changed_at &&
    Date.now() - new Date(session.run_state_changed_at).getTime() > COMPLETED_STATE_TTL_MS
  ) {
    return 'idle'
  }

  return session.run_state ?? 'idle'
}

const compareSessions = (a: SidebarSession, b: SidebarSession) =>
  Number(b.pinned) - Number(a.pinned) ||
  +new Date(b.last_event_at) - +new Date(a.last_event_at)

const getCollapsedThreadSessions = (
  threadSessions: SidebarSession[],
  activeSessionId?: string,
) => {
  if (threadSessions.length <= DEFAULT_VISIBLE_THREAD_SESSION_COUNT) {
    return threadSessions
  }

  if (!activeSessionId) {
    return threadSessions.slice(0, DEFAULT_VISIBLE_THREAD_SESSION_COUNT)
  }

  const activeSessionIndex = threadSessions.findIndex((session) => session.id === activeSessionId)
  if (activeSessionIndex === -1 || activeSessionIndex < DEFAULT_VISIBLE_THREAD_SESSION_COUNT) {
    return threadSessions.slice(0, DEFAULT_VISIBLE_THREAD_SESSION_COUNT)
  }

  return [
    ...threadSessions.slice(0, DEFAULT_VISIBLE_THREAD_SESSION_COUNT - 1),
    threadSessions[activeSessionIndex],
  ]
}

const readCompletedSeenState = () => {
  if (typeof window === 'undefined') {
    return {} as Record<string, string>
  }

  try {
    const raw = window.localStorage.getItem(COMPLETED_SEEN_STORAGE_KEY)
    if (!raw) {
      return {} as Record<string, string>
    }

    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {} as Record<string, string>
  }
}

const areProjectOrdersEqual = (left: string[], right: string[]) =>
  left.length === right.length &&
  left.every((projectId, index) => projectId === right[index])

const applyProjectOrder = (
  projects: SidebarProject[],
  orderedProjectIds: string[] | null,
) => {
  if (!orderedProjectIds || orderedProjectIds.length === 0 || projects.length <= 1) {
    return projects
  }

  const projectById = new Map(projects.map((project) => [project.id, project]))
  const seen = new Set<string>()
  const orderedProjects: SidebarProject[] = []

  for (const projectId of orderedProjectIds) {
    const project = projectById.get(projectId)
    if (!project || seen.has(projectId)) {
      continue
    }

    seen.add(projectId)
    orderedProjects.push(project)
  }

  for (const project of projects) {
    if (seen.has(project.id)) {
      continue
    }

    orderedProjects.push(project)
  }

  return orderedProjects
}

const moveProjectId = (
  projectIds: string[],
  fromIndex: number,
  toIndex: number,
) => {
  if (
    fromIndex < 0 ||
    fromIndex >= projectIds.length ||
    toIndex < 0 ||
    toIndex >= projectIds.length ||
    fromIndex === toIndex
  ) {
    return projectIds
  }

  const nextProjectIds = [...projectIds]
  const [projectId] = nextProjectIds.splice(fromIndex, 1)
  if (!projectId) {
    return projectIds
  }

  nextProjectIds.splice(toIndex, 0, projectId)
  return nextProjectIds
}

const mergeVisibleProjectOrder = (
  globalProjectIds: string[],
  visibleProjectIds: string[],
  nextVisibleProjectIds: string[],
) => {
  if (visibleProjectIds.length === 0) {
    return globalProjectIds
  }

  const visibleProjectIdSet = new Set(visibleProjectIds)
  let visibleIndex = 0

  return globalProjectIds.map((projectId) => {
    if (!visibleProjectIdSet.has(projectId)) {
      return projectId
    }

    const nextProjectId = nextVisibleProjectIds[visibleIndex] ?? projectId
    visibleIndex += 1
    return nextProjectId
  })
}

const getThreadGroupDomKey = (
  pane: 'threads' | 'archived',
  projectId: string,
) => `${pane}:${projectId}`

export const ConversationSidebar = memo(function ConversationSidebar({
  open,
  progress = open ? 1 : 0,
  isDragging = false,
  desktopPinned = false,
  isDesktopResizing = false,
  onClose,
  onDesktopResizeStart,
  currentAgent,
  agentIndicatorState,
  projects,
  sessions,
  projectStats = [],
  historySessionsByProject = {},
  archivedSessionsByProject = {},
  historyPageStateByProject = {},
  archivedPageStateByProject = {},
  activeSessionId,
  onCreateSession,
  onCreateDirectoryThread,
  onSelectSession,
  onSessionAction,
  onThreadAction,
  onOpenSettings,
  onLoadMoreHistory,
  onLoadMoreArchived,
  pendingSessionActionId,
  pendingThreadActionId,
}: ConversationSidebarProps) {
  const navigate = useNavigate()
  const isVisible = progress > 0.001
  const hasCurrentAgent = Boolean(currentAgent)
  const resolvedAgentIndicatorState =
    hasCurrentAgent
      ? (agentIndicatorState ?? (currentAgent?.status === 'online' ? 'online' : 'offline'))
      : null
  const agentIndicatorLabel = resolvedAgentIndicatorState
    ? getAgentIndicatorLabel(resolvedAgentIndicatorState)
    : '未选择节点'
  const paneRefs = useRef<Record<'threads' | 'archived', HTMLDivElement | null>>({
    threads: null,
    archived: null,
  })
  const threadGroupRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const threadLongPressTimeoutRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  const threadPressStateRef = useRef<ThreadPressState | null>(null)
  const threadPressTargetRef = useRef<HTMLButtonElement | null>(null)
  const threadDragStateRef = useRef<ThreadDragState | null>(null)
  const suppressProjectToggleRef = useRef<string | null>(null)
  const threadGroupPositionsRef = useRef<Record<string, number>>({})
  const threadGroupAnimationFrameRef = useRef<number | null>(null)
  const [optimisticSessionPatches, setOptimisticSessionPatches] = useState<
    Record<string, OptimisticSessionPatch>
  >({})
  const [optimisticProjectOrderIds, setOptimisticProjectOrderIds] = useState<string[] | null>(null)
  const [threadDragState, setThreadDragState] = useState<ThreadDragState | null>(null)
  const mergedSessions = useMemo(
    () =>
      sessions
        .map((session) => {
          const patch = optimisticSessionPatches[session.id]
          if (!patch) {
            return session
          }

          return {
            ...session,
            ...(patch.pinned === undefined ? null : { pinned: patch.pinned }),
          }
        })
        .filter((session) => !optimisticSessionPatches[session.id]?.hidden),
    [optimisticSessionPatches, sessions],
  )
  const projectStatsById = useMemo(
    () =>
      new Map(projectStats.map((stats) => [stats.project_id, stats])),
    [projectStats],
  )
  const renderedProjectOrderIds =
    threadDragState?.nextGlobalProjectIds ?? optimisticProjectOrderIds
  const orderedProjects = useMemo(
    () => applyProjectOrder(projects, renderedProjectOrderIds),
    [projects, renderedProjectOrderIds],
  )
  const sidebarSessions = useMemo(
    () => mergedSessions.filter((session) => !session.subagent),
    [mergedSessions],
  )
  const activeSession = sidebarSessions.find((session) => session.id === activeSessionId)
  const activeProjectId =
    activeSession?.project_id
  const [expandedProjects, setExpandedProjects] = useState<string[]>(
    activeProjectId ? [activeProjectId] : [],
  )
  const [sidebarView, setSidebarView] = useState<'threads' | 'archived'>('threads')
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null)
  const [openThreadMenuProjectId, setOpenThreadMenuProjectId] = useState<string | null>(null)
  const [mobileThreadMenuProjectId, setMobileThreadMenuProjectId] = useState<string | null>(null)
  const [expandedThreadSessionProjects, setExpandedThreadSessionProjects] = useState<string[]>([])
  const [renameProjectId, setRenameProjectId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [completedSeenAt, setCompletedSeenAt] = useState<Record<string, string>>(
    () => readCompletedSeenState(),
  )
  const activeSessions = useMemo(
    () => sidebarSessions.filter((session) => !session.archived),
    [sidebarSessions],
  )
  const pinnedSessions = useMemo(
    () =>
      activeSessions
        .filter((session) => session.pinned)
        .sort((a, b) => +new Date(b.last_event_at) - +new Date(a.last_event_at)),
    [activeSessions],
  )
  const unpinnedActiveSessions = useMemo(
    () => activeSessions.filter((session) => !session.pinned),
    [activeSessions],
  )
  const buildThreadGroups = (pane: 'threads' | 'archived') =>
    orderedProjects
      .map((project) => {
        const projectStatsEntry = projectStatsById.get(project.id)
        const primarySessions =
          pane === 'threads'
            ? unpinnedActiveSessions.filter((session) => session.project_id === project.id)
            : ((archivedSessionsByProject[project.id] ?? []) as SidebarSession[])
        const loadedPagedSessions =
          pane === 'threads'
            ? ((historySessionsByProject[project.id] ?? []) as SidebarSession[])
            : []
        const mergedThreadSessions = [...primarySessions]
        for (const session of loadedPagedSessions) {
          if (!mergedThreadSessions.some((item) => item.id === session.id)) {
            mergedThreadSessions.push(session)
          }
        }
        const threadSessions = mergedThreadSessions.sort((a, b) =>
          compareSessions(a as SidebarSession, b as SidebarSession),
        )
        const pageState =
          pane === 'threads'
            ? (historyPageStateByProject[project.id] ?? EMPTY_WORKSPACE_SESSION_PAGE_STATE)
            : (archivedPageStateByProject[project.id] ?? EMPTY_WORKSPACE_SESSION_PAGE_STATE)
        const totalSessionCount =
          pane === 'threads'
            ? threadSessions.length + Math.max(0, projectStatsEntry?.hidden_history_count ?? 0)
            : Math.max(
                threadSessions.length,
                projectStatsEntry?.archived_session_count ?? 0,
              )
        const remainingPageCount =
          pane === 'threads'
            ? Math.max(
                0,
                (projectStatsEntry?.hidden_history_count ?? 0) - pageState.sessions.length,
              )
            : Math.max(
                0,
                (projectStatsEntry?.archived_session_count ?? 0) - pageState.sessions.length,
              )

        const latestEventAt =
          threadSessions[0]?.last_event_at ??
          new Date(0).toISOString()

        return {
          project,
          threadSessions,
          collapsedThreadSessions: getCollapsedThreadSessions(threadSessions, activeSessionId),
          hiddenSessionCount: Math.max(0, threadSessions.length - DEFAULT_VISIBLE_THREAD_SESSION_COUNT),
          totalSessionCount,
          pageState,
          remainingPageCount,
          latestEventAt,
        }
      })
      .filter(({ totalSessionCount }) => totalSessionCount > 0)

  const primaryThreadGroups = useMemo(
    () => buildThreadGroups('threads'),
    [
      activeSessionId,
      archivedPageStateByProject,
      archivedSessionsByProject,
      historyPageStateByProject,
      historySessionsByProject,
      orderedProjects,
      projectStatsById,
      unpinnedActiveSessions,
    ],
  )
  const archivedThreadGroups = useMemo(
    () => buildThreadGroups('archived'),
    [
      activeSessionId,
      archivedPageStateByProject,
      archivedSessionsByProject,
      historyPageStateByProject,
      historySessionsByProject,
      orderedProjects,
      projectStatsById,
      unpinnedActiveSessions,
    ],
  )

  useEffect(() => {
    setOptimisticSessionPatches((current) => {
      let changed = false
      const next = { ...current }

      for (const [sessionId, patch] of Object.entries(current)) {
        const liveSession = sessions.find((session) => session.id === sessionId)

        if (!liveSession) {
          if (patch.hidden) {
            delete next[sessionId]
            changed = true
          }
          continue
        }

        const pinnedSettled =
          patch.pinned === undefined || liveSession.pinned === patch.pinned
        if (pinnedSettled && !patch.hidden) {
          delete next[sessionId]
          changed = true
        }
      }

      return changed ? next : current
    })
  }, [sessions])

  useEffect(() => {
    setOptimisticProjectOrderIds((current) => {
      if (!current) {
        return current
      }

      const liveProjectIds = projects.map((project) => project.id)
      const nextProjectIds = [
        ...current.filter((projectId) => liveProjectIds.includes(projectId)),
        ...liveProjectIds.filter((projectId) => !current.includes(projectId)),
      ]

      return areProjectOrdersEqual(nextProjectIds, liveProjectIds)
        ? null
        : nextProjectIds
    })
  }, [projects])

  useEffect(() => {
    if (!activeProjectId) {
      return
    }

    setExpandedProjects((current) =>
      current.includes(activeProjectId) ? current : [...current, activeProjectId],
    )
  }, [activeProjectId])

  useEffect(() => {
    setSidebarView(activeSession?.archived ? 'archived' : 'threads')
  }, [activeSession?.archived, activeSessionId])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(
        COMPLETED_SEEN_STORAGE_KEY,
        JSON.stringify(completedSeenAt),
      )
    } catch {
      // Ignore storage failures; this state is only for UI polish.
    }
  }, [completedSeenAt])

  useEffect(() => {
    if (open || desktopPinned) {
      return
    }

    setOpenThreadMenuProjectId(null)
    setMobileThreadMenuProjectId(null)
    setRenameProjectId(null)
    setConfirmDeleteSessionId(null)
  }, [desktopPinned, open])

  useEffect(() => {
    if (!desktopPinned || !openThreadMenuProjectId) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) {
        setOpenThreadMenuProjectId(null)
        return
      }

      if (
        target.closest('.thread-group__menu-anchor') ||
        target.closest('.thread-group__menu')
      ) {
        return
      }

      setOpenThreadMenuProjectId(null)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [desktopPinned, openThreadMenuProjectId])

  useEffect(() => {
    if (!activeSessionId) {
      return
    }

    const active = sidebarSessions.find((session) => session.id === activeSessionId)
    if (
      !active ||
      getVisibleRunState(active) !== 'completed' ||
      !active.run_state_changed_at
    ) {
      return
    }

    const completedAt = active.run_state_changed_at

    setCompletedSeenAt((current) => {
      if (current[active.id] === completedAt) {
        return current
      }

      return {
        ...current,
        [active.id]: completedAt,
      }
    })
  }, [activeSessionId, sidebarSessions])

  useEffect(() => {
    return () => {
      if (threadLongPressTimeoutRef.current !== null) {
        globalThis.clearTimeout(threadLongPressTimeoutRef.current)
      }
      clearThreadSelectionSuppression()
      if (threadGroupAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(threadGroupAnimationFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    threadDragStateRef.current = threadDragState
  }, [threadDragState])

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const nextPositions: Record<string, number> = {}
    const animatedElements: HTMLDivElement[] = []
    const draggingDomKey = threadDragState
      ? getThreadGroupDomKey(threadDragState.pane, threadDragState.projectId)
      : null

    for (const [domKey, element] of Object.entries(threadGroupRefs.current)) {
      if (!element) {
        continue
      }

      const nextTop = element.offsetTop
      nextPositions[domKey] = nextTop
      if (draggingDomKey === domKey) {
        continue
      }

      const previousTop = threadGroupPositionsRef.current[domKey]
      if (previousTop === undefined) {
        continue
      }

      const deltaY = previousTop - nextTop
      if (Math.abs(deltaY) < 0.5) {
        continue
      }

      element.style.transition = 'none'
      element.style.transform = `translateY(${deltaY}px)`
      animatedElements.push(element)
    }

    if (threadGroupAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(threadGroupAnimationFrameRef.current)
    }

    if (animatedElements.length > 0) {
      threadGroupAnimationFrameRef.current = window.requestAnimationFrame(() => {
        for (const element of animatedElements) {
          element.style.transition = ''
          element.style.transform = ''
        }
      })
    }

    threadGroupPositionsRef.current = nextPositions
  }, [
    primaryThreadGroups,
    archivedThreadGroups,
    expandedProjects,
    expandedThreadSessionProjects,
    threadDragState?.projectId,
    renderedProjectOrderIds,
  ])

  const clearThreadLongPress = () => {
    if (threadLongPressTimeoutRef.current === null) {
      return
    }

    globalThis.clearTimeout(threadLongPressTimeoutRef.current)
    threadLongPressTimeoutRef.current = null
  }

  const clearThreadSelectionSuppression = () => {
    const pressTarget = threadPressTargetRef.current
    if (!pressTarget) {
      return
    }

    pressTarget.removeEventListener('selectstart', preventThreadGroupTextSelection)
    pressTarget.removeEventListener('contextmenu', preventThreadGroupTextSelection)
    threadPressTargetRef.current = null
  }

  const getVisibleThreadGroups = (pane: 'threads' | 'archived') =>
    pane === 'threads' ? primaryThreadGroups : archivedThreadGroups

  const startThreadDrag = (
    projectId: string,
    pane: 'threads' | 'archived',
    pointerId: number,
    pointerType: string,
    clientY: number,
  ) => {
    const paneElement = paneRefs.current[pane]
    const threadGroupElement = threadGroupRefs.current[getThreadGroupDomKey(pane, projectId)]
    if (!paneElement || !threadGroupElement) {
      return false
    }

    const visibleProjectIds = getVisibleThreadGroups(pane).map((item) => item.project.id)
    const originIndex = visibleProjectIds.indexOf(projectId)
    if (originIndex === -1) {
      return false
    }

    const orderedProjectIds = orderedProjects.map((project) => project.id)
    const paneRect = paneElement.getBoundingClientRect()
    const itemRect = threadGroupElement.getBoundingClientRect()
    const itemHeight = threadGroupElement.offsetHeight
    const itemWidth = threadGroupElement.offsetWidth
    const pointerOffsetY = clientY - itemRect.top
    const minTop = paneElement.scrollTop
    const maxTop = Math.max(minTop, paneElement.scrollTop + paneElement.clientHeight - itemHeight)
    const previewTop = Math.max(
      minTop,
      Math.min(
        maxTop,
        paneElement.scrollTop + clientY - paneRect.top - pointerOffsetY,
      ),
    )
    const nextDragState = {
      pane,
      projectId,
      pointerId,
      pointerType,
      originIndex,
      visibleProjectIds,
      nextVisibleProjectIds: visibleProjectIds,
      nextGlobalProjectIds: orderedProjectIds,
      previewTop,
      itemHeight,
      itemWidth,
      pointerOffsetY,
    }
    threadDragStateRef.current = nextDragState
    setThreadDragState(nextDragState)
    suppressProjectToggleRef.current = projectId
    return true
  }

  const updateThreadDrag = (clientY: number) => {
    setThreadDragState((current) => {
      if (!current) {
        return current
      }

      threadDragStateRef.current = current

      const paneElement = paneRefs.current[current.pane]
      if (
        !paneElement ||
        !threadGroupRefs.current[getThreadGroupDomKey(current.pane, current.projectId)]
      ) {
        return current
      }

      const paneRect = paneElement.getBoundingClientRect()
      const minTop = paneElement.scrollTop
      const maxTop = Math.max(minTop, paneElement.scrollTop + paneElement.clientHeight - current.itemHeight)
      const previewTop = Math.max(
        minTop,
        Math.min(
          maxTop,
          paneElement.scrollTop + clientY - paneRect.top - current.pointerOffsetY,
        ),
      )
      const previewCenter = previewTop + current.itemHeight / 2
      const baseVisibleProjectIds = current.nextVisibleProjectIds
      const currentIndex = baseVisibleProjectIds.indexOf(current.projectId)
      if (currentIndex === -1) {
        return current
      }

      const remainingProjectIds = baseVisibleProjectIds.filter(
        (projectId) => projectId !== current.projectId,
      )

      let insertionIndex = 0
      const firstRemainingProjectId = remainingProjectIds[0]
      const firstRemainingElement = firstRemainingProjectId
        ? threadGroupRefs.current[getThreadGroupDomKey(current.pane, firstRemainingProjectId)]
        : null
      if (
        firstRemainingElement &&
        previewTop <= firstRemainingElement.offsetTop + firstRemainingElement.offsetHeight * 0.42
      ) {
        insertionIndex = 0
      } else {
        for (let index = 0; index < remainingProjectIds.length; index += 1) {
          const projectId = remainingProjectIds[index]
          const element = projectId
            ? threadGroupRefs.current[getThreadGroupDomKey(current.pane, projectId)]
            : null
          if (!element) {
            insertionIndex = index + 1
            continue
          }

          const elementCenter = element.offsetTop + element.offsetHeight / 2
          if (previewCenter <= elementCenter) {
            insertionIndex = index
            break
          }

          insertionIndex = index + 1
        }
      }

      const nextVisibleProjectIds = moveProjectId(
        baseVisibleProjectIds,
        currentIndex,
        insertionIndex,
      )
      const nextGlobalProjectIds = mergeVisibleProjectOrder(
        current.nextGlobalProjectIds,
        current.visibleProjectIds,
        nextVisibleProjectIds,
      )

      if (
        previewTop === current.previewTop &&
        areProjectOrdersEqual(nextVisibleProjectIds, current.nextVisibleProjectIds)
      ) {
        return current
      }

      const nextDragState = {
        ...current,
        previewTop,
        nextVisibleProjectIds,
        nextGlobalProjectIds,
      }
      threadDragStateRef.current = nextDragState
      return nextDragState
    })
  }

  const finishThreadDrag = (dragStateOverride?: ThreadDragState | null) => {
    clearThreadLongPress()
    clearThreadSelectionSuppression()
    threadPressStateRef.current = null
    const currentDragState = dragStateOverride ?? threadDragStateRef.current
    threadDragStateRef.current = null
    setThreadDragState(null)

    if (!currentDragState) {
      return
    }

    const nextOrderChanged = !areProjectOrdersEqual(
      currentDragState.visibleProjectIds,
      currentDragState.nextVisibleProjectIds,
    )

    if (!nextOrderChanged || !onThreadAction) {
      return
    }

    const previousProjectOrderIds =
      optimisticProjectOrderIds ?? orderedProjects.map((project) => project.id)
    const nextProjectOrderIds = currentDragState.nextGlobalProjectIds
    setOptimisticProjectOrderIds(nextProjectOrderIds)
    void Promise.resolve(
      onThreadAction(currentDragState.projectId, 'reorder', {
        orderedProjectIds: nextProjectOrderIds,
      }),
    ).catch(() => {
      setOptimisticProjectOrderIds(previousProjectOrderIds)
    })
  }

  const cancelThreadDrag = () => {
    clearThreadLongPress()
    clearThreadSelectionSuppression()
    threadPressStateRef.current = null
    threadDragStateRef.current = null
    setThreadDragState(null)
  }

  useEffect(() => {
    if (typeof window === 'undefined' || !threadDragStateRef.current) {
      return
    }

    const handlePointerMove = (event: PointerEvent) => {
      const currentDragState = threadDragStateRef.current
      if (!currentDragState || currentDragState.pointerId !== event.pointerId) {
        return
      }

      updateThreadDrag(event.clientY)
    }

    const handlePointerUp = (event: PointerEvent) => {
      const currentDragState = threadDragStateRef.current
      if (!currentDragState || currentDragState.pointerId !== event.pointerId) {
        return
      }

      finishThreadDrag(currentDragState)
    }

    const handlePointerCancel = (event: PointerEvent) => {
      const currentDragState = threadDragStateRef.current
      if (!currentDragState || currentDragState.pointerId !== event.pointerId) {
        return
      }

      cancelThreadDrag()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [threadDragState?.pointerId])

  const toggleProject = (projectId: string) => {
    setExpandedProjects((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    )
  }

  const handleProjectToggleClick = (projectId: string) => {
    if (suppressProjectToggleRef.current === projectId) {
      suppressProjectToggleRef.current = null
      return
    }

    toggleProject(projectId)
  }

  const handleThreadGroupPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    projectId: string,
    pane: 'threads' | 'archived',
  ) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }

    clearThreadLongPress()
    const target = event.currentTarget
    clearThreadSelectionSuppression()
    if (event.pointerType === 'touch') {
      threadPressTargetRef.current = target
      target.addEventListener('selectstart', preventThreadGroupTextSelection)
      target.addEventListener('contextmenu', preventThreadGroupTextSelection)
    }
    threadPressStateRef.current = {
      pane,
      projectId,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    }
    if (event.pointerType !== 'touch') {
      target.setPointerCapture(event.pointerId)
    }

    if (event.pointerType === 'touch') {
      threadLongPressTimeoutRef.current = globalThis.setTimeout(() => {
        const pressState = threadPressStateRef.current
        if (
          !pressState ||
          pressState.projectId !== projectId ||
          pressState.pointerId !== event.pointerId
        ) {
          return
        }

        if (!target.hasPointerCapture(event.pointerId)) {
          target.setPointerCapture(event.pointerId)
        }
        const started = startThreadDrag(
          projectId,
          pane,
          event.pointerId,
          event.pointerType,
          pressState.currentY,
        )
        if (started) {
          updateThreadDrag(pressState.currentY)
        }
      }, THREAD_DRAG_LONG_PRESS_MS)
    }
  }

  const handleThreadGroupPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
    projectId: string,
    pane: 'threads' | 'archived',
  ) => {
    const pressState = threadPressStateRef.current
    if (
      !pressState ||
      pressState.projectId !== projectId ||
      pressState.pointerId !== event.pointerId ||
      pressState.pane !== pane
    ) {
      return
    }

    pressState.currentX = event.clientX
    pressState.currentY = event.clientY

    if (threadDragState?.projectId === projectId && threadDragState.pointerId === event.pointerId) {
      event.preventDefault()
      updateThreadDrag(event.clientY)
      return
    }

    const deltaX = event.clientX - pressState.startX
    const deltaY = event.clientY - pressState.startY

    if (pressState.pointerType === 'touch') {
      if (Math.abs(deltaX) > THREAD_DRAG_START_DISTANCE_PX || Math.abs(deltaY) > THREAD_DRAG_START_DISTANCE_PX) {
        clearThreadLongPress()
      }
      return
    }

    if (
      Math.abs(deltaY) < THREAD_DRAG_START_DISTANCE_PX ||
      Math.abs(deltaY) < Math.abs(deltaX)
    ) {
      return
    }

    const started = startThreadDrag(
      projectId,
      pane,
      event.pointerId,
      event.pointerType,
      event.clientY,
    )
    if (!started) {
      return
    }

    event.preventDefault()
    updateThreadDrag(event.clientY)
  }

  const handleThreadGroupPointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
    projectId: string,
  ) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (threadDragState?.projectId === projectId && threadDragState.pointerId === event.pointerId) {
      event.preventDefault()
      finishThreadDrag()
      return
    }

    clearThreadLongPress()
    clearThreadSelectionSuppression()
    threadPressStateRef.current = null
  }

  const handleThreadGroupPointerCancel = (
    event: ReactPointerEvent<HTMLButtonElement>,
    projectId: string,
  ) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (threadDragState?.projectId === projectId && threadDragState.pointerId === event.pointerId) {
      cancelThreadDrag()
      return
    }

    clearThreadLongPress()
    clearThreadSelectionSuppression()
    threadPressStateRef.current = null
  }

  const toggleThreadSessionExpansion = (projectId: string) => {
    setExpandedThreadSessionProjects((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    )
  }

  const markSessionCompletionSeen = (session: SidebarSession) => {
    if (
      getVisibleRunState(session) !== 'completed' ||
      !session.run_state_changed_at
    ) {
      return
    }

    const completedAt = session.run_state_changed_at

    setCompletedSeenAt((current) => {
      if (current[session.id] === completedAt) {
        return current
      }

      return {
        ...current,
        [session.id]: completedAt,
      }
    })
  }

  const sidebarPaneIndex =
    sidebarView === 'threads' ? 0 : 1
  const sidebarPaneTranslate = `translateX(-${sidebarPaneIndex * 50}%)`
  const renameProjectDialog =
    renameProjectId && typeof document !== 'undefined'
      ? createPortal(
          <div className="sheet-wrap sheet-wrap--centered" role="dialog" aria-modal="true">
            <button
              type="button"
              className="sheet-wrap__scrim"
              onClick={() => {
                setRenameProjectId(null)
                setRenameDraft('')
              }}
              aria-label="关闭重命名面板"
            />
            <div className="sheet-wrap__center">
              <div className="sheet-panel sheet-panel--form sheet-panel--centered">
                <div className="sheet-panel__title">编辑线程名称</div>
                <input
                  className="sheet-panel__input"
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  placeholder="输入线程名称"
                  autoFocus
                />
                <div className="sheet-panel__actions">
                  <button
                    type="button"
                    className="sheet-panel__button"
                    onClick={() => {
                      setRenameProjectId(null)
                      setRenameDraft('')
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="sheet-panel__button is-primary"
                    disabled={!renameDraft.trim() || pendingThreadActionId === renameProjectId}
                    onClick={() => {
                      void submitRename()
                    }}
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  const openRenameDialog = (project: SidebarProject) => {
    setOpenThreadMenuProjectId(null)
    setMobileThreadMenuProjectId(null)
    setRenameProjectId(project.id)
    setRenameDraft(project.display_name ?? project.name)
  }

  const submitRename = async () => {
    if (!renameProjectId || !renameDraft.trim() || !onThreadAction) {
      return
    }

    await onThreadAction(renameProjectId, 'rename', { name: renameDraft.trim() })
    setRenameProjectId(null)
    setRenameDraft('')
  }

  const runSessionAction = (
    session: SidebarSession,
    action: 'pin' | 'unpin' | 'delete' | 'rename',
    name?: string,
  ) => {
    if (!onSessionAction) {
      return
    }

    const previousPatch = optimisticSessionPatches[session.id]

    if (action === 'pin' || action === 'unpin') {
      setOptimisticSessionPatches((current) => ({
        ...current,
        [session.id]: {
          ...current[session.id],
          pinned: action === 'pin',
        },
      }))
    } else if (action === 'delete') {
      setOptimisticSessionPatches((current) => ({
        ...current,
        [session.id]: {
          ...current[session.id],
          hidden: true,
        },
      }))
    }

    const result = onSessionAction(session.id, action, name)

    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch(() => {
        setOptimisticSessionPatches((current) => {
          const next = { ...current }
          if (previousPatch) {
            next[session.id] = previousPatch
          } else {
            delete next[session.id]
          }
          return next
        })
      })
    }
  }

  const renderSessionItem = (session: SidebarSession) => {
    const visibleRunState = getVisibleRunState(session)
    const shouldShowCompletedDot =
      visibleRunState === 'completed' &&
      session.id !== activeSessionId &&
      Boolean(session.run_state_changed_at) &&
      completedSeenAt[session.id] !== session.run_state_changed_at
    const isHovered = desktopPinned && hoveredSessionId === session.id
    const showPinButton = Boolean(onSessionAction) && isHovered
    const showDeleteConfirm = confirmDeleteSessionId === session.id
    const showHoverActions = desktopPinned && (showPinButton || showDeleteConfirm)

    return (
      <div
        key={session.id}
        className={`thread-session ${session.id === activeSessionId ? 'is-active' : ''}`}
        onMouseEnter={() => setHoveredSessionId(session.id)}
        onMouseLeave={() => {
          setHoveredSessionId((current) => current === session.id ? null : current)
          setConfirmDeleteSessionId((current) => current === session.id ? null : current)
        }}
      >
        <button
          type="button"
          className={`thread-session__icon-button ${showPinButton ? 'is-visible' : ''} ${session.pinned ? 'is-active' : ''}`}
          disabled={pendingSessionActionId === session.id}
          onClick={(event) => {
            event.stopPropagation()
            runSessionAction(session, session.pinned ? 'unpin' : 'pin')
          }}
          aria-label={session.pinned ? '取消置顶会话' : '置顶会话'}
          title={session.pinned ? '取消置顶' : '置顶'}
        >
          <Pin strokeWidth={session.pinned ? 2.1 : 1.95} />
        </button>

        <div className="thread-session__row">
          {onSelectSession ? (
            <button
              type="button"
              className="thread-session__link thread-session__link--button"
              title={session.title}
              onClick={() => {
                markSessionCompletionSeen(session)
                onSelectSession(session.id)
                onClose()
              }}
            >
              <span
                className={`thread-session__status is-${
                  shouldShowCompletedDot ? 'completed' : visibleRunState
                } ${shouldShowCompletedDot ? 'is-unread' : ''} ${showHoverActions ? 'is-hidden' : ''}`}
                aria-hidden="true"
              />
              <div className="thread-session__title">{session.title}</div>
            </button>
          ) : (
            <Link
              to="/session/$sessionId"
              params={{ sessionId: session.id }}
              title={session.title}
              onClick={() => {
                markSessionCompletionSeen(session)
                onClose()
              }}
              className="thread-session__link"
            >
              <span
                className={`thread-session__status is-${
                  shouldShowCompletedDot ? 'completed' : visibleRunState
                } ${shouldShowCompletedDot ? 'is-unread' : ''} ${showHoverActions ? 'is-hidden' : ''}`}
                aria-hidden="true"
              />
              <div className="thread-session__title">{session.title}</div>
            </Link>
          )}

          <div className="thread-session__meta">
            {desktopPinned && isHovered && onSessionAction ? (
              showDeleteConfirm ? (
                <button
                  type="button"
                  className="thread-session__delete-confirm"
                  disabled={pendingSessionActionId === session.id}
                  onClick={(event) => {
                    event.stopPropagation()
                    runSessionAction(session, 'delete')
                  }}
                >
                  确认
                </button>
              ) : (
                <button
                  type="button"
                  className="thread-session__delete"
                  disabled={pendingSessionActionId === session.id}
                  onClick={(event) => {
                    event.stopPropagation()
                    setConfirmDeleteSessionId(session.id)
                  }}
                  aria-label={`删除 ${session.title}`}
                >
                  <Trash2 strokeWidth={1.95} />
                </button>
              )
            ) : (
              <span className="thread-session__time">{sessionTime(session.last_event_at)}</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  const renderThreadGroup = ({
    project,
    threadSessions,
    collapsedThreadSessions,
    hiddenSessionCount,
    totalSessionCount,
    pageState,
    remainingPageCount,
  }: ThreadGroupRenderItem, pane: 'threads' | 'archived') => {
    const threadGroupDomKey = getThreadGroupDomKey(pane, project.id)
    const isExpanded = expandedProjects.includes(project.id)
    const isSessionListExpanded = expandedThreadSessionProjects.includes(project.id)
    const displayName = project.display_name ?? project.name
    const showThreadMenu = Boolean(onThreadAction) && desktopPinned && openThreadMenuProjectId === project.id
    const mobileThreadMenuOpen = Boolean(onThreadAction) && mobileThreadMenuProjectId === project.id
    const isArchivedThreadGroup = pane === 'archived'
    const visibleThreadSessions = isSessionListExpanded ? threadSessions : collapsedThreadSessions
    const showThreadSessionToggle = hiddenSessionCount > 0
    const canLoadMore = remainingPageCount > 0
    const handleLoadMore = pane === 'threads' ? onLoadMoreHistory : onLoadMoreArchived
    const isDraggingThreadGroup =
      threadDragState?.projectId === project.id && threadDragState.pane === pane

    const mobileThreadMenuDialog =
      mobileThreadMenuOpen && typeof document !== 'undefined'
        ? createPortal(
            <div className="sheet-wrap" role="dialog" aria-modal="true">
              <button
                type="button"
                className="sheet-wrap__scrim"
                onClick={() => setMobileThreadMenuProjectId(null)}
                aria-label="关闭线程菜单"
              />
              <div className="sheet-panel">
                <div className="sheet-panel__title">{displayName}</div>
                <button type="button" className="sheet-panel__item" onClick={() => openRenameDialog(project)}>
                  编辑名称
                </button>
                <button
                  type="button"
                  className="sheet-panel__item"
                  disabled={pendingThreadActionId === project.id}
                  onClick={() => {
                    void onThreadAction?.(project.id, isArchivedThreadGroup ? 'unarchive' : 'archive')
                    setMobileThreadMenuProjectId(null)
                  }}
                >
                  {isArchivedThreadGroup ? '取消归档' : '归档线程'}
                </button>
                <button
                  type="button"
                  className="sheet-panel__item is-danger"
                  disabled={pendingThreadActionId === project.id}
                  onClick={() => {
                    void onThreadAction?.(project.id, 'remove')
                    setMobileThreadMenuProjectId(null)
                  }}
                >
                  移除
                </button>
              </div>
            </div>,
            document.body,
          )
        : null

    return (
      <Fragment key={project.id}>
      <div
        ref={(node) => {
          threadGroupRefs.current[threadGroupDomKey] = node
        }}
        className={`thread-group-shell ${isDraggingThreadGroup ? 'is-drag-placeholder' : ''}`}
      >
      <section key={project.id} className="thread-group">
        <div className="thread-group__header">
          <button
            type="button"
            className="thread-group__title"
            onClick={() => handleProjectToggleClick(project.id)}
            onPointerDown={(event) => handleThreadGroupPointerDown(event, project.id, pane)}
            onPointerMove={(event) => handleThreadGroupPointerMove(event, project.id, pane)}
            onPointerUp={(event) => handleThreadGroupPointerUp(event, project.id)}
            onPointerCancel={(event) => handleThreadGroupPointerCancel(event, project.id)}
            aria-expanded={isExpanded}
            title={displayName}
          >
            <span className="thread-group__chevron"><IconChevron open={isExpanded} /></span>
            <span className="thread-group__icon"><IconFolder /></span>
            <span className="thread-group__title-text">{displayName}</span>
          </button>
          <div className="thread-group__actions">
            {onThreadAction ? (
              <div className="thread-group__menu-anchor">
                <button
                  type="button"
                  className={`thread-group__more ${showThreadMenu || mobileThreadMenuOpen ? 'is-open' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (desktopPinned) {
                      setOpenThreadMenuProjectId((current) => current === project.id ? null : project.id)
                      return
                    }

                    setMobileThreadMenuProjectId(project.id)
                  }}
                  aria-label={`${displayName} 更多选项`}
                >
                  <IconMore />
                </button>

                {showThreadMenu ? (
                  <div className="thread-group__menu">
                    <button
                      type="button"
                      className="thread-group__menu-item"
                      onClick={() => openRenameDialog(project)}
                    >
                      编辑名称
                    </button>
                    <button
                      type="button"
                      className="thread-group__menu-item"
                      disabled={pendingThreadActionId === project.id}
                      onClick={() => {
                        void onThreadAction?.(project.id, isArchivedThreadGroup ? 'unarchive' : 'archive')
                        setOpenThreadMenuProjectId(null)
                      }}
                    >
                      {isArchivedThreadGroup ? '取消归档' : '归档线程'}
                    </button>
                    <button
                      type="button"
                      className="thread-group__menu-item is-danger"
                      disabled={pendingThreadActionId === project.id}
                      onClick={() => {
                        void onThreadAction?.(project.id, 'remove')
                        setOpenThreadMenuProjectId(null)
                      }}
                    >
                      移除
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              className="thread-group__add"
              onClick={(event) => {
                event.stopPropagation()
                onCreateSession(project.id, project.name)
              }}
              aria-label={`在 ${project.name} 下新增会话`}
            >
              <IconPlus />
            </button>
          </div>
        </div>

        {!isExpanded ? null : totalSessionCount === 0 ? (
          <div className="thread-group__empty">这个线程还没有会话</div>
        ) : (
          <>
            {visibleThreadSessions.length > 0 ? (
              <div className="thread-group__sessions">
                {visibleThreadSessions.map((session) => renderSessionItem(session as SidebarSession))}
              </div>
            ) : (
              <div className="thread-group__empty">
                {pane === 'archived' ? '这个归档线程还没有已加载的会话' : '这个线程还没有已加载的历史会话'}
              </div>
            )}
            {showThreadSessionToggle ? (
              <button
                type="button"
                className="thread-group__session-toggle"
                onClick={() => toggleThreadSessionExpansion(project.id)}
                aria-expanded={isSessionListExpanded}
              >
                {isSessionListExpanded ? '折叠显示' : '展开显示'}
              </button>
            ) : null}
            {canLoadMore && handleLoadMore ? (
              <button
                type="button"
                className="thread-group__session-toggle"
                disabled={pageState.isLoading}
                onClick={() => {
                  void handleLoadMore(project.id)
                }}
              >
                {pageState.isLoading
                  ? '加载中...'
                  : pane === 'archived'
                    ? `加载已归档会话 (${remainingPageCount})`
                    : `加载更早会话 (${remainingPageCount})`}
              </button>
            ) : null}
            {pageState.error ? (
              <div className="thread-group__empty">{pageState.error}</div>
            ) : null}
          </>
        )}

      </section>
      </div>
      {mobileThreadMenuDialog}
      </Fragment>
    )
  }

  const renderThreadDragPreview = (pane: 'threads' | 'archived') => {
    if (!threadDragState || threadDragState.pane !== pane) {
      return null
    }

    const dragGroup = getVisibleThreadGroups(pane).find(
      (group) => group.project.id === threadDragState.projectId,
    )
    if (!dragGroup) {
      return null
    }

    const dragPreviewStyle = {
      top: threadDragState.previewTop,
      width: `${threadDragState.itemWidth}px`,
    } as CSSProperties
    const displayName =
      dragGroup.project.display_name ?? dragGroup.project.name

    return (
      <div className="thread-group-drag-preview" style={dragPreviewStyle} aria-hidden="true">
        <div className="thread-group-drag-preview__header">
          <span className="thread-group-drag-preview__chevron"><IconChevron open={true} /></span>
          <span className="thread-group-drag-preview__icon"><IconFolder /></span>
          <span className="thread-group-drag-preview__title">{displayName}</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        className={`sidebar-scrim ${isVisible ? 'is-visible' : ''}`}
        style={{
          opacity: desktopPinned ? 0 : progress,
          pointerEvents: desktopPinned ? 'none' : isVisible ? 'auto' : 'none',
          transition: isDragging ? 'none' : undefined,
        }}
        onClick={onClose}
        aria-label="关闭侧边栏"
      />

      <aside
        className={`conversation-sidebar ${open ? 'is-open' : ''} ${desktopPinned ? 'is-desktop-pinned' : ''} ${isDesktopResizing ? 'is-resizing' : ''}`}
        style={{
          transform: desktopPinned
            ? 'translateX(0)'
            : `translateX(calc(-100% + ${Math.max(0, Math.min(progress, 1)) * 100}%))`,
          transition: isDragging ? 'none' : undefined,
        }}
      >
        {desktopPinned && onDesktopResizeStart ? (
          <div
            className="conversation-sidebar__resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧边栏宽度"
            onPointerDown={(event) => {
              if (event.pointerType === 'touch') {
                return
              }

              event.preventDefault()
              event.stopPropagation()
              onDesktopResizeStart(event.clientX)
            }}
          />
        ) : null}

        <div className="conversation-sidebar__header">
          <div
            className={`conversation-sidebar__brand ${
              hasCurrentAgent && resolvedAgentIndicatorState
                ? `is-${resolvedAgentIndicatorState}`
                : 'is-empty'
            }`}
            aria-label={agentIndicatorLabel}
            title={agentIndicatorLabel}
          >
            {hasCurrentAgent ? (
              <span className="conversation-sidebar__status-dot" aria-hidden="true" />
            ) : null}
            <span className="conversation-sidebar__brand-name">
              {currentAgent ? agentDisplayName(currentAgent) : '未选择节点'}
            </span>
          </div>

          {!desktopPinned ? (
            <button type="button" className="conversation-sidebar__close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          ) : null}
        </div>

        <div className="conversation-sidebar__actions">
          <Link to="/nodes" className="sidebar-action" onClick={onClose}>
            <span className="sidebar-action__icon"><IconNodes /></span>
            <span>节点列表</span>
          </Link>
          <button
            type="button"
            className="sidebar-action sidebar-action--primary"
            onClick={() => {
              onClose()
              const fallbackProject = projects.find((project) => project.id === activeProjectId) ?? projects[0]
              if (fallbackProject) {
                onCreateSession(fallbackProject.id, fallbackProject.name)
              } else {
                void navigate({ to: '/nodes' })
              }
            }}
          >
            <span className="sidebar-action__icon"><IconChat /></span>
            <span>新会话</span>
          </button>
        </div>

        <div className="conversation-sidebar__threads">
            <div
              className="sidebar-pane-track"
              style={{ transform: sidebarPaneTranslate }}
            >
            <div
              ref={(node) => {
                paneRefs.current.threads = node
              }}
              className={`sidebar-pane ${sidebarView === 'threads' ? 'is-active' : 'is-inactive'}`}
            >
              {pinnedSessions.length > 0 ? (
                <div className="sidebar-pinned">
                  <div className="conversation-sidebar__node">置顶会话</div>
                  <div className="sidebar-pinned__list">
                    {pinnedSessions.map((session) => renderSessionItem(session))}
                  </div>
                </div>
              ) : null}
              <div className="conversation-sidebar__node-row">
                <div className="conversation-sidebar__node">线程</div>
                {onCreateDirectoryThread ? (
                  <button
                    type="button"
                    className="conversation-sidebar__node-action"
                    onClick={onCreateDirectoryThread}
                    aria-label="新增目录线程"
                    title="新增目录线程"
                  >
                    <IconDirectoryPlus />
                  </button>
                ) : null}
              </div>
              {primaryThreadGroups.map((group) => renderThreadGroup(group, 'threads'))}
              {renderThreadDragPreview('threads')}

              <button
                type="button"
                className="thread-archive__toggle"
                onClick={() => setSidebarView('archived')}
              >
                <span>已归档</span>
                <span className="thread-archive__icon"><IconArrowRight /></span>
              </button>
            </div>

            <div
              ref={(node) => {
                paneRefs.current.archived = node
              }}
              className={`sidebar-pane sidebar-pane--archived ${sidebarView === 'archived' ? 'is-active' : 'is-inactive'}`}
            >
              <div className="conversation-sidebar__node">已归档的线程</div>
              {archivedThreadGroups.length > 0 ? (
                <div className="thread-archive__list">
                  {archivedThreadGroups.map((group) => renderThreadGroup(group, 'archived'))}
                </div>
              ) : (
                <div className="thread-archive__empty">暂时没有已归档的线程</div>
              )}
              {renderThreadDragPreview('archived')}

              <button
                type="button"
                className="thread-archive__back"
                onClick={() => setSidebarView('threads')}
                aria-label="返回线程列表"
              >
                <span className="thread-archive__back-icon"><IconArrowLeft /></span>
                <span>返回</span>
              </button>
            </div>
          </div>
        </div>

        <div className="conversation-sidebar__footer">
          <button
            type="button"
            className="sidebar-settings"
            onClick={() => {
              onClose()
              onOpenSettings?.()
            }}
            aria-label="打开设置页"
          >
            <span className="sidebar-settings__icon"><IconSettings /></span>
            <span>设置</span>
          </button>
        </div>

      </aside>

      {renameProjectDialog}
    </>
  )
})
