import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { RotateCw, Undo2 } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import {
  type CodexCommandPanel,
  mergeTimelineAttachments,
  type ChangeSetSummary,
  type SessionInteractionRequest,
  type SessionBootstrapSnapshot,
  type SessionChangeSetFileDiff,
  type SessionInputAttachment,
  type SessionPlanSnapshot,
  type SessionRunCommandDraft,
  type SessionRunWebsiteDraft,
  type SessionRunWorkbench,
  type SessionTerminal,
  type SessionTerminalOutputChunk,
  type SessionTerminalSnapshot,
  type SessionTimelineSnapshot,
  type TimelinePatchSummary,
  type TimelineEntry,
  type WorkspaceDirectorySnapshot,
  type WorkspaceProjectDirectory,
  type WorkspaceSessionDetail,
  type WorkspaceSessionDetailResponse,
  type WorkspaceSessionListItem,
} from '@panda/protocol'
import type { AgentIndicatorState } from '../../lib/agent-presence'
import { WORKSPACE_DIRECTORY_QUERY_KEY } from '../../lib/bootstrap-query'
import { resolveConnectionTarget } from '../../lib/client'
import { syncWorkspaceDirectory } from '../../lib/directory-sync'
import {
  appendTimelineEntry,
  getTimelineOptimisticQueryKey,
  mergeDisplayedTimelineEntries,
  mergeSessionTimelineSnapshots,
  mergeTimelineEntries,
  OPTIMISTIC_USER_ENTRY_PREFIX,
  reconcileOptimisticTimelineEntries,
  removeOptimisticTimelineEntry,
} from '../../lib/timeline-cache'
import {
  readStoredSessionTimelineSnapshot,
  writeStoredSessionTimelineSnapshot,
} from '../../lib/session-timeline-storage'
import {
  getSessionModelLabelFromOptions,
  REASONING_OPTIONS,
  readStoredCommandExecutionModel,
  readStoredSessionFastMode,
  readStoredSessionModel,
  readStoredSessionPlanMode,
  readStoredSessionReasoning,
  readStoredSessionYoloMode,
  writeStoredSessionFastMode,
  writeStoredSessionModel,
  writeStoredSessionPlanMode,
  writeStoredSessionReasoning,
  writeStoredSessionYoloMode,
} from '../../lib/session-composer-preferences'
import {
  createSessionInputAttachment,
  formatAttachmentSize,
  isImageTimelineAttachment,
  toTimelineAttachments,
} from '../../lib/session-attachments'
import {
  isSlashCommandInput,
  tokenizeInlineRichContent,
  type InlineRichToken,
} from '../../lib/skill-mentions'
import {
  clearPendingSessionHandoff,
  queuePendingProjectId,
  queuePendingSessionId,
  readPendingSessionHandoff,
  readStoredAgentId,
  writeStoredAgentId,
  writeStoredSessionId,
} from '../../lib/session-selection'
import { useSessionModelOptions } from '../../lib/use-session-model-options'
import { useSessionToolCallDetail } from '../../lib/use-session-tool-call-detail'
import { useWorkspaceDirectory } from '../../lib/use-workspace-directory'
import {
  getWorkspaceSessionDetailQueryKey,
  useWorkspaceSessionDetail,
} from '../../lib/use-workspace-session-detail'
import { useWorkspaceSessionPaging } from '../../lib/use-workspace-session-paging'
import {
  hasWorkspaceSession,
  patchWorkspaceProjectIfMatched,
  patchWorkspaceSessionIfMatched,
  patchWorkspaceSessionLastEventAtIfNewer,
  toWorkspaceSessionDirectoryPatch,
  patchWorkspaceSessionWithSafeLastEventAt,
  patchWorkspaceSessions,
  removeWorkspaceProject,
  removeWorkspaceSessions,
  reorderWorkspaceProjects,
} from '../../lib/workspace-directory-cache'
import {
  mergeWorkspaceSessionSummaryIntoDetail,
  patchWorkspaceSessionDetailWithSafeLastEventAt,
  toWorkspaceSessionDetailPatch,
} from '../../lib/workspace-session-detail-cache'
import { ConversationSidebar } from './conversation-sidebar'
import { SessionComposer } from './session-composer'
import { SessionGitPanel } from './session-git-panel'
import {
  SessionRunCommandPanel,
} from './session-run-command-panel'
import { SessionRunWebsitePanel } from './session-run-website-panel'
import {
  SessionTerminalPanel,
  type SessionTerminalOutputState,
} from './session-terminal-panel'
import { SessionTimeline } from './session-timeline'

type WorkspaceProject = WorkspaceProjectDirectory
type WorkspaceSession = WorkspaceSessionListItem

const LAST_SESSION_STORAGE_KEY = 'panda:last-session-id'
const SIDEBAR_CLOSE_THRESHOLD = 0.4
const TOOL_SUMMARY_LIMIT = 104
const HISTORY_COMPACT_AFTER_MS = 30 * 60 * 1000
const LIVE_PLAN_GRACE_MS = 15_000
const SUBAGENT_RECENT_WINDOW_MS = 2 * 60 * 1000
const DESKTOP_SIDEBAR_BREAKPOINT = 1100
const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = 'panda:desktop-sidebar-width'
const DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION_KEY = 'panda:desktop-sidebar-width-version'
const DESKTOP_SIDEBAR_WIDTH_STORAGE_VERSION = '2026-03-24-narrow'
const LEGACY_DESKTOP_SIDEBAR_WIDTH_DEFAULT = 300
const DESKTOP_SIDEBAR_WIDTH_MIN = 232
const DESKTOP_SIDEBAR_WIDTH_DEFAULT = DESKTOP_SIDEBAR_WIDTH_MIN
const DESKTOP_SIDEBAR_WIDTH_MAX = 460
const SCROLL_BOTTOM_THRESHOLD = 72
const TIMELINE_PULL_LOAD_THRESHOLD = 72
const TIMELINE_PULL_MAX_DISTANCE = 120
const TIMELINE_HISTORY_INDICATOR_TARGET_OFFSET = 54
const TIMELINE_HISTORY_INDICATOR_ROTATION_MAX = 300
const TIMELINE_CLICK_LOADING_MIN_MS = 640
const COMPOSER_ALERT_DISMISS_MS = 4200
const LOCAL_MODEL_COMMAND_PANEL_PREFIX = 'local-model-panel:'
const DIRECTORY_SYNC_DEBOUNCE_MS = 160

const EMPTY_PROJECT_REF: WorkspaceProject = {
  id: '',
  agent_id: '',
  name: '',
  display_name: null,
  pinned: false,
  path: '',
}

const EMPTY_SESSION_REF: WorkspaceSession = {
  id: '',
  agent_id: '',
  project_id: '',
  archived: false,
  title: '',
  last_event_at: '',
  pinned: false,
  run_state: 'idle',
  run_state_changed_at: null,
  subagent: null,
}

const EMPTY_SESSION_DETAIL: WorkspaceSessionDetail = {
  ...EMPTY_SESSION_REF,
  provider: 'codex',
  mode: 'managed',
  health: 'active',
  branch: '',
  worktree: '',
  summary: '',
  latest_assistant_message: null,
  context_usage: null,
  capability: {
    can_stream_live: false,
    can_send_input: false,
    can_interrupt: false,
    can_approve: false,
    can_reject: false,
    can_show_git: false,
    can_show_terminal: false,
  },
}

const buildOptimisticWorkspaceDirectory = (
  snapshot: WorkspaceDirectorySnapshot | null | undefined,
  handoff: ReturnType<typeof readPendingSessionHandoff>,
) => {
  if (!handoff) {
    return snapshot ?? null
  }

  if (snapshot?.sessions.some((item) => item.id === handoff.sessionId)) {
    return snapshot
  }

  const nextProjects = handoff.project
    ? [
        handoff.project,
        ...(snapshot?.projects ?? []).filter((project) => project.id !== handoff.project?.id),
      ]
    : [...(snapshot?.projects ?? [])]
  const nextSessions = [
    handoff.session,
    ...(snapshot?.sessions ?? []).filter((item) => item.id !== handoff.sessionId),
  ]

  return {
    generated_at: snapshot?.generated_at ?? handoff.createdAt,
    agent: snapshot?.agent ?? null,
    projects: nextProjects,
    project_stats: nextProjects.map((project) => {
      const projectSessions = nextSessions.filter((session) => session.project_id === project.id)
      const previousStat = snapshot?.project_stats.find((stat) => stat.project_id === project.id)
      return {
        project_id: project.id,
        visible_session_count: projectSessions.filter((session) => !session.archived).length,
        archived_session_count: previousStat?.archived_session_count ?? 0,
        hidden_history_count: previousStat?.hidden_history_count ?? 0,
      }
    }),
    sessions: nextSessions,
    active_session_id: handoff.sessionId,
  } satisfies WorkspaceDirectorySnapshot
}

const EMPTY_TIMELINE_SNAPSHOT: SessionTimelineSnapshot = {
  session_id: '',
  generated_at: '',
  view: 'tail',
  anchor_entry_id: null,
  has_earlier_entries: false,
  entries: [],
}

const IconMore = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1" fill="currentColor" stroke="none" />
  </svg>
)

const IconCopy = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="10" height="10" rx="2" />
    <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" />
  </svg>
)

const IconCheck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m7.5 12.5 3 3 6-7" />
  </svg>
)

const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </svg>
)

const IconCode = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 18-6-6 6-6" />
    <path d="m15 6 6 6-6 6" />
  </svg>
)

const IconGit = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="18" cy="6" r="2.2" />
    <circle cx="12" cy="18" r="2.2" />
    <path d="M8 7.6 10.5 16" />
    <path d="M16 7.6 13.5 16" />
    <path d="M8.2 6h7.6" />
  </svg>
)

const IconTerminal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="m7.5 9 2.8 3-2.8 3" />
    <path d="M12.8 15H16.5" />
  </svg>
)

const IconRun = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 5.5 18 12 7 18.5Z" />
  </svg>
)

const IconWeb = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.4" />
    <path d="M3.8 12h16.4" />
    <path d="M12 3.7c2.3 2.3 3.6 5.2 3.6 8.3s-1.3 6-3.6 8.3c-2.3-2.3-3.6-5.2-3.6-8.3s1.3-6 3.6-8.3Z" />
  </svg>
)

const IconTimelineRefresh = () => <RotateCw aria-hidden="true" strokeWidth={1.9} />
const IconTurnRollback = () => <Undo2 aria-hidden="true" strokeWidth={1.9} />
const INLINE_PATH_TOOLTIP_VIEWPORT_GUTTER_PX = 12

type InlinePathLinkTokenProps = {
  isActive: boolean
  label: string
  path: string
  tokenKey: string
  onToggle: () => void
}

const InlinePathLinkToken = memo(function InlinePathLinkToken({
  isActive,
  label,
  path,
  tokenKey,
  onToggle,
}: InlinePathLinkTokenProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const tooltipRef = useRef<HTMLSpanElement | null>(null)
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties | undefined>(undefined)

  useEffect(() => {
    if (!isActive) {
      setTooltipStyle(undefined)
      return
    }

    const updateTooltipPosition = () => {
      const anchor = anchorRef.current
      const tooltip = tooltipRef.current
      if (!anchor || !tooltip) {
        return
      }

      const anchorRect = anchor.getBoundingClientRect()
      const viewportWidth =
        typeof window !== 'undefined'
          ? window.innerWidth
          : document.documentElement.clientWidth
      const viewportHeight =
        typeof window !== 'undefined'
          ? window.innerHeight
          : document.documentElement.clientHeight
      const preferredTooltipWidth = Math.max(
        220,
        Math.min(520, viewportWidth - INLINE_PATH_TOOLTIP_VIEWPORT_GUTTER_PX * 2),
      )
      tooltip.style.width = `${preferredTooltipWidth}px`
      tooltip.style.maxWidth = `${preferredTooltipWidth}px`

      const tooltipRect = tooltip.getBoundingClientRect()
      const clampedLeft = Math.min(
        Math.max(anchorRect.left, INLINE_PATH_TOOLTIP_VIEWPORT_GUTTER_PX),
        Math.max(
          INLINE_PATH_TOOLTIP_VIEWPORT_GUTTER_PX,
          viewportWidth - INLINE_PATH_TOOLTIP_VIEWPORT_GUTTER_PX - preferredTooltipWidth,
        ),
      )
      const preferredTop = anchorRect.top - tooltipRect.height - 8
      const nextTop =
        preferredTop >= INLINE_PATH_TOOLTIP_VIEWPORT_GUTTER_PX
          ? preferredTop
          : Math.min(
              anchorRect.bottom + 8,
              viewportHeight - INLINE_PATH_TOOLTIP_VIEWPORT_GUTTER_PX - tooltipRect.height,
            )

      setTooltipStyle({
        left: `${clampedLeft}px`,
        top: `${Math.max(INLINE_PATH_TOOLTIP_VIEWPORT_GUTTER_PX, nextTop)}px`,
        width: `${preferredTooltipWidth}px`,
        maxWidth: `${preferredTooltipWidth}px`,
      })
    }

    const frameId = window.requestAnimationFrame(updateTooltipPosition)
    window.addEventListener('resize', updateTooltipPosition)
    document.addEventListener('scroll', updateTooltipPosition, true)

    return () => {
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', updateTooltipPosition)
      document.removeEventListener('scroll', updateTooltipPosition, true)
    }
  }, [isActive, path])

  return (
    <span
      ref={anchorRef}
      key={tokenKey}
      className={`conversation-inline-link ${isActive ? 'is-active' : ''}`}
    >
      <span
        role="button"
        tabIndex={0}
        className="conversation-inline-link__button"
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return
          }

          event.preventDefault()
          event.stopPropagation()
          onToggle()
        }}
      >
        {label}
      </span>
      {isActive && typeof document !== 'undefined'
        ? createPortal(
            <span
              ref={tooltipRef}
              className="conversation-inline-link__tooltip"
              role="tooltip"
              style={tooltipStyle}
            >
              {path}
            </span>,
            document.body,
          )
        : null}
    </span>
  )
})

type PatchFileChange = {
  path: string
  displayPath: string
  operation: 'add' | 'update' | 'delete'
  additions: number
  deletions: number
  diffText: string
}

type PatchSummary = {
  files: PatchFileChange[]
  additions: number
  deletions: number
}

type ToolTimelineGroup = {
  id: string
  commandEntry: TimelineEntry
  outputEntries: TimelineEntry[]
  patchSummary: PatchSummary | null
}

type RenderedConversationItem =
  | { kind: 'entry'; entry: TimelineEntry }
  | { kind: 'tool-group'; group: ToolTimelineGroup }

type TurnStartMarker = {
  kind: 'turn-start'
  id: string
  startedAt: string
}

type TurnCompleteMarker = {
  kind: 'turn-complete'
  id: string
  durationLabel: string
  patchSummary: PatchSummary | null
  completedAt: string
}

type RenderedTimelineItem =
  | RenderedConversationItem
  | TurnStartMarker
  | TurnCompleteMarker

type RenderedConversationTurn = {
  id: string
  startedAt: string | null
  visibleStartItems: RenderedConversationItem[]
  hiddenItems: RenderedConversationItem[]
  visibleEndItems: RenderedConversationItem[]
  completion: TurnCompleteMarker | null
}

type RenderedConversationBlock =
  | {
      kind: 'item'
      id: string
      item: RenderedConversationItem
    }
  | {
      kind: 'turn'
      turn: RenderedConversationTurn
    }

type RenderedTurnBlock = {
  kind: 'turn'
  turn: RenderedConversationTurn
  changeSet: ChangeSetSummary | null
}

type AnnotatedConversationBlock =
  | Extract<RenderedConversationBlock, { kind: 'item' }>
  | RenderedTurnBlock

type ConnectionStatus = {
  state: 'connected' | 'reconnecting' | 'failed'
  attempt: number
  maxAttempts: number
  error?: string
}

type RollbackTurnError = {
  turnId: string
  message: string
}

type SessionRecoveryStatus = {
  state: 'idle' | 'recovering' | 'failed'
  error?: string
}

type TimelineLoadTrigger = 'pull' | 'click' | null

type WorkspaceSurface = 'code' | 'terminal' | 'git'

type MarkdownListItem = {
  text: string
  ordinal: number | null
}

type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { kind: 'code'; rawInfo: string; language: string | null; content: string }

type AssistantContentBlock =
  | { kind: 'markdown'; content: string }
  | { kind: 'proposed-plan'; content: string }

type SummaryChangeFile = {
  changeSetId?: string
  path: string
  pathLabel: string
  additions: number
  deletions: number
  itemId?: string | null
  diffAvailable?: boolean
  diffText?: string | null
  diffError?: string | null
  diffLoading?: boolean
  emptyMessage: string
}

const mergeTerminalOutputChunks = (
  currentChunks: SessionTerminalOutputChunk[],
  nextChunks: SessionTerminalOutputChunk[],
) => {
  const chunkByCursor = new Map<number, SessionTerminalOutputChunk>()
  for (const chunk of currentChunks) {
    chunkByCursor.set(chunk.cursor, chunk)
  }
  for (const chunk of nextChunks) {
    chunkByCursor.set(chunk.cursor, chunk)
  }
  return [...chunkByCursor.values()].sort((left, right) => left.cursor - right.cursor)
}

const RENDER_CACHE_LIMIT = 800

const getCachedComputation = <T,>(
  cache: Map<string, T>,
  key: string,
  compute: () => T,
) => {
  const cached = cache.get(key)
  if (cached !== undefined) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const value = compute()
  cache.set(key, value)
  if (cache.size > RENDER_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) {
      cache.delete(oldestKey)
    }
  }
  return value
}

const inlineTokenCache = new Map<string, InlineRichToken[]>()
const markdownBlockCache = new Map<string, MarkdownBlock[]>()
const assistantContentBlockCache = new Map<string, AssistantContentBlock[]>()
const loadSessionDiffPreview = () => import('./session-diff-preview')
const LazySessionDiffPreview = lazy(async () => {
  const module = await loadSessionDiffPreview()
  return {
    default: module.SessionDiffPreview,
  }
})

const renderSessionDiffPreview = (
  diffText: string,
  filePath: string,
  emptyMessage: string,
) => (
  <Suspense fallback={<div className="patch-file-card__empty">正在载入差异详情…</div>}>
    <LazySessionDiffPreview
      diffText={diffText}
      filePath={filePath}
      emptyMessage={emptyMessage}
    />
  </Suspense>
)

const renderStaticPathLinkLabel = (displayPath: string) => (
  <span className="conversation-inline-link">
    <span className="conversation-inline-link__button" title={displayPath}>
      {getPathBasename(displayPath)}
    </span>
  </span>
)

const PROPOSED_PLAN_PATTERN = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/g

const parseInlineTokens = (value: string): InlineRichToken[] =>
  getCachedComputation(inlineTokenCache, value, () => tokenizeInlineRichContent(value))

const normalizePath = (value: string) =>
  value.replace(/\\/g, '/')

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const matchMarkdownListItem = (line: string): MarkdownListItem & { ordered: boolean } | null => {
  const orderedMatch = /^\s*(\d+)\.\s+(.+)$/.exec(line)
  if (orderedMatch) {
    return {
      ordered: true,
      ordinal: Number.parseInt(orderedMatch[1] ?? '', 10),
      text: orderedMatch[2]?.trim() ?? '',
    }
  }

  const bulletMatch = /^\s*[-*]\s+(.+)$/.exec(line)
  if (bulletMatch) {
    return {
      ordered: false,
      ordinal: null,
      text: bulletMatch[1]?.trim() ?? '',
    }
  }

  return null
}

const parseSlashCommandName = (value: string) => {
  const match = /^\/([A-Za-z][A-Za-z0-9._-]*)/.exec(value.trim())
  return match?.[1]?.toLowerCase() ?? ''
}

const isContextCompactionEntry = (entry: TimelineEntry) =>
  entry.kind === 'system' && entry.title === 'context_compacted'

const formatTokenCountCompact = (value: number) => {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`
  }

  return String(Math.round(value))
}

const parseMarkdownBlocks = (value: string): MarkdownBlock[] =>
  getCachedComputation(markdownBlockCache, value, () => {
    const lines = value.replace(/\r\n/g, '\n').split('\n')
    const blocks: MarkdownBlock[] = []
    let paragraphLines: string[] = []
    let listState: { ordered: boolean; items: MarkdownListItem[] } | null = null

    const flushParagraph = () => {
      if (paragraphLines.length === 0) {
        return
      }
      blocks.push({
        kind: 'paragraph',
        lines: [...paragraphLines],
      })
      paragraphLines = []
    }

    const flushList = () => {
      if (!listState || listState.items.length === 0) {
        listState = null
        return
      }
      blocks.push({
        kind: 'list',
        ordered: listState.ordered,
        items: [...listState.items],
      })
      listState = null
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const fencedCodeMatch = /^\s{0,3}(```+|~~~+)[ \t]*([^`]*)$/.exec(line)

      if (fencedCodeMatch) {
        flushParagraph()
        flushList()

        const fence = fencedCodeMatch[1] ?? '```'
        const rawInfo = (fencedCodeMatch[2] ?? '').trim()
        const language = rawInfo ? rawInfo.split(/\s+/, 1)[0]?.toLowerCase() ?? null : null
        const closingFencePattern = new RegExp(`^\\s{0,3}${escapeRegExp(fence)}\\s*$`)
        const contentLines: string[] = []

        index += 1
        while (index < lines.length && !closingFencePattern.test(lines[index] ?? '')) {
          contentLines.push(lines[index] ?? '')
          index += 1
        }

        blocks.push({
          kind: 'code',
          rawInfo,
          language,
          content: contentLines.join('\n'),
        })
        continue
      }

      const headingMatch = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line)
      const listItemMatch = matchMarkdownListItem(line)

      if (headingMatch) {
        flushParagraph()
        flushList()
        blocks.push({
          kind: 'heading',
          level: headingMatch[1].length,
          text: headingMatch[2].replace(/\s+#+\s*$/, '').trim(),
        })
        continue
      }

      if (listItemMatch) {
        flushParagraph()
        if (!listState || listState.ordered !== listItemMatch.ordered) {
          flushList()
          listState = {
            ordered: listItemMatch.ordered,
            items: [],
          }
        }
        listState.items.push({
          text: listItemMatch.text,
          ordinal: listItemMatch.ordinal,
        })
        continue
      }

      if (!line.trim()) {
        flushParagraph()
        continue
      }

      flushList()
      paragraphLines.push(line)
    }

    flushParagraph()
    flushList()
    return blocks
  })

const parseAssistantContentBlocks = (value: string): AssistantContentBlock[] =>
  getCachedComputation(assistantContentBlockCache, value, () => {
    const blocks: AssistantContentBlock[] = []
    let lastIndex = 0

    value.replace(PROPOSED_PLAN_PATTERN, (match, content, offset: number) => {
      const precedingContent = value.slice(lastIndex, offset)
      if (precedingContent.trim()) {
        blocks.push({
          kind: 'markdown',
          content: precedingContent.trim(),
        })
      }

      if (typeof content === 'string' && content.trim()) {
        blocks.push({
          kind: 'proposed-plan',
          content: content.trim(),
        })
      } else if (match.trim()) {
        blocks.push({
          kind: 'markdown',
          content: match.trim(),
        })
      }

      lastIndex = offset + match.length
      return match
    })

    const trailingContent = value.slice(lastIndex)
    if (trailingContent.trim()) {
      blocks.push({
        kind: 'markdown',
        content: trailingContent.trim(),
      })
    }

    if (blocks.length === 0 && value.trim()) {
      blocks.push({
        kind: 'markdown',
        content: value.trim(),
      })
    }

    return blocks
  })


const getLiveChangeFiles = (changeSet: ChangeSetSummary) => {
  const itemFiles = changeSet.files.filter((file) => Boolean(file.item_id))
  return itemFiles.length > 0 ? itemFiles : changeSet.files.filter((file) => !file.item_id)
}

const getSummaryChangeFiles = (
  changeSet: ChangeSetSummary,
  projectPath: string,
  fallbackSummary?: PatchSummary | null,
): SummaryChangeFile[] => {
  const fallbackFilesByPath = new Map(
    (fallbackSummary?.files ?? []).map((file) => [file.path, file]),
  )
  const summaryFiles = changeSet.files.filter((file) => !file.item_id)
  if (summaryFiles.length > 0) {
    return summaryFiles.map((file) => ({
      changeSetId: changeSet.id,
      path: file.path,
      pathLabel: toDisplayPath(file.path, projectPath),
      additions: file.additions,
      deletions: file.deletions,
      itemId: file.item_id,
      diffAvailable: file.diff_available,
      diffText: fallbackFilesByPath.get(file.path)?.diffText,
      emptyMessage: '此变更没有可展示的补丁内容',
    }))
  }

  const latestByPath = new Map<string, ChangeSetSummary['files'][number]>()
  for (const file of changeSet.files) {
    latestByPath.set(file.path, file)
  }

  return [...latestByPath.values()].map((file) => ({
    changeSetId: changeSet.id,
    path: file.path,
    pathLabel: toDisplayPath(file.path, projectPath),
    additions: file.additions,
    deletions: file.deletions,
    itemId: file.item_id,
    diffAvailable: file.diff_available,
    diffText: fallbackFilesByPath.get(file.path)?.diffText,
    emptyMessage: '此变更没有可展示的补丁内容',
  }))
}

const getChangeSetFileDiffKey = (
  changeSetId: string,
  path: string,
  itemId?: string | null,
) => `${changeSetId}:${itemId ?? 'summary'}:${path}`

const getTurnSummaryScope = (turnId: string) => `turn-summary:${turnId}`

const getSummaryChangeFileId = (scope: string, path: string) => `${scope}:${path}`

const getTailTimelineAnchorEntryId = (entries: TimelineEntry[]) => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === 'user') {
      return entries[index]?.id ?? null
    }
  }

  return null
}

const buildTailTimelineSnapshot = (
  sessionId: string,
  entries: TimelineEntry[],
  hasEarlierEntries: boolean,
): SessionTimelineSnapshot => ({
  session_id: sessionId,
  generated_at: new Date().toISOString(),
  view: 'tail',
  anchor_entry_id: getTailTimelineAnchorEntryId(entries),
  has_earlier_entries: hasEarlierEntries,
  entries,
})

const isTimelineEntryArray = (value: unknown): value is TimelineEntry[] =>
  Array.isArray(value)

const getTimelineSnapshotEntries = (
  value: SessionTimelineSnapshot | TimelineEntry[] | undefined,
) => {
  if (isTimelineEntryArray(value)) {
    return value
  }

  return Array.isArray(value?.entries) ? value.entries : []
}

const getTimelineSnapshotHasEarlierEntries = (
  value: SessionTimelineSnapshot | TimelineEntry[] | undefined,
) => {
  if (isTimelineEntryArray(value)) {
    return false
  }

  return value?.has_earlier_entries ?? false
}

const getTimelineSnapshotView = (
  value: SessionTimelineSnapshot | TimelineEntry[] | undefined,
): SessionTimelineSnapshot['view'] => {
  if (isTimelineEntryArray(value)) {
    return 'tail'
  }

  return value?.view ?? 'tail'
}

const mergeChangeSetSummaries = (
  currentChangeSets: ChangeSetSummary[] | undefined,
  incomingChangeSets: ChangeSetSummary[],
) => {
  const byId = new Map((currentChangeSets ?? []).map((changeSet) => [changeSet.id, changeSet]))
  for (const changeSet of incomingChangeSets) {
    byId.set(changeSet.id, changeSet)
  }

  return [...byId.values()].sort(
    (left, right) => +new Date(left.started_at) - +new Date(right.started_at),
  )
}

const formatBackgroundAgentsLabel = (count: number) =>
  `${count} background agent${count === 1 ? '' : 's'}`

const getRuntimeStatusTone = (value: string) =>
  value.startsWith('Reconnecting...') ? 'retrying' : 'error'

const getRuntimeStatusLabel = (value: string) =>
  value.startsWith('Reconnecting...') ? 'Codex 重连中' : 'Codex 运行异常'

const getPathBasename = (value: string) => {
  const normalized = normalizePath(value).replace(/\/+$/, '')
  const segments = normalized.split('/')
  return segments[segments.length - 1] || normalized
}

const getTimelineEntryComparableKey = (entry: TimelineEntry) =>
  `${entry.kind}\u0000${entry.title}\u0000${entry.body}\u0000${entry.accent}`

const trimSubagentTimelinePrefix = (
  timeline: TimelineEntry[],
  parentTimeline: TimelineEntry[] | undefined,
) => {
  if (!parentTimeline || parentTimeline.length === 0 || timeline.length === 0) {
    return timeline
  }

  let sharedPrefixLength = 0
  while (
    sharedPrefixLength < timeline.length &&
    sharedPrefixLength < parentTimeline.length &&
    getTimelineEntryComparableKey(timeline[sharedPrefixLength]!) ===
      getTimelineEntryComparableKey(parentTimeline[sharedPrefixLength]!)
  ) {
    sharedPrefixLength += 1
  }

  if (sharedPrefixLength <= 0 || sharedPrefixLength >= timeline.length) {
    return timeline
  }

  return timeline.slice(sharedPrefixLength)
}

type ParsedSubagentNotification = {
  agentId: string | null
  body: string
  state: 'completed' | 'errored' | 'working' | 'shutdown'
}

const parseSubagentNotification = (value: string): ParsedSubagentNotification | null => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('<subagent_notification>')) {
    return null
  }

  const jsonStart = trimmed.indexOf('{')
  if (jsonStart < 0) {
    return null
  }

  const jsonEnd = trimmed.lastIndexOf('}')
  if (jsonEnd <= jsonStart) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as {
      agent_id?: unknown
      status?:
        | string
        | {
            completed?: unknown
            errored?: unknown
            working?: unknown
            shutdown?: unknown
          }
    }

    const normalizeStatusText = (value: unknown) =>
      typeof value === 'string' ? value.trim() : ''

    if (typeof parsed.status === 'string') {
      const statusValue = parsed.status.trim()
      if (statusValue === 'shutdown') {
        return {
          agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
          body: '子代理已关闭',
          state: 'shutdown',
        }
      }

      if (statusValue === 'completed') {
        return {
          agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
          body: '子代理已完成',
          state: 'completed',
        }
      }

      if (statusValue === 'errored') {
        return {
          agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
          body: '子代理异常结束',
          state: 'errored',
        }
      }

      if (statusValue === 'working') {
        return {
          agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
          body: '子代理处理中',
          state: 'working',
        }
      }
    }

    const structuredStatus =
      parsed.status && typeof parsed.status === 'object' ? parsed.status : null
    const completed =
      normalizeStatusText(structuredStatus?.completed)
    const errored =
      normalizeStatusText(structuredStatus?.errored)
    const working =
      normalizeStatusText(structuredStatus?.working)
    const shutdown =
      normalizeStatusText(structuredStatus?.shutdown)

    if (completed) {
      return {
        agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
        body: completed,
        state: 'completed',
      }
    }

    if (errored) {
      return {
        agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
        body: errored,
        state: 'errored',
      }
    }

    if (working) {
      return {
        agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
        body: working,
        state: 'working',
      }
    }

    if (shutdown) {
      return {
        agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
        body: shutdown || '子代理已关闭',
        state: 'shutdown',
      }
    }
  } catch {
    return null
  }

  return null
}

const SUBAGENT_ACCENT_PALETTE = [
  '#2f72d8',
  '#d06a3b',
  '#2d9b7f',
  '#8c62d9',
  '#bf5b7f',
  '#b78b2d',
]

const getSubagentAccent = (seed: string | null | undefined) => {
  const source = (seed ?? '').trim()
  if (!source) {
    return SUBAGENT_ACCENT_PALETTE[0]
  }

  let hash = 0
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0
  }

  return SUBAGENT_ACCENT_PALETTE[hash % SUBAGENT_ACCENT_PALETTE.length]!
}

const getBackgroundAgentAccent = (session: WorkspaceSession) =>
  getSubagentAccent(session.subagent?.nickname ?? session.title ?? session.id)

const findActiveTurnStartIndex = (timeline: TimelineEntry[]) => {
  let lastStartedAt = -1
  let lastCompletedAt = -1

  timeline.forEach((entry, index) => {
    if (entry.kind !== 'system' || entry.title !== 'status') {
      return
    }

    if (entry.body === '开始处理请求') {
      lastStartedAt = index
      return
    }

    if (entry.body === '处理完成') {
      lastCompletedAt = index
    }
  })

  return lastStartedAt > lastCompletedAt ? lastStartedAt : -1
}

const getActiveTurnStartedAt = (timeline: TimelineEntry[]) => {
  const activeTurnStartIndex = findActiveTurnStartIndex(timeline)
  if (activeTurnStartIndex < 0) {
    return null
  }

  return timeline[activeTurnStartIndex]?.timestamp ?? null
}

const deriveOpenBackgroundAgentIds = (timeline: TimelineEntry[]) => {
  const activeTurnStartIndex = findActiveTurnStartIndex(timeline)
  if (activeTurnStartIndex < 0) {
    return new Set<string>()
  }

  const pendingToolCalls: Array<{ name: string }> = []
  const openAgents = new Set<string>()

  for (const entry of timeline.slice(activeTurnStartIndex)) {
    if (entry.kind !== 'tool') {
      continue
    }

    if (entry.title !== 'tool-output') {
      pendingToolCalls.push({
        name: entry.title,
      })

      if (entry.title === 'close_agent') {
        const closedAgentId = entry.session_ids[0] ?? null
        if (closedAgentId) {
          openAgents.delete(closedAgentId)
        }
      }

      continue
    }

    const pendingToolCall = pendingToolCalls.shift() ?? null
    if (pendingToolCall?.name === 'spawn_agent') {
      const spawnedAgentId = entry.session_ids[0] ?? null
      if (spawnedAgentId) {
        openAgents.add(spawnedAgentId)
      }
    }
  }

  return openAgents
}

const getBackgroundAgentStatusLabel = (session: WorkspaceSession) => {
  if (session.run_state === 'running') {
    return 'is working'
  }

  if (session.run_state === 'completed') {
    return 'completed'
  }

  return 'is awaiting instruction'
}

const CHANGE_SET_NEARBY_WINDOW_MS = 10_000
const CHANGE_SET_MATCH_SKEW_MS = 1_200

const getPatchSummaryPathSet = (summary: PatchSummary | null | undefined) =>
  new Set((summary?.files ?? []).map((file) => normalizePath(file.path)))

const getChangeSetPathOverlapCount = (
  changeSet: ChangeSetSummary,
  summaryPaths: Set<string>,
) => {
  if (summaryPaths.size === 0) {
    return 0
  }

  let overlapCount = 0
  for (const file of changeSet.files) {
    if (summaryPaths.has(normalizePath(file.path))) {
      overlapCount += 1
    }
  }

  return overlapCount
}

const hasNearbyAppServerChangeSet = (
  changeSets: ChangeSetSummary[],
  timestamp: string,
  summary?: PatchSummary | null,
) => {
  const targetMs = +new Date(timestamp)
  if (!Number.isFinite(targetMs)) {
    return false
  }

  const summaryPaths = getPatchSummaryPathSet(summary)

  return changeSets.some((changeSet) => {
    if (changeSet.source !== 'app-server') {
      return false
    }

    const updatedAtMs = +new Date(changeSet.updated_at)
    if (
      !Number.isFinite(updatedAtMs) ||
      Math.abs(updatedAtMs - targetMs) > CHANGE_SET_NEARBY_WINDOW_MS
    ) {
      return false
    }

    if (summaryPaths.size === 0) {
      return true
    }

    return getChangeSetPathOverlapCount(changeSet, summaryPaths) > 0
  })
}

const formatDuration = (startedAt: string | null, completedAt: string) => {
  if (!startedAt) {
    return '已处理'
  }

  const diffMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
  const totalSeconds = Math.max(0, Math.round(diffMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes <= 0) {
    return `已处理 ${seconds}s`
  }

  return `已处理 ${minutes}m ${seconds}s`
}

const toDisplayPath = (filePath: string, projectPath?: string) => {
  const normalizedFilePath = normalizePath(filePath)
  const normalizedProjectPath = projectPath ? normalizePath(projectPath).replace(/\/+$/, '') : ''

  if (
    normalizedProjectPath &&
    normalizedFilePath.toLowerCase().startsWith(`${normalizedProjectPath.toLowerCase()}/`)
  ) {
    return normalizedFilePath.slice(normalizedProjectPath.length + 1)
  }

  return normalizedFilePath
}

const toPatchSummaryFromTransport = (
  summary: TimelinePatchSummary | null | undefined,
  projectPath?: string,
): PatchSummary | null => {
  if (!summary || summary.files.length === 0) {
    return null
  }

  return {
    files: summary.files.map((file) => ({
      path: file.path,
      displayPath: toDisplayPath(file.path, projectPath),
      operation: 'update',
      additions: file.additions,
      deletions: file.deletions,
      diffText: '',
    })),
    additions: summary.additions,
    deletions: summary.deletions,
  }
}

const parseApplyPatchSummary = (input: string, projectPath?: string): PatchSummary | null => {
  const lines = input.split(/\r?\n/)
  const files: PatchFileChange[] = []
  let currentFile: PatchFileChange | null = null
  let diffLines: string[] = []

  const flushCurrent = () => {
    if (!currentFile) {
      return
    }

    files.push({
      ...currentFile,
      diffText: diffLines.join('\n').trim(),
    })
    currentFile = null
    diffLines = []
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    const normalizedLine = line.trimStart()

    if (line.startsWith('*** Add File: ')) {
      flushCurrent()
      const filePath = line.slice('*** Add File: '.length).trim()
      currentFile = {
        path: filePath,
        displayPath: toDisplayPath(filePath, projectPath),
        operation: 'add',
        additions: 0,
        deletions: 0,
        diffText: '',
      }
      continue
    }

    if (line.startsWith('*** Update File: ')) {
      flushCurrent()
      const filePath = line.slice('*** Update File: '.length).trim()
      currentFile = {
        path: filePath,
        displayPath: toDisplayPath(filePath, projectPath),
        operation: 'update',
        additions: 0,
        deletions: 0,
        diffText: '',
      }
      continue
    }

    if (line.startsWith('*** Delete File: ')) {
      flushCurrent()
      const filePath = line.slice('*** Delete File: '.length).trim()
      currentFile = {
        path: filePath,
        displayPath: toDisplayPath(filePath, projectPath),
        operation: 'delete',
        additions: 0,
        deletions: 0,
        diffText: '',
      }
      continue
    }

    if (!currentFile) {
      continue
    }

    if (line.startsWith('*** End Patch')) {
      flushCurrent()
      continue
    }

    if (line.startsWith('*** ')) {
      flushCurrent()
      continue
    }

    if (line.startsWith('+')) {
      currentFile.additions += 1
    } else if (line.startsWith('-')) {
      currentFile.deletions += 1
    }

    if (
      normalizedLine.startsWith('@@') ||
      line.startsWith('+') ||
      line.startsWith('-') ||
      line.startsWith(' ')
    ) {
      diffLines.push(normalizedLine.startsWith('@@') ? normalizedLine : line)
    }
  }

  flushCurrent()

  if (files.length === 0) {
    return null
  }

  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

const mergePatchSummaries = (summaries: PatchSummary[]): PatchSummary | null => {
  if (summaries.length === 0) {
    return null
  }

  const fileMap = new Map<string, PatchFileChange>()
  for (const summary of summaries) {
    for (const file of summary.files) {
      const existing = fileMap.get(file.path)
      if (!existing) {
        fileMap.set(file.path, { ...file })
        continue
      }

      existing.additions += file.additions
      existing.deletions += file.deletions
      existing.diffText = [existing.diffText, file.diffText].filter(Boolean).join('\n')
      existing.operation = file.operation
    }
  }

  const files = [...fileMap.values()]
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

const truncateSingleLine = (value: string, limit = TOOL_SUMMARY_LIMIT) => {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) {
    return normalized
  }

  return `${normalized.slice(0, limit - 1).trimEnd()}…`
}

const tryParseToolBody = (body: string) => {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
}

const getToolSummaryText = (entry: TimelineEntry) => {
  const parsedBody = tryParseToolBody(entry.body)

  if (parsedBody) {
    const commandFields = ['command', 'cmd', 'path', 'pattern', 'q', 'input']
    for (const field of commandFields) {
      const value = parsedBody[field]
      if (typeof value === 'string' && value.trim()) {
        return truncateSingleLine(value)
      }
    }
  }

  if (entry.title && entry.title !== 'tool-output') {
    if (entry.body.trim().startsWith('{') || entry.body.trim().startsWith('[')) {
      return truncateSingleLine(entry.title.replace(/-/g, ' '))
    }

    return truncateSingleLine(entry.body || entry.title)
  }

  return truncateSingleLine(entry.body || '工具执行')
}

const getToolCommandDetail = (entry: TimelineEntry) => {
  if (entry.title === 'apply_patch') {
    return entry.body.trim()
  }

  const parsedBody = tryParseToolBody(entry.body)
  if (parsedBody && typeof parsedBody.command === 'string' && parsedBody.command.trim()) {
    return parsedBody.command.trim()
  }

  return entry.body.trim() || entry.title
}

const getToolOutputDetail = (outputEntries: TimelineEntry[]) =>
  outputEntries
    .map((entry) => {
      const parsedBody = tryParseToolBody(entry.body)
      if (parsedBody && typeof parsedBody.output === 'string') {
        return parsedBody.output.trim()
      }

      return entry.body.trim()
    })
    .filter(Boolean)
    .join('\n\n')

const isUserConversationItem = (item: RenderedConversationItem) =>
  item.kind === 'entry' && item.entry.kind === 'user'

const isAssistantConversationItem = (item: RenderedConversationItem) =>
  item.kind === 'entry' && item.entry.kind === 'assistant'

const isNarrativeConversationItem = (item: RenderedConversationItem) =>
  isUserConversationItem(item) || isAssistantConversationItem(item)

const isLateTurnTailItem = (item: RenderedConversationItem) => {
  if (item.kind === 'tool-group') {
    return true
  }

  return item.entry.kind === 'assistant' || item.entry.kind === 'thinking' || item.entry.kind === 'tool'
}

const dedupeAdjacentAssistantMessages = (items: RenderedConversationItem[]) => {
  if (items.length <= 1) {
    return items
  }

  const deduped: RenderedConversationItem[] = []
  for (const item of items) {
    const previous = deduped[deduped.length - 1]
    if (
      previous &&
      previous.kind === 'entry' &&
      item.kind === 'entry' &&
      previous.entry.kind === 'assistant' &&
      item.entry.kind === 'assistant' &&
      previous.entry.body.trim() === item.entry.body.trim()
    ) {
      deduped[deduped.length - 1] = item
      continue
    }

    deduped.push(item)
  }

  return deduped
}

const formatCollapsedTurnHistoryLabel = (items: RenderedConversationItem[]) =>
  `展开 ${items.length} 条过程消息`

const formatExpandedTurnHistoryLabel = (items: RenderedConversationItem[]) =>
  `收起 ${items.length} 条过程消息`

const normalizeTurn = (
  turn: {
    id: string
    startedAt: string | null
    items: RenderedConversationItem[]
    completion: TurnCompleteMarker | null
  },
  compactCompletedTurns: boolean,
): RenderedConversationTurn => {
  const items = dedupeAdjacentAssistantMessages(turn.items)
  const { completion } = turn
  const finalAssistantIndex = items.findLastIndex((item) => isAssistantConversationItem(item))

  if (finalAssistantIndex === -1 || !completion || !compactCompletedTurns) {
    return {
      id: turn.id,
      startedAt: turn.startedAt,
      visibleStartItems:
        finalAssistantIndex === -1 ? items : items.slice(0, finalAssistantIndex),
      hiddenItems: [],
      visibleEndItems:
        finalAssistantIndex === -1 ? [] : items.slice(finalAssistantIndex),
      completion,
    }
  }

  const visibleStartItems: RenderedConversationItem[] = []
  const hiddenItems: RenderedConversationItem[] = []

  items.forEach((item, index) => {
    if (index === finalAssistantIndex) {
      return
    }

    if (isNarrativeConversationItem(item)) {
      visibleStartItems.push(item)
      return
    }

    hiddenItems.push(item)
  })

  return {
    id: turn.id,
    startedAt: turn.startedAt,
    visibleStartItems,
    hiddenItems,
    visibleEndItems: [items[finalAssistantIndex]!],
    completion,
  }
}

const buildConversationBlocks = (
  items: RenderedTimelineItem[],
  compactCompletedTurns: boolean,
): RenderedConversationBlock[] => {
  const blocks: RenderedConversationBlock[] = []
  let pendingItems: RenderedConversationItem[] = []
  let currentTurn: {
    id: string
    startedAt: string | null
    items: RenderedConversationItem[]
    completion: TurnCompleteMarker | null
  } | null = null

  const flushPendingItems = () => {
    for (const item of pendingItems) {
      blocks.push({
        kind: 'item',
        id: item.kind === 'entry' ? item.entry.id : item.group.id,
        item,
      })
    }
    pendingItems = []
  }

  const flushCurrentTurn = () => {
    if (!currentTurn) {
      return
    }

    if (currentTurn.items.length > 0 || currentTurn.completion) {
      blocks.push({
        kind: 'turn',
        turn: normalizeTurn(currentTurn, compactCompletedTurns),
      })
    }

    currentTurn = null
  }

  for (const item of items) {
    if (item.kind === 'turn-start') {
      flushCurrentTurn()
      currentTurn = {
        id: item.id,
        startedAt: item.startedAt,
        items: pendingItems,
        completion: null,
      }
      pendingItems = []
      continue
    }

    if (item.kind === 'turn-complete') {
      if (currentTurn) {
        currentTurn.completion = item
        continue
      }

      currentTurn = {
        id: item.id,
        startedAt: null,
        items: pendingItems,
        completion: item,
      }
      pendingItems = []
      continue
    }

    if (currentTurn) {
      if (currentTurn.completion && !isLateTurnTailItem(item)) {
        flushCurrentTurn()
        pendingItems.push(item)
        continue
      }

      currentTurn.items.push(item)
      continue
    }

    pendingItems.push(item)
  }

  flushCurrentTurn()

  flushPendingItems()
  return blocks
}

const shouldCompactCompletedTurns = (session: WorkspaceSession) =>
  session.run_state !== 'running' &&
  Date.now() - new Date(session.last_event_at).getTime() >= HISTORY_COMPACT_AFTER_MS

const buildRenderedTimeline = (
  timeline: TimelineEntry[],
  options?: {
    projectPath?: string
    compactCompletedTurns?: boolean
  },
) => {
  const projectPath = options?.projectPath
  const compactCompletedTurns = options?.compactCompletedTurns ?? false
  const items: RenderedTimelineItem[] = []
  let lastToolGroupId: string | null = null
  let hasRunningToolGroup = false
  let currentTurnStartedAt: string | null = null
  let currentTurnPatchSummaries: PatchSummary[] = []

  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index]

    if (entry.kind === 'system' && entry.body === '开始处理请求') {
      items.push({
        kind: 'turn-start',
        id: entry.id,
        startedAt: entry.timestamp,
      })
      currentTurnStartedAt = entry.timestamp
      currentTurnPatchSummaries = []
      continue
    }

    if (entry.kind === 'system' && entry.body === '处理完成') {
      items.push({
        kind: 'turn-complete',
        id: entry.id,
        durationLabel: formatDuration(currentTurnStartedAt, entry.timestamp),
        patchSummary: mergePatchSummaries(currentTurnPatchSummaries),
        completedAt: entry.timestamp,
      })
      currentTurnStartedAt = null
      currentTurnPatchSummaries = []
      continue
    }

    if (entry.kind === 'tool' && entry.title !== 'tool-output') {
      const outputEntries: TimelineEntry[] = []
      let cursor = index + 1

      while (
        cursor < timeline.length &&
        timeline[cursor]?.kind === 'tool' &&
        timeline[cursor]?.title === 'tool-output'
      ) {
        outputEntries.push(timeline[cursor]!)
        cursor += 1
      }

      lastToolGroupId = entry.id
      const patchSummary =
        entry.title === 'apply_patch'
          ? (
              toPatchSummaryFromTransport(entry.patch_summary, projectPath) ??
              parseApplyPatchSummary(entry.body, projectPath)
            )
          : null
      if (patchSummary) {
        currentTurnPatchSummaries.push(patchSummary)
      }

      if (outputEntries.length === 0) {
        hasRunningToolGroup = true
      }

      items.push({
        kind: 'tool-group',
        group: {
          id: entry.id,
          commandEntry: entry,
          outputEntries,
          patchSummary,
        },
      })
      index = cursor - 1
      continue
    }

    if (entry.kind === 'tool' && entry.title === 'tool-output') {
      items.push({
        kind: 'tool-group',
        group: {
          id: entry.id,
          commandEntry: entry,
          outputEntries: [],
          patchSummary: null,
        },
      })
      lastToolGroupId = entry.id
      continue
    }

    items.push({ kind: 'entry', entry })
  }

  return {
    blocks: buildConversationBlocks(items, compactCompletedTurns),
    lastToolGroupId,
    hasRunningToolGroup,
  }
}

const getConversationItemTimestamp = (item: RenderedConversationItem) =>
  item.kind === 'entry' ? item.entry.timestamp : item.group.commandEntry.timestamp

const getTurnTimeRange = (
  turn: RenderedConversationTurn,
  nextTurn: RenderedConversationTurn | null,
) => {
  const itemTimes = [...turn.visibleStartItems, ...turn.hiddenItems, ...turn.visibleEndItems]
    .map(getConversationItemTimestamp)
    .filter((value): value is string => Boolean(value))
  const lastItemTime = itemTimes.length > 0 ? itemTimes[itemTimes.length - 1] : null
  const startedAt = turn.startedAt ?? itemTimes[0] ?? turn.completion?.completedAt ?? null
  const completedAt = turn.completion?.completedAt ?? lastItemTime ?? startedAt

  return {
    startMs: startedAt ? +new Date(startedAt) : null,
    endMs: completedAt ? +new Date(completedAt) : null,
    nextStartMs: nextTurn?.startedAt ? +new Date(nextTurn.startedAt) : null,
  }
}

const isChangeSetWithinTurnTimeRange = (
  changeSet: ChangeSetSummary,
  timeRange: ReturnType<typeof getTurnTimeRange>,
) => {
  const startedAtMs = +new Date(changeSet.started_at)
  const completedAtMs = changeSet.completed_at ? +new Date(changeSet.completed_at) : null
  const lowerBound =
    timeRange.startMs ?? (timeRange.endMs !== null ? timeRange.endMs - CHANGE_SET_MATCH_SKEW_MS : null)
  const upperBound =
    timeRange.nextStartMs ??
    (timeRange.endMs !== null
      ? timeRange.endMs + CHANGE_SET_MATCH_SKEW_MS
      : Number.POSITIVE_INFINITY)

  if (lowerBound !== null && startedAtMs < lowerBound - CHANGE_SET_MATCH_SKEW_MS) {
    return false
  }

  if (startedAtMs <= upperBound + CHANGE_SET_MATCH_SKEW_MS) {
    return true
  }

  return completedAtMs !== null && completedAtMs <= upperBound + CHANGE_SET_MATCH_SKEW_MS
}

const getChangeSetUpdatedAtDistance = (
  changeSet: ChangeSetSummary,
  targetMs: number | null,
) => {
  if (targetMs === null) {
    return Number.POSITIVE_INFINITY
  }

  const updatedAtMs = +new Date(changeSet.updated_at)
  if (!Number.isFinite(updatedAtMs)) {
    return Number.POSITIVE_INFINITY
  }

  return Math.abs(updatedAtMs - targetMs)
}

const attachChangeSetsToBlocks = (
  blocks: RenderedConversationBlock[],
  changeSets: ChangeSetSummary[],
): AnnotatedConversationBlock[] => {
  const sortedChangeSets = [...changeSets].sort(
    (a, b) => +new Date(a.started_at) - +new Date(b.started_at),
  )
  const usedChangeSetIds = new Set<string>()
  const turnBlocks = blocks.filter(
    (block): block is Extract<RenderedConversationBlock, { kind: 'turn' }> => block.kind === 'turn',
  )
  const turnOrderById = new Map(turnBlocks.map((turnBlock, index) => [turnBlock.turn.id, index]))

  return blocks.map((block) => {
    if (block.kind !== 'turn') {
      return block
    }

    const turnIndex = turnOrderById.get(block.turn.id) ?? -1
    const nextTurn = turnIndex >= 0 ? turnBlocks[turnIndex + 1]?.turn ?? null : null
    const timeRange = getTurnTimeRange(block.turn, nextTurn)
    const turnPatchSummary = block.turn.completion?.patchSummary ?? null
    const summaryPaths = getPatchSummaryPathSet(turnPatchSummary)
    const preferredChangeSetCandidates = sortedChangeSets
      .filter((changeSet) => !usedChangeSetIds.has(changeSet.id))
      .map((changeSet) => ({
        changeSet,
        overlapCount: getChangeSetPathOverlapCount(changeSet, summaryPaths),
        updatedAtDistance: getChangeSetUpdatedAtDistance(changeSet, timeRange.endMs),
      }))
      .filter(
        (candidate) =>
          candidate.overlapCount > 0 &&
          candidate.updatedAtDistance <= CHANGE_SET_NEARBY_WINDOW_MS,
      )
      .sort((left, right) => {
        if (right.overlapCount !== left.overlapCount) {
          return right.overlapCount - left.overlapCount
        }
        if (left.changeSet.source !== right.changeSet.source) {
          return left.changeSet.source === 'app-server' ? -1 : 1
        }
        if (left.updatedAtDistance !== right.updatedAtDistance) {
          return left.updatedAtDistance - right.updatedAtDistance
        }
        return +new Date(left.changeSet.started_at) - +new Date(right.changeSet.started_at)
      })
    const matchedChangeSet =
      preferredChangeSetCandidates[0]?.changeSet ??
      sortedChangeSets.find((changeSet) => {
        if (usedChangeSetIds.has(changeSet.id)) {
          return false
        }

        return isChangeSetWithinTurnTimeRange(changeSet, timeRange)
      }) ??
      null

    if (matchedChangeSet) {
      usedChangeSetIds.add(matchedChangeSet.id)
    }

    const nextBlock: RenderedTurnBlock = {
      kind: 'turn',
      turn: block.turn,
      changeSet: matchedChangeSet,
    }
    return nextBlock
  })
}

const getSidebarShiftMax = () => {
  if (typeof window === 'undefined') {
    return 248
  }

  return Math.max(0, Math.min(248, window.innerWidth - 84))
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

type SessionThreadContentProps = {
  sessionId: string
  sessions: WorkspaceSession[]
  sessionRunState?: WorkspaceSession['run_state']
  isDesktopSidebar: boolean
  projectPath: string
  renderedBlocks: AnnotatedConversationBlock[]
  lastToolGroupId?: string | null
  sessionChangeSets: ChangeSetSummary[]
  isSubagentTimelinePending: boolean
  isInitialTimelinePending: boolean
  hasTimeline: boolean
  proposedPlanReplyDrafts: Record<string, string>
  pendingProposedPlanReplyEntryId: string | null
  canRespondToProposedPlan: boolean
  onProposedPlanReplyDraftChange: (entryId: string, value: string) => void
  onSubmitProposedPlanReply: (entryId: string, input: string) => void
  onPreviewImage: (value: { src: string; label: string; meta: string } | null) => void
  changeSetDiffs: Record<string, SessionChangeSetFileDiff | undefined>
  changeSetDiffErrors: Record<string, string | undefined>
  loadingChangeSetDiffKeys: Record<string, boolean | undefined>
  onLoadSessionChangeSets: () => Promise<void>
  onLoadChangeSetFileDiff: (input: {
    changeSetId: string
    path: string
    itemId?: string | null
  }) => Promise<void>
  onLoadFullTimeline: (triggerSource?: Exclude<TimelineLoadTrigger, null>) => void
  timelineLoadState: {
    hasEarlierEntries: boolean
    canLoadEarlierEntries: boolean
    isPulling: boolean
    pullDistance: number
    isReadyToLoad: boolean
    isLoadingFull: boolean
    indicatorOffset: number
    indicatorRotation: number
    triggerSource: TimelineLoadTrigger
  }
  canRollbackChangeSets: boolean
  pendingRollbackTurnId: string | null
  rollbackTurnError: RollbackTurnError | null
  rolledBackTurnIds: Record<string, true>
  onRollbackTurn: (turnId: string) => void
}

function DeferredMount({
  active,
  render,
  fallback = null,
}: {
  active: boolean
  render: () => ReactNode
  fallback?: ReactNode
}) {
  const [ready, setReady] = useState(!active)

  useEffect(() => {
    if (!active) {
      setReady(false)
      return
    }

    setReady(false)
    const frame = window.requestAnimationFrame(() => {
      setReady(true)
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [active])

  if (!active) {
    return null
  }

  return ready ? <>{render()}</> : <>{fallback}</>
}

const ToolGroupDetails = memo(function ToolGroupDetails({
  sessionId,
  group,
  projectPath,
}: {
  sessionId: string
  group: ToolTimelineGroup
  projectPath?: string
}) {
  const [expandedPatchFiles, setExpandedPatchFiles] = useState<Record<string, boolean>>({})
  const shouldLoadDetail =
    group.commandEntry.detail_available ||
    group.outputEntries.some((entry) => entry.detail_available)
  const detailQuery = useSessionToolCallDetail({
    sessionId,
    entryId: group.commandEntry.id,
    scope: {
      sessionId,
    },
    enabled: shouldLoadDetail,
  })

  const detail = detailQuery.data
  const commandEntry = detail?.command_entry ?? group.commandEntry
  const outputEntries =
    detail?.output_entries && detail.output_entries.length > 0
      ? detail.output_entries
      : group.outputEntries
  const patchSummary =
    commandEntry.title === 'apply_patch'
      ? (
          parseApplyPatchSummary(commandEntry.body, projectPath) ??
          toPatchSummaryFromTransport(commandEntry.patch_summary, projectPath) ??
          group.patchSummary
        )
      : group.patchSummary
  const commandDetail = getToolCommandDetail(commandEntry)
  const outputDetail = getToolOutputDetail(outputEntries)
  const togglePatchFile = (fileKey: string) => {
    setExpandedPatchFiles((current) => ({
      ...current,
      [fileKey]: !current[fileKey],
    }))
  }

  if (detailQuery.isPending && shouldLoadDetail && !detail) {
    return <div className="patch-file-card__empty">正在加载工具详情…</div>
  }

  return commandEntry.title === 'apply_patch' && patchSummary ? (
    patchSummary.files.length > 1 ? (
      <>
        <div className="tool-entry__patch-list">
          {patchSummary.files.map((file) => {
            const fileKey = `${group.id}:${file.path}`
            const isExpanded = Boolean(expandedPatchFiles[fileKey])
            return (
              <div
                key={fileKey}
                className={`tool-entry tool-entry--patch-file ${isExpanded ? 'is-expanded' : ''}`}
              >
                <button
                  type="button"
                  className="tool-entry__toggle"
                  onClick={() => togglePatchFile(fileKey)}
                  aria-expanded={isExpanded}
                >
                  <div className="tool-entry__summary">
                    <span className="tool-entry__status">已编辑</span>
                    <span className="tool-entry__command">
                      {renderStaticPathLinkLabel(file.displayPath)}
                    </span>
                    <span className="tool-entry__counts">
                      <span className="is-add">+{file.additions}</span>
                      <span className="is-remove">-{file.deletions}</span>
                    </span>
                  </div>
                  <span className="tool-entry__chevron" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </span>
                </button>

                {isExpanded ? (
                  <div className="tool-entry__details">
                    {file.diffText.trim() ? (
                      <div className="patch-file-card">
                        <div className="patch-file-card__header">
                          <div className="patch-file-card__path">{file.displayPath}</div>
                          <div className="patch-file-card__counts">
                            <span className="is-add">+{file.additions}</span>
                            <span className="is-remove">-{file.deletions}</span>
                          </div>
                        </div>
                        <div className="patch-file-card__diff">
                          {renderSessionDiffPreview(
                            file.diffText,
                            file.path,
                            '此变更没有可展示的补丁内容',
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="patch-file-card__empty">此变更没有可展示的补丁内容</div>
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        {detailQuery.isError ? (
          <div className="patch-file-card__empty">
            {detailQuery.error instanceof Error
              ? detailQuery.error.message
              : '无法加载工具详情。'}
          </div>
        ) : null}
      </>
    ) : (
      <div className="tool-entry__patch-list">
        {patchSummary.files.map((file) => (
          <div key={`${group.id}-${file.path}`} className="patch-file-card">
            <div className="patch-file-card__header">
              <div className="patch-file-card__path">{file.displayPath}</div>
              <div className="patch-file-card__counts">
                <span className="is-add">+{file.additions}</span>
                <span className="is-remove">-{file.deletions}</span>
              </div>
            </div>
            <div className="patch-file-card__diff">
              {renderSessionDiffPreview(file.diffText, file.path, '此变更没有可展示的补丁内容')}
            </div>
          </div>
        ))}
        {detailQuery.isError ? (
          <div className="patch-file-card__empty">
            {detailQuery.error instanceof Error
              ? detailQuery.error.message
              : '无法加载工具详情。'}
          </div>
        ) : null}
      </div>
    )
  ) : (
    <>
      <div className="tool-entry__section">
        <div className="tool-entry__label">命令</div>
        <pre className="tool-entry__pre">{commandDetail}</pre>
      </div>

      {outputDetail ? (
        <div className="tool-entry__section">
          <div className="tool-entry__label">输出</div>
          <pre className="tool-entry__pre">{outputDetail}</pre>
        </div>
      ) : null}

      {detailQuery.isError ? (
        <div className="patch-file-card__empty">
          {detailQuery.error instanceof Error
            ? detailQuery.error.message
            : '无法加载工具详情。'}
        </div>
      ) : null}
    </>
  )
})

const SessionThreadContent = memo(function SessionThreadContent({
  sessionId,
  sessions,
  sessionRunState,
  isDesktopSidebar,
  projectPath,
  renderedBlocks,
  lastToolGroupId,
  sessionChangeSets,
  isSubagentTimelinePending,
  isInitialTimelinePending,
  hasTimeline,
  proposedPlanReplyDrafts,
  pendingProposedPlanReplyEntryId,
  canRespondToProposedPlan,
  onProposedPlanReplyDraftChange,
  onSubmitProposedPlanReply,
  onPreviewImage,
  changeSetDiffs,
  changeSetDiffErrors,
  loadingChangeSetDiffKeys,
  onLoadSessionChangeSets,
  onLoadChangeSetFileDiff,
  onLoadFullTimeline,
  timelineLoadState,
  canRollbackChangeSets,
  pendingRollbackTurnId,
  rollbackTurnError,
  rolledBackTurnIds,
  onRollbackTurn,
}: SessionThreadContentProps) {
  const [expandedToolGroups, setExpandedToolGroups] = useState<Record<string, boolean>>({})
  const [expandedTurnHistory, setExpandedTurnHistory] = useState<Record<string, boolean>>({})
  const [expandedChangeFiles, setExpandedChangeFiles] = useState<Record<string, boolean>>({})
  const [activeInlinePathId, setActiveInlinePathId] = useState<string | null>(null)
  const [copiedEntryId, setCopiedEntryId] = useState<string | null>(null)
  const [copiedCodeBlockId, setCopiedCodeBlockId] = useState<string | null>(null)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const codeBlockCopyResetTimeoutRef = useRef<number | null>(null)
  const latestCompletedTurnId = useMemo(
    () =>
      [...renderedBlocks]
        .reverse()
        .find((block): block is RenderedTurnBlock =>
          block.kind === 'turn' && Boolean(block.turn.completion),
        )?.turn.id ?? null,
    [renderedBlocks],
  )

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('.conversation-inline-link')
      ) {
        return
      }

      setActiveInlinePathId(null)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
      if (codeBlockCopyResetTimeoutRef.current !== null) {
        window.clearTimeout(codeBlockCopyResetTimeoutRef.current)
      }
    }
  }, [])

  const toggleToolGroup = (toolGroupId: string) => {
    setExpandedToolGroups((current) => ({
      ...current,
      [toolGroupId]: !current[toolGroupId],
    }))
  }

  const toggleTurnHistory = (turnId: string) => {
    setExpandedTurnHistory((current) => ({
      ...current,
      [turnId]: !current[turnId],
    }))
  }

  const toggleChangeFile = (changeFileId: string) => {
    setExpandedChangeFiles((current) => ({
      ...current,
      [changeFileId]: !current[changeFileId],
    }))
  }

  useEffect(() => {
    const pendingDiffLoads = new Map<
      string,
      { changeSetId: string; path: string; itemId?: string | null }
    >()

    for (const block of renderedBlocks) {
      if (block.kind !== 'turn') {
        continue
      }

      const changeSet = block.changeSet
      if (!changeSet || changeSet.status !== 'completed' || changeSet.files.length === 0) {
        continue
      }

      const summaryScope = getTurnSummaryScope(block.turn.id)
      const summaryFiles = getSummaryChangeFiles(
        changeSet,
        projectPath,
        block.turn.completion?.patchSummary ?? null,
      )

      for (const file of summaryFiles) {
        if (!file.changeSetId || !file.diffAvailable) {
          continue
        }

        const changeFileId = getSummaryChangeFileId(summaryScope, file.path)
        if (!expandedChangeFiles[changeFileId]) {
          continue
        }

        const diffKey = getChangeSetFileDiffKey(file.changeSetId, file.path, file.itemId)
        if (changeSetDiffs[diffKey] || loadingChangeSetDiffKeys[diffKey]) {
          continue
        }

        pendingDiffLoads.set(diffKey, {
          changeSetId: file.changeSetId,
          path: file.path,
          itemId: file.itemId ?? null,
        })
      }
    }

    for (const input of pendingDiffLoads.values()) {
      void onLoadChangeSetFileDiff(input)
    }
  }, [
    changeSetDiffs,
    expandedChangeFiles,
    loadingChangeSetDiffKeys,
    onLoadChangeSetFileDiff,
    projectPath,
    renderedBlocks,
  ])

  const copyText = async (value: string) => {
    const text = value.trim()
    if (!text) {
      return false
    }

    const fallbackCopy = () => {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', 'true')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      textarea.style.pointerEvents = 'none'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        fallbackCopy()
      }
      return true
    } catch {
      return false
    }
  }

  const copyConversationEntry = async (entryId: string, value: string) => {
    const copied = await copyText(value)
    if (!copied) {
      return
    }

    setCopiedEntryId(entryId)
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current)
    }
    copyResetTimeoutRef.current = window.setTimeout(() => {
      setCopiedEntryId((current) => (current === entryId ? null : current))
      copyResetTimeoutRef.current = null
    }, 1400)
  }

  const copyCodeBlockMeta = async (blockId: string, value: string) => {
    const copied = await copyText(value)
    if (!copied) {
      return
    }

    setCopiedCodeBlockId(blockId)
    if (codeBlockCopyResetTimeoutRef.current !== null) {
      window.clearTimeout(codeBlockCopyResetTimeoutRef.current)
    }
    codeBlockCopyResetTimeoutRef.current = window.setTimeout(() => {
      setCopiedCodeBlockId((current) => (current === blockId ? null : current))
      codeBlockCopyResetTimeoutRef.current = null
    }, 1400)
  }

  function renderDiffPreview(diffText: string, filePath: string, emptyMessage: string) {
    return renderSessionDiffPreview(diffText, filePath, emptyMessage)
  }

  function renderPathLinkToken(label: string, path: string, tokenKey: string) {
    const isActive = activeInlinePathId === tokenKey
    const toggleInlinePath = () => {
      setActiveInlinePathId((current) => (current === tokenKey ? null : tokenKey))
    }

    return (
      <InlinePathLinkToken
        key={tokenKey}
        isActive={isActive}
        label={label}
        path={path}
        tokenKey={tokenKey}
        onToggle={toggleInlinePath}
      />
    )
  }

  function renderToolPathLink(
    path: string,
    tokenKey: string,
    displayPath = toDisplayPath(path, projectPath),
  ) {
    return renderPathLinkToken(getPathBasename(displayPath), displayPath, tokenKey)
  }

  function renderInlineContent(value: string, entryId: string) {
    const tokens = parseInlineTokens(value)

    return tokens.map((token, index) => {
      const tokenKey = `${entryId}-${index}`

      if (token.kind === 'text') {
        return <span key={tokenKey}>{token.value}</span>
      }

      if (token.kind === 'code') {
        return (
          <code key={tokenKey} className="conversation-inline-code">
            {token.value}
          </code>
        )
      }

      if (token.kind === 'strong') {
        return (
          <strong key={tokenKey}>
            {renderInlineContent(token.value, `${tokenKey}-strong`)}
          </strong>
        )
      }

      if (token.kind === 'emphasis') {
        return (
          <em key={tokenKey}>
            {renderInlineContent(token.value, `${tokenKey}-emphasis`)}
          </em>
        )
      }

      if (token.kind === 'skill') {
        return (
          <span key={tokenKey} className="conversation-skill-token">
            {token.raw}
          </span>
        )
      }

      if (token.kind === 'command') {
        return (
          <span key={tokenKey} className="conversation-command-token">
            {token.raw}
          </span>
        )
      }

      return renderPathLinkToken(token.label, token.path, tokenKey)
    })
  }

  function renderMarkdownContent(value: string, entryId: string) {
    const blocks = parseMarkdownBlocks(value)

    return blocks.map((block, blockIndex) => {
      const blockKey = `${entryId}-block-${blockIndex}`

      if (block.kind === 'heading') {
        const level = Math.min(block.level, 3)
        const HeadingTag = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
        return (
          <HeadingTag
            key={blockKey}
            className={`conversation-markdown-heading is-level-${level}`}
          >
            {renderInlineContent(block.text, `${blockKey}-heading`)}
          </HeadingTag>
        )
      }

      if (block.kind === 'list') {
        const ListTag = block.ordered ? 'ol' : 'ul'
        return (
          <ListTag key={blockKey} className="conversation-markdown-list">
            {block.items.map((item, itemIndex) => (
              <li
                key={`${blockKey}-item-${itemIndex}`}
                value={block.ordered ? (item.ordinal ?? undefined) : undefined}
              >
                {renderInlineContent(item.text, `${blockKey}-item-${itemIndex}`)}
              </li>
            ))}
          </ListTag>
        )
      }

      if (block.kind === 'code') {
        const copyId = `${blockKey}-meta`
        return (
          <div key={blockKey} className="conversation-markdown-code-block">
            {block.rawInfo ? (
              <div className="conversation-markdown-code-block__meta">
                <span className="conversation-markdown-code-block__meta-label">
                  {block.rawInfo}
                </span>
                <button
                  type="button"
                  className={`conversation-markdown-code-block__copy ${
                    copiedCodeBlockId === copyId ? 'is-copied' : ''
                  }`}
                  onClick={() => {
                    void copyCodeBlockMeta(copyId, block.content)
                  }}
                  aria-label={copiedCodeBlockId === copyId ? '已复制代码块内容' : '复制代码块内容'}
                >
                  <span className="conversation-markdown-code-block__copy-icon" aria-hidden="true">
                    {copiedCodeBlockId === copyId ? <IconCheck /> : <IconCopy />}
                  </span>
                  <span className="sr-only">
                    {copiedCodeBlockId === copyId ? '已复制' : '复制'}
                  </span>
                </button>
              </div>
            ) : null}
            <pre className="conversation-markdown-code-block__pre">
              <code>{block.content}</code>
            </pre>
          </div>
        )
      }

      return (
        <p key={blockKey} className="conversation-markdown-paragraph">
          {block.lines.map((line, lineIndex) => (
            <span key={`${blockKey}-line-${lineIndex}`}>
              {lineIndex > 0 ? <br /> : null}
              {renderInlineContent(line, `${blockKey}-line-${lineIndex}`)}
            </span>
          ))}
        </p>
      )
    })
  }

  function renderProposedPlanBlock(entry: TimelineEntry, content: string, blockIndex: number) {
    const entryKey = `${entry.id}:proposed-plan:${blockIndex}`
    const draftValue = proposedPlanReplyDrafts[entryKey] ?? ''
    const isPending = pendingProposedPlanReplyEntryId === entryKey
    const isReplyDisabled = !canRespondToProposedPlan || isPending

    return (
      <div key={entryKey} className="proposed-plan-card">
        <div className="proposed-plan-card__content">
          {renderMarkdownContent(content, `${entryKey}:content`)}
        </div>

        <div className="proposed-plan-card__footer">
          <div className="proposed-plan-card__title">实施此计划？</div>

          <div className="proposed-plan-card__actions">
            <button
              type="button"
              className="proposed-plan-card__confirm"
              disabled={isReplyDisabled}
              onClick={() => {
                onSubmitProposedPlanReply(entryKey, '是，实施此计划')
              }}
            >
              {isPending ? '回复中…' : '是，实施此计划'}
            </button>

            <div className="proposed-plan-card__custom">
              <input
                type="text"
                className="proposed-plan-card__input"
                value={draftValue}
                disabled={isReplyDisabled}
                placeholder="否，请告知如何调整"
                onChange={(event) => {
                  onProposedPlanReplyDraftChange(entryKey, event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !draftValue.trim() || isReplyDisabled) {
                    return
                  }

                  event.preventDefault()
                  onSubmitProposedPlanReply(entryKey, draftValue)
                }}
              />

              <button
                type="button"
                className="proposed-plan-card__submit"
                disabled={isReplyDisabled || !draftValue.trim()}
                onClick={() => {
                  onSubmitProposedPlanReply(entryKey, draftValue)
                }}
              >
                {isPending ? '回复中…' : '回复'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  function renderAssistantEntryBody(entry: TimelineEntry) {
    const contentBlocks = parseAssistantContentBlocks(entry.body)
    const hasProposedPlan = contentBlocks.some((block) => block.kind === 'proposed-plan')
    if (!hasProposedPlan) {
      return renderMarkdownContent(entry.body, entry.id)
    }

    return contentBlocks.map((block, blockIndex) => {
      const blockKey = `${entry.id}-content-${blockIndex}`

      if (block.kind === 'markdown') {
        return (
          <div key={blockKey} className="conversation-entry__rich-block">
            {renderMarkdownContent(block.content, blockKey)}
          </div>
        )
      }

      return renderProposedPlanBlock(entry, block.content, blockIndex)
    })
  }

  function renderEntryAttachments(entry: TimelineEntry) {
    const attachments = mergeTimelineAttachments([], entry.attachments)
    if (attachments.length === 0) {
      return null
    }

    const imageAttachments = attachments.filter(isImageTimelineAttachment)
    const fileAttachments = attachments.filter(
      (attachment) => !isImageTimelineAttachment(attachment),
    )

    return (
      <div className="conversation-entry__attachments">
        {imageAttachments.length > 0 ? (
          <div className="conversation-entry__attachment-grid">
            {imageAttachments.map((attachment) => {
              const sizeLabel = formatAttachmentSize(attachment.size_bytes)
              const label = attachment.name ?? '图片'
              const previewMeta = `图片${sizeLabel ? ` · ${sizeLabel}` : ''}`
              const imageCard = (
                <>
                  <div className="conversation-entry__attachment-media">
                    {attachment.content_url ? (
                      <>
                        <img src={attachment.content_url} alt={label} loading="lazy" />
                        <span className="conversation-entry__attachment-badge">预览</span>
                      </>
                    ) : (
                      <div className="conversation-entry__attachment-fallback">无法预览</div>
                    )}
                  </div>
                  <div className="conversation-entry__attachment-caption">
                    <span className="conversation-entry__attachment-title">{label}</span>
                    <span className="conversation-entry__attachment-meta">
                      {previewMeta}
                    </span>
                  </div>
                </>
              )

              if (!attachment.content_url) {
                return (
                  <div
                    key={`${entry.id}:${attachment.id}`}
                    className="conversation-entry__attachment-card is-image"
                  >
                    {imageCard}
                  </div>
                )
              }

              return (
                <button
                  type="button"
                  key={`${entry.id}:${attachment.id}`}
                  className="conversation-entry__attachment-card is-image"
                  onClick={() =>
                    onPreviewImage({
                      src: attachment.content_url!,
                      label,
                      meta: previewMeta,
                    })
                  }
                  aria-label={`预览 ${label}`}
                >
                  {imageCard}
                </button>
              )
            })}
          </div>
        ) : null}

        {fileAttachments.length > 0 ? (
          <div className="conversation-entry__file-list">
            {fileAttachments.map((attachment) => {
              const sizeLabel = formatAttachmentSize(attachment.size_bytes)
              const content = (
                <>
                  <span className="conversation-entry__file-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
                      <path d="M14 3v5h5" />
                      <path d="M9 13h6" />
                      <path d="M9 17h4" />
                    </svg>
                  </span>
                  <span className="conversation-entry__file-copy">
                    <span className="conversation-entry__file-title">
                      {attachment.name ?? '附件'}
                    </span>
                    <span className="conversation-entry__file-meta">
                      文件{sizeLabel ? ` · ${sizeLabel}` : ''}
                    </span>
                  </span>
                </>
              )

              if (!attachment.content_url) {
                return (
                  <div
                    key={`${entry.id}:${attachment.id}`}
                    className="conversation-entry__file-card"
                  >
                    {content}
                  </div>
                )
              }

              return (
                <a
                  key={`${entry.id}:${attachment.id}`}
                  className="conversation-entry__file-card"
                  href={attachment.content_url}
                  download={attachment.name ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  {content}
                </a>
              )
            })}
          </div>
        ) : null}
      </div>
    )
  }

  function renderChangeSetSummaryFiles(scope: string, files: SummaryChangeFile[]) {
    return (
      <div className="turn-patch-summary__files">
        {files.map((file) => {
          const changeFileId = getSummaryChangeFileId(scope, file.path)
          const isExpanded = Boolean(expandedChangeFiles[changeFileId])
          const diffKey =
            file.changeSetId
              ? getChangeSetFileDiffKey(file.changeSetId, file.path, file.itemId)
              : null
          const loadedDiff = diffKey ? changeSetDiffs[diffKey] : undefined
          const diffLoading = diffKey ? loadingChangeSetDiffKeys[diffKey] === true : false
          const diffError = diffKey ? changeSetDiffErrors[diffKey] ?? null : null
          const diffText = loadedDiff?.file.diff ?? file.diffText ?? ''
          const emptyMessage = loadedDiff?.empty_message ?? file.emptyMessage

          return (
            <div
              key={changeFileId}
              className={`turn-patch-file ${isExpanded ? 'is-expanded' : ''}`}
            >
              <button
                type="button"
                className="turn-patch-file__toggle"
                onClick={() => {
                  toggleChangeFile(changeFileId)
                  if (!file.changeSetId) {
                    void onLoadSessionChangeSets()
                  }
                  if (
                    diffKey &&
                    file.changeSetId &&
                    file.diffAvailable &&
                    !loadedDiff &&
                    !diffLoading
                  ) {
                    void onLoadChangeSetFileDiff({
                      changeSetId: file.changeSetId,
                      path: file.path,
                      itemId: file.itemId ?? null,
                    })
                  }
                }}
                aria-expanded={isExpanded}
              >
                <div className="turn-patch-file__path">{file.pathLabel}</div>
                <div className="turn-patch-file__meta">
                  <span className="turn-patch-summary__counts">
                    <span className="is-add">+{file.additions}</span>
                    <span className="is-remove">-{file.deletions}</span>
                  </span>
                  <span className="turn-patch-file__chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </span>
                </div>
              </button>

              {isExpanded ? (
                <div className="turn-patch-file__detail">
                  {diffLoading ? (
                    <div className="patch-file-card__empty">正在载入差异详情…</div>
                  ) : diffError ? (
                    <div className="patch-file-card__empty">{diffError}</div>
                  ) : file.diffAvailable === false && !diffText.trim() ? (
                    <div className="patch-file-card__empty">{emptyMessage}</div>
                  ) : (
                    <DeferredMount
                      active={isExpanded}
                      fallback={<div className="patch-file-card__empty">正在展开差异…</div>}
                      render={() => renderDiffPreview(diffText, file.path, emptyMessage)}
                    />
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    )
  }

  function renderChangeSetFiles(changeSet: ChangeSetSummary) {
    return getLiveChangeFiles(changeSet).map((file) => {
      const changeFileId = `live:${changeSet.id}:${file.item_id ?? 'summary'}:${file.path}`
      const isExpanded = Boolean(expandedChangeFiles[changeFileId])
      const isRunning = changeSet.status === 'running'
      const diffKey = getChangeSetFileDiffKey(changeSet.id, file.path, file.item_id)
      const loadedDiff = changeSetDiffs[diffKey]
      const diffLoading = loadingChangeSetDiffKeys[diffKey] === true
      const diffError = changeSetDiffErrors[diffKey] ?? null
      const diffText = loadedDiff?.file.diff ?? ''
      const emptyMessage = loadedDiff?.empty_message ?? '此变更还没有可展示的补丁内容'

      return (
        <section key={changeFileId} className="conversation-entry is-tool-group">
          <div
            className={`tool-entry ${isRunning ? 'is-running' : 'is-complete'} ${
              isExpanded ? 'is-expanded' : ''
            } is-patch`}
          >
            <button
              type="button"
              className="tool-entry__toggle"
              onClick={() => {
                toggleChangeFile(changeFileId)
                if (file.diff_available && !loadedDiff && !diffLoading) {
                  void onLoadChangeSetFileDiff({
                    changeSetId: changeSet.id,
                    path: file.path,
                    itemId: file.item_id ?? null,
                  })
                }
              }}
              aria-expanded={isExpanded}
            >
              <div className="tool-entry__summary">
                <span className="tool-entry__status">已编辑</span>
                <span className="tool-entry__command">
                  {renderToolPathLink(
                    file.path,
                    `${changeFileId}:live-link`,
                    toDisplayPath(file.path, projectPath),
                  )}
                </span>
                <span className="tool-entry__counts">
                  <span className="is-add">+{file.additions}</span>
                  <span className="is-remove">-{file.deletions}</span>
                </span>
              </div>
              <span className="tool-entry__chevron" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </span>
            </button>

            {isExpanded ? (
              <div className="tool-entry__details">
                {diffLoading ? (
                  <div className="patch-file-card__empty">正在载入详情…</div>
                ) : diffError ? (
                  <div className="patch-file-card__empty">{diffError}</div>
                ) : !file.diff_available && !diffText.trim() ? (
                  <div className="patch-file-card__empty">{emptyMessage}</div>
                ) : (
                  <DeferredMount
                    active={isExpanded}
                    fallback={<div className="patch-file-card__empty">正在展开详情…</div>}
                    render={() => (
                      <div className="tool-entry__patch-list">
                        <div className="patch-file-card">
                          <div className="patch-file-card__header">
                            <div className="patch-file-card__path">{toDisplayPath(file.path, projectPath)}</div>
                            <div className="patch-file-card__counts">
                              <span className="is-add">+{file.additions}</span>
                              <span className="is-remove">-{file.deletions}</span>
                            </div>
                          </div>
                          <div className="patch-file-card__diff">
                            {renderDiffPreview(diffText, file.path, emptyMessage)}
                          </div>
                        </div>
                      </div>
                    )}
                  />
                )}
              </div>
            ) : null}
          </div>
        </section>
      )
    })
  }

  const getRollbackStateForTurn = (turnId: string) => {
    const isEligible =
      canRollbackChangeSets &&
      latestCompletedTurnId === turnId &&
      !rolledBackTurnIds[turnId]
    const error =
      rollbackTurnError?.turnId === turnId
        ? rollbackTurnError.message
        : null

    return {
      isEligible,
      isPending: pendingRollbackTurnId === turnId,
      error,
    }
  }

  function renderChangeSetSummary(
    changeSet: ChangeSetSummary,
    turnId: string,
    scope: string,
    fallbackSummary?: PatchSummary | null,
  ) {
    const summaryFiles = getSummaryChangeFiles(changeSet, projectPath, fallbackSummary)
    const totalAdditions = summaryFiles.reduce((sum, file) => sum + file.additions, 0)
    const totalDeletions = summaryFiles.reduce((sum, file) => sum + file.deletions, 0)
    const rollbackState = getRollbackStateForTurn(turnId)

    return (
      <div className="turn-patch-summary">
        <div className="turn-patch-summary__header">
          <div className="turn-patch-summary__title">
            <span>{summaryFiles.length} 个文件已更改</span>
            <span className="turn-patch-summary__counts">
              <span className="is-add">+{totalAdditions}</span>
              <span className="is-remove">-{totalDeletions}</span>
            </span>
          </div>
          {rollbackState.isEligible ? (
            <div className="turn-patch-summary__actions">
              <button
                type="button"
                className="turn-patch-summary__action"
                onClick={() => onRollbackTurn(turnId)}
                disabled={rollbackState.isPending}
                aria-label={rollbackState.isPending ? '正在回滚这轮改动' : '回滚这轮改动'}
                title={rollbackState.isPending ? '正在回滚这轮改动' : '回滚这轮改动'}
              >
                <IconTurnRollback />
              </button>
            </div>
          ) : null}
        </div>

        {rollbackState.error ? (
          <div className="turn-patch-summary__notice is-error">{rollbackState.error}</div>
        ) : null}

        {renderChangeSetSummaryFiles(scope, summaryFiles)}
      </div>
    )
  }

  function renderPatchSummary(turnId: string, scope: string, summary: PatchSummary) {
    const rollbackState = getRollbackStateForTurn(turnId)

    return (
      <div className="turn-patch-summary">
        <div className="turn-patch-summary__header">
          <div className="turn-patch-summary__title">
            <span>{summary.files.length} 个文件已更改</span>
            <span className="turn-patch-summary__counts">
              <span className="is-add">+{summary.additions}</span>
              <span className="is-remove">-{summary.deletions}</span>
            </span>
          </div>
          {rollbackState.isEligible ? (
            <div className="turn-patch-summary__actions">
              <button
                type="button"
                className="turn-patch-summary__action"
                onClick={() => onRollbackTurn(turnId)}
                disabled={rollbackState.isPending}
                aria-label={rollbackState.isPending ? '正在回滚这轮改动' : '回滚这轮改动'}
                title={rollbackState.isPending ? '正在回滚这轮改动' : '回滚这轮改动'}
              >
                <IconTurnRollback />
              </button>
            </div>
          ) : null}
        </div>

        {rollbackState.error ? (
          <div className="turn-patch-summary__notice is-error">{rollbackState.error}</div>
        ) : null}

        {renderChangeSetSummaryFiles(
          scope,
          summary.files.map((file) => ({
            path: file.path,
            pathLabel: file.displayPath,
            additions: file.additions,
            deletions: file.deletions,
            diffText: file.diffText,
            emptyMessage: '此变更没有可展示的补丁内容',
          })),
        )}
      </div>
    )
  }

  function renderSubagentNotificationEntry(
    entry: TimelineEntry,
    notification: ParsedSubagentNotification,
  ) {
    const relatedSession =
      notification.agentId
        ? sessions.find((item) => item.id === notification.agentId) ?? null
        : null
    const accent = getSubagentAccent(
      relatedSession?.subagent?.nickname ?? relatedSession?.title ?? notification.agentId,
    )
    const entryKey = `subagent:${entry.id}`
    const isExpanded = Boolean(expandedToolGroups[entryKey])
    const isRunning = notification.state === 'working'
    const statusLabel =
      notification.state === 'completed'
        ? '子代理返回'
        : notification.state === 'shutdown'
          ? '子代理已关闭'
        : notification.state === 'errored'
          ? '子代理异常'
          : '子代理处理中'
    const agentLabel =
      relatedSession?.subagent?.nickname ?? relatedSession?.title ?? '子代理'

    return (
      <section key={entry.id} className="conversation-entry is-tool-group">
        <div
          className={`tool-entry is-subagent ${isRunning ? 'is-running' : 'is-complete'} ${
            isExpanded ? 'is-expanded' : ''
          }`}
          style={{ '--subagent-accent': accent } as CSSProperties}
        >
          <button
            type="button"
            className="tool-entry__toggle"
            onClick={() => toggleToolGroup(entryKey)}
            aria-expanded={isExpanded}
          >
            <div className="tool-entry__summary">
              <span className="tool-entry__status">{statusLabel}</span>
              <span className="tool-entry__command tool-entry__command--agent">
                {agentLabel}
              </span>
            </div>
            <span className="tool-entry__chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </span>
          </button>

          {isExpanded ? (
            <div className="tool-entry__details">
              <DeferredMount
                active={isExpanded}
                fallback={<div className="patch-file-card__empty">正在展开详情…</div>}
                render={() => (
                  <div className="tool-entry__section">
                    <div className="tool-entry__label">{agentLabel}</div>
                    <div className="tool-entry__markdown">
                      {renderMarkdownContent(notification.body, `${entry.id}-subagent`)}
                    </div>
                  </div>
                )}
              />
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  function renderConversationItem(item: RenderedConversationItem) {
    if (item.kind === 'tool-group') {
      const { group } = item
      if (
        group.commandEntry.title === 'apply_patch' &&
        hasNearbyAppServerChangeSet(
          sessionChangeSets,
          group.commandEntry.timestamp,
          group.patchSummary,
        )
      ) {
        return null
      }
      const isExpanded = Boolean(expandedToolGroups[group.id])
      const isRunning =
        sessionRunState === 'running' &&
        lastToolGroupId === group.id &&
        group.outputEntries.length === 0
      const isApplyPatch = group.commandEntry.title === 'apply_patch' && Boolean(group.patchSummary)
      const hasNestedPatchFiles = isApplyPatch && (group.patchSummary?.files.length ?? 0) > 1
      const summaryText = isApplyPatch
        ? group.patchSummary!.files.length === 1
          ? group.patchSummary!.files[0]!.displayPath
          : `${group.patchSummary!.files.length} 个文件`
        : getToolSummaryText(group.commandEntry)

      return (
        <section key={group.id} className="conversation-entry is-tool-group">
          <div
            className={`tool-entry ${isRunning ? 'is-running' : 'is-complete'} ${
              isExpanded ? 'is-expanded' : ''
            } ${isApplyPatch ? 'is-patch' : ''} ${hasNestedPatchFiles ? 'has-flat-patch-list' : ''}`}
          >
            <button
              type="button"
              className="tool-entry__toggle"
              onClick={() => toggleToolGroup(group.id)}
              aria-expanded={isExpanded}
            >
              <div className="tool-entry__summary">
                <span className="tool-entry__status">
                  {isApplyPatch ? '已编辑' : isRunning ? '正在执行' : '已执行'}
                </span>
                <span className="tool-entry__command">
                  {isApplyPatch && group.patchSummary?.files.length === 1
                    ? renderToolPathLink(
                        group.patchSummary.files[0]!.path,
                        `${group.id}:patch-link`,
                        group.patchSummary.files[0]!.displayPath,
                      )
                    : summaryText}
                </span>
                {isApplyPatch && group.patchSummary ? (
                  <span className="tool-entry__counts">
                    <span className="is-add">+{group.patchSummary.additions}</span>
                    <span className="is-remove">-{group.patchSummary.deletions}</span>
                  </span>
                ) : null}
              </div>
              <span className="tool-entry__chevron" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </span>
            </button>

            {isExpanded ? (
              <div className="tool-entry__details">
                <DeferredMount
                  active={isExpanded}
                  fallback={<div className="patch-file-card__empty">正在展开详情…</div>}
                  render={() => (
                    <ToolGroupDetails
                      sessionId={sessionId}
                      group={group}
                      projectPath={projectPath}
                    />
                  )}
                />
              </div>
            ) : null}
          </div>
        </section>
      )
    }

    const entry = item.entry
    const subagentNotification =
      entry.kind === 'user' ? parseSubagentNotification(entry.body) : null

    if (subagentNotification) {
      return renderSubagentNotificationEntry(entry, subagentNotification)
    }

    if (entry.kind === 'thinking') {
      if (sessionRunState !== 'running') {
        return null
      }

      return (
        <section key={entry.id} className="conversation-entry is-thinking-status">
          <div className="thinking-status-pill">
            <span>正在思考</span>
          </div>
        </section>
      )
    }

    if (isContextCompactionEntry(entry)) {
      return (
        <section key={entry.id} className="conversation-context-compact">
          <div className="context-compact-divider">
            <span>背景信息已自动压缩</span>
          </div>
        </section>
      )
    }

    if (entry.kind === 'system' && entry.title === 'system_prompt') {
      return null
    }

    if (entry.kind === 'system' && entry.title === 'runtime-status') {
      const tone = getRuntimeStatusTone(entry.body)
      return (
        <section key={entry.id} className="conversation-entry is-runtime-status">
          <div className={`runtime-status-entry is-${tone}`}>
            <div className="runtime-status-entry__label">
              {getRuntimeStatusLabel(entry.body)}
            </div>
            <pre className="runtime-status-entry__body">{entry.body}</pre>
          </div>
        </section>
      )
    }

    return (
      <section
        key={entry.id}
        className={`conversation-entry ${
          entry.kind === 'user' ? 'is-user' : 'is-system'
        } is-${entry.kind}`}
      >
        {entry.kind === 'user' ? (
          <div className="conversation-entry__stack">
            <div className="conversation-entry__body">
              {entry.body.trim() ? renderMarkdownContent(entry.body, entry.id) : null}
              {entry.attachments.length > 0 ? renderEntryAttachments(entry) : null}
            </div>
            {entry.body.trim() ? (
              <button
                type="button"
                className={`conversation-entry__copy ${copiedEntryId === entry.id ? 'is-copied' : ''}`}
                onClick={() => {
                  void copyConversationEntry(entry.id, entry.body)
                }}
                aria-label={copiedEntryId === entry.id ? '已复制消息' : '复制消息'}
              >
                <span className="conversation-entry__copy-icon" aria-hidden="true">
                  {copiedEntryId === entry.id ? <IconCheck /> : <IconCopy />}
                </span>
                <span className="sr-only">{copiedEntryId === entry.id ? '已复制' : '复制'}</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="conversation-entry__body">
            {entry.body.trim()
              ? entry.kind === 'assistant'
                ? renderAssistantEntryBody(entry)
                : renderMarkdownContent(entry.body, entry.id)
              : null}
            {entry.attachments.length > 0 ? renderEntryAttachments(entry) : null}
          </div>
        )}
      </section>
    )
  }

  if (isSubagentTimelinePending) {
    return <div className="empty-panel">正在载入子代理会话…</div>
  }

  if (isInitialTimelinePending) {
    return (
      <div className="empty-panel empty-panel--loading" role="status" aria-live="polite" aria-busy="true">
        <span className="empty-panel__loading-dots" aria-hidden="true">
          <span className="empty-panel__loading-dot" />
          <span className="empty-panel__loading-dot" />
          <span className="empty-panel__loading-dot" />
        </span>
        <span className="sr-only">正在加载会话记录</span>
      </div>
    )
  }

  if (!hasTimeline) {
    return <div className="empty-panel">这个会话还没有历史记录。</div>
  }

  const showTimelinePullHint =
    timelineLoadState.canLoadEarlierEntries ||
    timelineLoadState.isPulling ||
    timelineLoadState.isLoadingFull
  const showTimelinePullIndicator =
    timelineLoadState.isPulling ||
    timelineLoadState.isLoadingFull ||
    timelineLoadState.triggerSource === 'click'
  const timelinePullHintLabel = timelineLoadState.isLoadingFull
    ? '正在加载全部对话…'
    : timelineLoadState.isPulling
      ? timelineLoadState.isReadyToLoad
        ? '松开加载全部'
        : '下拉加载更多'
      : isDesktopSidebar
        ? '加载全部对话'
        : '点击加载全部'
  const timelineIndicatorOffset = timelineLoadState.isLoadingFull || timelineLoadState.triggerSource === 'click'
    ? TIMELINE_HISTORY_INDICATOR_TARGET_OFFSET
    : timelineLoadState.indicatorOffset
  const timelineIndicatorStyle = {
    opacity: showTimelinePullIndicator ? 1 : 0,
    transform: `translate3d(-50%, calc(-100% + ${timelineIndicatorOffset}px), 0) scale(${showTimelinePullIndicator ? 1 : 0.92})`,
  } as CSSProperties
  const timelineIndicatorTrackStyle = {
    transform: `rotate(${timelineLoadState.indicatorRotation}deg)`,
  } as CSSProperties

  return (
    <>
      {showTimelinePullHint ? (
        <section className={`conversation-entry is-history-loader ${timelineLoadState.isReadyToLoad ? 'is-ready' : ''}`}>
          <div
            className={`timeline-history-loader ${timelineLoadState.isLoadingFull ? 'is-loading' : ''} ${timelineLoadState.triggerSource === 'click' ? 'is-click-loading' : ''}`}
          >
            <span
              className="timeline-history-loader__indicator"
              style={timelineIndicatorStyle}
              aria-hidden="true"
            >
              <span className="timeline-history-loader__indicator-surface">
                <span
                  className="timeline-history-loader__indicator-track"
                  style={timelineIndicatorTrackStyle}
                >
                  <span className={`timeline-history-loader__indicator-spin ${timelineLoadState.isLoadingFull ? 'is-loading' : ''}`}>
                    <span className="timeline-history-loader__indicator-icon">
                      <IconTimelineRefresh />
                    </span>
                  </span>
                </span>
              </span>
            </span>
            <div className="turn-complete-divider timeline-history-loader__divider">
              {timelineLoadState.isLoadingFull ? (
                <span className="timeline-history-loader__content is-loading">
                  <span>{timelinePullHintLabel}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className={`timeline-history-loader__button ${timelineLoadState.isPulling ? 'is-pulling' : ''}`}
                  onClick={() => onLoadFullTimeline('click')}
                >
                  {timelinePullHintLabel}
                </button>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {renderedBlocks.map((block) => {
    if (block.kind === 'item') {
      return renderConversationItem(block.item)
    }

    const { turn } = block
    const changeSet = block.changeSet
    const turnPatchSummary = turn.completion?.patchSummary ?? null
    const historyExpanded = Boolean(expandedTurnHistory[turn.id])
    const showCollapsedHistory = turn.hiddenItems.length > 0 && !historyExpanded
    const historyToggleLabel = historyExpanded
      ? formatExpandedTurnHistoryLabel(turn.hiddenItems)
      : formatCollapsedTurnHistoryLabel(turn.hiddenItems)

    return (
      <section key={turn.id} className="conversation-turn">
        {turn.visibleStartItems.map((item) => renderConversationItem(item))}

        {turn.hiddenItems.length > 0 ? (
          <div className="conversation-turn__history">
            <button
              type="button"
              className={`turn-history-toggle ${historyExpanded ? 'is-expanded' : ''}`}
              onClick={() => toggleTurnHistory(turn.id)}
              aria-expanded={historyExpanded}
            >
              <span className="turn-history-toggle__label">
                {historyToggleLabel}
              </span>
              <span className="turn-history-toggle__chevron" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </span>
            </button>

            {showCollapsedHistory
              ? null
              : turn.hiddenItems.map((item) => renderConversationItem(item))}
          </div>
        ) : null}

        {turn.completion && turn.visibleEndItems.length > 0 ? (
          <section className="conversation-turn-complete">
            <div className="turn-complete-divider">
              <span>{turn.completion.durationLabel}</span>
            </div>
          </section>
        ) : null}

        {turn.visibleEndItems.map((item) => renderConversationItem(item))}

        {changeSet &&
        changeSet.source === 'app-server' &&
        changeSet.files.length > 0
          ? renderChangeSetFiles(changeSet)
          : null}

        {turn.completion && turn.visibleEndItems.length === 0 ? (
          <section className="conversation-turn-complete">
            <div className="turn-complete-divider">
              <span>{turn.completion.durationLabel}</span>
            </div>
          </section>
        ) : null}

        {changeSet && changeSet.status === 'completed' && changeSet.files.length > 0
          ? renderChangeSetSummary(
              changeSet,
              turn.id,
              getTurnSummaryScope(turn.id),
              turnPatchSummary,
            )
          : turnPatchSummary
            ? renderPatchSummary(turn.id, getTurnSummaryScope(turn.id), turnPatchSummary)
            : null}
      </section>
    )
      })}
    </>
  )
})

type SessionDetailPageProps = {
  sessionId?: string
  workspaceDirectorySnapshot?: WorkspaceDirectorySnapshot | null
  workspaceAgentIndicatorState?: AgentIndicatorState
  embedded?: boolean
  isDesktopSidebar?: boolean
  sidebarOffset?: number
  isSidebarDragging?: boolean
  onOpenSidebar?: () => void
  onSelectSession?: (sessionId: string | null) => void
  onExitToNodes?: () => void
}

export const SessionDetailPage = ({
  sessionId: sessionIdProp,
  workspaceDirectorySnapshot = null,
  workspaceAgentIndicatorState,
  embedded = false,
  isDesktopSidebar: isDesktopSidebarProp,
  sidebarOffset = 0,
  isSidebarDragging: isSidebarDraggingProp = false,
  onOpenSidebar,
  onSelectSession,
  onExitToNodes,
}: SessionDetailPageProps = {}) => {
  const { sessionId: routeSessionId } = useParams({ strict: false }) as { sessionId?: string }
  const sessionId = sessionIdProp ?? routeSessionId ?? ''
  const pendingSessionHandoff = readPendingSessionHandoff(sessionId)
  const fallbackSessionAgentId =
    pendingSessionHandoff?.agentId ??
    readStoredAgentId()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: fetchedWorkspaceDirectory } = useWorkspaceDirectory({
    scope: {
      sessionId,
      agentId: fallbackSessionAgentId ?? undefined,
    },
    selectedSessionId: sessionId,
    enabled: !embedded && !workspaceDirectorySnapshot,
  })
  const workspaceDirectory = useMemo(
    () => buildOptimisticWorkspaceDirectory(
      workspaceDirectorySnapshot ?? fetchedWorkspaceDirectory,
      pendingSessionHandoff,
    ),
    [fetchedWorkspaceDirectory, pendingSessionHandoff, workspaceDirectorySnapshot],
  )
  const sessionSummary =
    workspaceDirectory?.sessions.find((item) => item.id === sessionId) ?? null
  const sessionHasLocalSeed = Boolean(sessionSummary || pendingSessionHandoff?.session)
  const sessionDetailQuery = useWorkspaceSessionDetail({
    sessionId,
    scope: {
      sessionId,
      agentId: fallbackSessionAgentId ?? undefined,
    },
    enabled: Boolean(sessionId),
  })
  const {
    historyState,
    archivedState,
    loadMoreHistory,
    loadMoreArchived,
    reset: resetSessionPaging,
  } = useWorkspaceSessionPaging({
    scope: {
      sessionId,
    },
    selectedSessionId: sessionId,
  })
  const conversationPageRef = useRef<HTMLDivElement | null>(null)
  const conversationMainRef = useRef<HTMLDivElement | null>(null)
  const conversationScrollRef = useRef<HTMLDivElement | null>(null)
  const workbenchRailRef = useRef<HTMLElement | null>(null)
  const topbarViewToggleRef = useRef<HTMLDivElement | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [isDesktopSidebar, setIsDesktopSidebar] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_SIDEBAR_BREAKPOINT,
  )
  const [desktopSidebarWidth, setDesktopSidebarWidth] = useState(() => readDesktopSidebarWidth())
  const [isDesktopSidebarResizing, setIsDesktopSidebarResizing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<SessionInputAttachment[]>([])
  const [previewImage, setPreviewImage] = useState<{
    src: string
    label: string
    meta: string
  } | null>(null)
  const [composerError, setComposerError] = useState<string | null>(null)
  const [activeCommandPanel, setActiveCommandPanel] = useState<CodexCommandPanel | null>(
    null,
  )
  const [selectedModel, setSelectedModel] = useState(() => readStoredSessionModel())
  const [selectedReasoning, setSelectedReasoning] = useState(() => readStoredSessionReasoning())
  const [isFastModeEnabled, setIsFastModeEnabled] = useState(() => readStoredSessionFastMode(sessionId))
  const [isPlanModeEnabled, setIsPlanModeEnabled] = useState(() => readStoredSessionPlanMode(sessionId))
  const [isYoloModeEnabled, setIsYoloModeEnabled] = useState(() => readStoredSessionYoloMode(sessionId))
  const managedModelOptions = useSessionModelOptions()
  const modelOptions = useMemo(
    () => managedModelOptions.map(({ id: _id, ...option }) => option),
    [managedModelOptions],
  )
  const [proposedPlanReplyDrafts, setProposedPlanReplyDrafts] = useState<Record<string, string>>({})
  const [pendingProposedPlanReplyEntryId, setPendingProposedPlanReplyEntryId] = useState<string | null>(null)
  const [isSessionActionsOpen, setIsSessionActionsOpen] = useState(false)
  const [isRenameSessionOpen, setIsRenameSessionOpen] = useState(false)
  const [renameSessionDraft, setRenameSessionDraft] = useState('')
  const [isTurnBusy, setIsTurnBusy] = useState(false)
  const [isInterruptRequested, setIsInterruptRequested] = useState(false)
  const [pendingInteractionRequestId, setPendingInteractionRequestId] = useState<string | null>(null)
  const [sidebarDragShift, setSidebarDragShift] = useState<number | null>(null)
  const [isContextUsageOpen, setIsContextUsageOpen] = useState(false)
  const [isBackgroundAgentsOpen, setIsBackgroundAgentsOpen] = useState(false)
  const [activeSurface, setActiveSurface] = useState<WorkspaceSurface>('code')
  const [isTerminalFullscreen, setIsTerminalFullscreen] = useState(false)
  const [gitWorkspaceActionError, setGitWorkspaceActionError] = useState<string | null>(null)
  const [rollbackTurnError, setRollbackTurnError] = useState<RollbackTurnError | null>(null)
  const [rolledBackTurnIds, setRolledBackTurnIds] = useState<Record<string, true>>({})
  const [runWorkbenchError, setRunWorkbenchError] = useState<string | null>(null)
  const [isRunPanelOpen, setIsRunPanelOpen] = useState(false)
  const [isWebsitePanelOpen, setIsWebsitePanelOpen] = useState(false)
  const [isStartingAllRunCommands, setIsStartingAllRunCommands] = useState(false)
  const [isStoppingAllRunCommands, setIsStoppingAllRunCommands] = useState(false)
  const [generatedRunCommandReason, setGeneratedRunCommandReason] = useState<string | null>(null)
  const [generatedRunWebsiteReason, setGeneratedRunWebsiteReason] = useState<string | null>(null)
  const [terminalOutputs, setTerminalOutputs] = useState<Record<string, SessionTerminalOutputState>>({})
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    state: 'connected',
    attempt: 0,
    maxAttempts: 5,
  })
  const [initialBootstrapState, setInitialBootstrapState] = useState<{
    sessionId: string | null
    pending: boolean
    error: string | null
  }>({
    sessionId: sessionId ?? null,
    pending: Boolean(sessionId),
    error: null,
  })
  const [sessionRecoveryStatus, setSessionRecoveryStatus] = useState<SessionRecoveryStatus>({
    state: 'idle',
  })
  const terminalOutputsRef = useRef<Record<string, SessionTerminalOutputState>>({})
  const workspaceDirectoryRef = useRef(workspaceDirectory)
  const sessionDetailHydrationRequestedRef = useRef<string | null>(null)

  useEffect(() => {
    writeStoredSessionModel(selectedModel)
  }, [selectedModel])

  useEffect(() => {
    writeStoredSessionReasoning(selectedReasoning)
  }, [selectedReasoning])

  useEffect(() => {
    if (modelOptions.length === 0) {
      return
    }

    if (modelOptions.some((option) => option.value === selectedModel)) {
      return
    }

    setSelectedModel(modelOptions[0].value)
  }, [modelOptions, selectedModel])

  useEffect(() => {
    setIsFastModeEnabled(readStoredSessionFastMode(sessionId))
    setIsPlanModeEnabled(readStoredSessionPlanMode(sessionId))
    setIsYoloModeEnabled(readStoredSessionYoloMode(sessionId))
    setActiveCommandPanel(null)
    setActiveSurface('code')
    setIsTerminalFullscreen(false)
    setGitWorkspaceActionError(null)
    setRollbackTurnError(null)
    setRolledBackTurnIds({})
    setRunWorkbenchError(null)
    setIsRunPanelOpen(false)
    setIsWebsitePanelOpen(false)
    setIsStartingAllRunCommands(false)
    setIsStoppingAllRunCommands(false)
    setGeneratedRunCommandReason(null)
    setGeneratedRunWebsiteReason(null)
    setTerminalOutputs({})
    setChangeSetDiffs({})
    setChangeSetDiffErrors({})
    setLoadingChangeSetDiffKeys({})
    setTimelinePullDistance(0)
    setIsTimelinePulling(false)
    setIsLoadingFullTimeline(false)
    setTimelineLoadTriggerSource(null)
    timelinePullStartXRef.current = null
    timelinePullStartYRef.current = null
    timelinePullPointerIdRef.current = null
    timelineHeightBeforeLoadRef.current = null
    timelineShouldRestoreScrollRef.current = false
    shouldAutoScrollOnInitialLoadRef.current = Boolean(sessionId)
  }, [sessionId])

  useEffect(() => {
    terminalOutputsRef.current = terminalOutputs
  }, [terminalOutputs])

  useEffect(() => {
    workspaceDirectoryRef.current = workspaceDirectory
  }, [workspaceDirectory])

  useEffect(() => {
    writeStoredSessionFastMode(sessionId, isFastModeEnabled)
  }, [isFastModeEnabled, sessionId])

  useEffect(() => {
    writeStoredSessionPlanMode(sessionId, isPlanModeEnabled)
  }, [isPlanModeEnabled, sessionId])

  useEffect(() => {
    writeStoredSessionYoloMode(sessionId, isYoloModeEnabled)
  }, [isYoloModeEnabled, sessionId])

  useEffect(() => {
    setProposedPlanReplyDrafts({})
    setPendingProposedPlanReplyEntryId(null)
  }, [sessionId])

  useEffect(() => {
    hasSeenMissingContextUsageCheckRef.current = null
  }, [sessionId])

  useEffect(() => {
    if (!previewImage) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewImage(null)
      }
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [previewImage])
  const [isConnectionDetailOpen, setIsConnectionDetailOpen] = useState(false)
  const busyTimeoutRef = useRef<number | null>(null)
  const composerAlertTimeoutRef = useRef<number | null>(null)
  const pendingOptimisticInputRef = useRef<{
    optimisticEntryId: string
    draft: string
    attachments: SessionInputAttachment[]
  } | null>(null)
  const sessionRecoveryRequestIdRef = useRef(0)
  const hasSeenMissingContextUsageCheckRef = useRef<string | null>(null)
  const lastConnectionEstablishedAtRef = useRef(0)
  const lastTimelineResetAtRef = useRef(0)
  const initialBootstrapFallbackStartedAtRef = useRef(0)
  const activeSessionRecoveryPromiseRef = useRef<{
    sessionId: string
    promise: Promise<SessionBootstrapSnapshot | null>
  } | null>(null)
  const sessionEventStreamRef = useRef<{
    key: string
    agentId: string | null
    target: Awaited<ReturnType<typeof resolveConnectionTarget>>
    stream: {
      setSessionId: (sessionId?: string | null) => void
      close: () => void
    }
  } | null>(null)
  const sessionEventRequestIdRef = useRef(0)
  const sessionEventSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionEventHasConnectedOnceRef = useRef(false)
  const sessionEventIgnoreNextAgentOnlineRef = useRef(false)
  const sessionEventReconnectAwaitingResetRef = useRef(false)
  const sessionEventReconnectAtRef = useRef(0)
  const sessionEventReconnectSessionIdRef = useRef<string | null>(sessionId ?? null)
  const sessionEventScopeRef = useRef<{
    sessionId: string | null
    agentId: string | null
    embedded: boolean
  }>({
    sessionId: sessionId ?? null,
    agentId: null,
    embedded,
  })
  const [changeSetDiffs, setChangeSetDiffs] = useState<Record<string, SessionChangeSetFileDiff | undefined>>({})
  const [changeSetDiffErrors, setChangeSetDiffErrors] = useState<Record<string, string | undefined>>({})
  const [loadingChangeSetDiffKeys, setLoadingChangeSetDiffKeys] = useState<Record<string, boolean | undefined>>({})
  const [timelinePullDistance, setTimelinePullDistance] = useState(0)
  const [isTimelinePulling, setIsTimelinePulling] = useState(false)
  const [isLoadingFullTimeline, setIsLoadingFullTimeline] = useState(false)
  const [timelineLoadTriggerSource, setTimelineLoadTriggerSource] = useState<TimelineLoadTrigger>(null)
  const timelinePullStartXRef = useRef<number | null>(null)
  const timelinePullStartYRef = useRef<number | null>(null)
  const timelinePullPointerIdRef = useRef<number | null>(null)
  const timelineHeightBeforeLoadRef = useRef<number | null>(null)
  const timelineShouldRestoreScrollRef = useRef(false)
  const shouldAutoScrollOnInitialLoadRef = useRef(false)
  const loadedChangeSetSessionsRef = useRef<Set<string>>(new Set())
  const clearChangeSetDiffCache = useCallback((changeSetIds: string[]) => {
    if (changeSetIds.length === 0) {
      return
    }

    const prefixes = changeSetIds.map((changeSetId) => `${changeSetId}:`)
    const shouldRemoveKey = (key: string) => prefixes.some((prefix) => key.startsWith(prefix))

    setChangeSetDiffs((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !shouldRemoveKey(key)),
      ),
    )
    setChangeSetDiffErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !shouldRemoveKey(key)),
      ),
    )
    setLoadingChangeSetDiffKeys((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !shouldRemoveKey(key)),
      ),
    )
  }, [])
  const markSessionChangeSetsLoaded = useCallback((targetSessionId: string) => {
    loadedChangeSetSessionsRef.current.add(targetSessionId)
  }, [])
  const resetSessionChangeSetsLoaded = useCallback((targetSessionId: string) => {
    loadedChangeSetSessionsRef.current.delete(targetSessionId)
  }, [])
  const sidebarDragShiftRef = useRef<number | null>(null)
  const sidebarTouchPendingRef = useRef<{ startX: number; startY: number } | null>(null)
  const dragStateRef = useRef<{
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

  let session =
    mergeWorkspaceSessionSummaryIntoDetail(sessionSummary, sessionDetailQuery.data?.session) ??
    pendingSessionHandoff?.session ??
    null
  const currentAgent = workspaceDirectory?.agent ?? null
  let project =
    workspaceDirectory?.projects.find((item) => item.id === session?.project_id) ??
    pendingSessionHandoff?.project
  const canShowGit = session?.capability.can_show_git ?? false
  const canShowTerminal = session?.capability.can_show_terminal ?? false
  sessionEventScopeRef.current = {
    sessionId: sessionId ?? null,
    agentId:
      session?.agent_id ??
      currentAgent?.id ??
      fallbackSessionAgentId,
    embedded,
  }
  const resolveSessionConnectionTarget = useCallback(
    () => {
      const targetAgentId =
        session?.agent_id ??
        currentAgent?.id ??
        fallbackSessionAgentId

      if (
        targetAgentId &&
        sessionEventStreamRef.current?.agentId === targetAgentId
      ) {
        return Promise.resolve(sessionEventStreamRef.current.target)
      }

      return resolveConnectionTarget({
        sessionId,
        agentId: targetAgentId,
      })
    },
    [currentAgent?.id, fallbackSessionAgentId, session?.agent_id, sessionId],
  )

  const openSessionTarget = useCallback(async (nextSessionId: string) => {
    if (embedded) {
      onSelectSession?.(nextSessionId)
      return
    }

    writeStoredSessionId(nextSessionId)
    queuePendingSessionId(nextSessionId)
    if (currentAgent?.id) {
      writeStoredAgentId(currentAgent.id)
    }
    await navigate({ to: '/', replace: true })
  }, [currentAgent?.id, embedded, navigate, onSelectSession])

  const openNodesTarget = useCallback(async () => {
    if (embedded) {
      onExitToNodes?.()
      return
    }

    await navigate({ to: '/nodes' })
  }, [embedded, navigate, onExitToNodes])

  const isInteractiveTarget = (target: EventTarget | null) =>
    target instanceof Element &&
    Boolean(target.closest('button, textarea, input, a, [role="button"], [role="dialog"]'))

  const shouldIgnoreSidebarDragStart = (target: EventTarget | null) => isInteractiveTarget(target)

  const scrollConversationToBottom = () => {
    const scrollElement = conversationScrollRef.current
    if (!scrollElement) {
      return
    }

    const commitScroll = () => {
      scrollElement.scrollTo({
        top: scrollElement.scrollHeight,
        behavior: 'auto',
      })
    }

    commitScroll()
    window.requestAnimationFrame(() => {
      commitScroll()
      window.requestAnimationFrame(commitScroll)
    })
  }

  const isConversationNearBottom = useCallback(() => {
    const scrollElement = conversationScrollRef.current
    if (!scrollElement) {
      return true
    }

    return (
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD
    )
  }, [])

  const autoScrollConversationIfNeeded = useCallback(
    (options?: { force?: boolean }) => {
      if (options?.force || isConversationNearBottom()) {
        scrollConversationToBottom()
      }
    },
    [isConversationNearBottom],
  )

  const syncJumpToBottomState = () => {
    const scrollElement = conversationScrollRef.current
    if (!scrollElement) {
      setShowJumpToBottom(false)
      return
    }

    const distanceToBottom =
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
    setShowJumpToBottom(distanceToBottom > SCROLL_BOTTOM_THRESHOLD)
  }

  const patchWorkspaceDirectoryQueries = useCallback((
    updater: (
      snapshot: WorkspaceDirectorySnapshot | undefined,
    ) => WorkspaceDirectorySnapshot | undefined,
  ) => {
    queryClient.setQueriesData<WorkspaceDirectorySnapshot | undefined>(
      { queryKey: WORKSPACE_DIRECTORY_QUERY_KEY },
      updater,
    )
  }, [queryClient])

  const patchSessionDetailQuery = useCallback((
    targetSessionId: string,
    sessionPatch: Partial<WorkspaceSessionDetail>,
  ) => {
    queryClient.setQueryData(
      getWorkspaceSessionDetailQueryKey({
        sessionId: targetSessionId,
        scope: {
          sessionId: targetSessionId,
        },
      }),
      (current: WorkspaceSessionDetailResponse | null | undefined) =>
        patchWorkspaceSessionDetailWithSafeLastEventAt(
          current ?? undefined,
          targetSessionId,
          sessionPatch,
        ) ?? current,
    )
  }, [queryClient])

  const projects = workspaceDirectory?.projects ?? []
  const sessions = workspaceDirectory?.sessions ?? []
  const projectStats = workspaceDirectory?.project_stats ?? []
  const parentSession = useMemo(
    () =>
      session?.subagent?.parent_session_id
        ? sessions.find((item) => item.id === session?.subagent?.parent_session_id) ?? null
        : null,
    [session?.subagent?.parent_session_id, sessions],
  )

  const applyTimelineSnapshot = useCallback(
    (snapshot: SessionTimelineSnapshot) => {
      const targetSessionId = snapshot.session_id
      if (!targetSessionId) {
        return
      }

      queryClient.setQueryData<TimelineEntry[] | undefined>(
        getTimelineOptimisticQueryKey(targetSessionId),
        (currentEntries) =>
          reconcileOptimisticTimelineEntries(currentEntries, snapshot.entries),
      )

      queryClient.setQueryData<SessionTimelineSnapshot | undefined>(
        ['timeline', targetSessionId],
        (currentSnapshot) => {
          const nextSnapshot = mergeSessionTimelineSnapshots(currentSnapshot, snapshot)
          if (nextSnapshot.view === 'full_compact') {
            writeStoredSessionTimelineSnapshot(nextSnapshot)
          }
          return nextSnapshot
        },
      )
    },
    [queryClient],
  )

  const applySessionBootstrapSnapshot = useCallback(
    (bootstrap: SessionBootstrapSnapshot) => {
      const targetSessionId = bootstrap.session_id
      if (!targetSessionId) {
        return
      }
      const isActiveSession = sessionEventScopeRef.current.sessionId === targetSessionId

      applyTimelineSnapshot(bootstrap.timeline)
      queryClient.setQueryData(['interactions', targetSessionId], bootstrap.interactions)
      if (isActiveSession) {
        setPendingInteractionRequestId((current) =>
          current && bootstrap.interactions.some((request) => request.id === current)
            ? current
            : null,
        )
      }
      queryClient.setQueryData(['plan', targetSessionId], bootstrap.plan_snapshot)
      if (bootstrap.change_sets.length > 0) {
        clearChangeSetDiffCache(bootstrap.change_sets.map((changeSet) => changeSet.id))
        queryClient.setQueryData(['change-sets', targetSessionId], bootstrap.change_sets)
        markSessionChangeSetsLoaded(targetSessionId)
      } else if (!loadedChangeSetSessionsRef.current.has(targetSessionId)) {
        queryClient.setQueryData(['change-sets', targetSessionId], [])
        resetSessionChangeSetsLoaded(targetSessionId)
      }
      queryClient.setQueryData(['session-run-workbench', targetSessionId], bootstrap.run_workbench)

      const latestTimelineTimestamp = bootstrap.timeline.entries.at(-1)?.timestamp
      const recoverySessionPatch =
        latestTimelineTimestamp &&
        (
          !bootstrap.session_patch.last_event_at ||
          +new Date(latestTimelineTimestamp) >
            +new Date(bootstrap.session_patch.last_event_at)
        )
          ? {
              ...bootstrap.session_patch,
              last_event_at: latestTimelineTimestamp,
            }
          : bootstrap.session_patch

      const detailSessionPatch = toWorkspaceSessionDetailPatch(
        recoverySessionPatch as Record<string, unknown>,
      )
      if (detailSessionPatch) {
        patchSessionDetailQuery(targetSessionId, detailSessionPatch)
      }

      const directorySessionPatch = toWorkspaceSessionDirectoryPatch(
        recoverySessionPatch as Record<string, unknown>,
      )
      if (
        directorySessionPatch &&
        hasWorkspaceSession(workspaceDirectoryRef.current ?? undefined, targetSessionId)
      ) {
        patchWorkspaceDirectoryQueries((currentSnapshot) =>
          patchWorkspaceSessionWithSafeLastEventAt(
            currentSnapshot,
            targetSessionId,
            directorySessionPatch,
          ),
        )
      }

      if (
        isActiveSession &&
        (
          bootstrap.session_patch.run_state === 'running' ||
          bootstrap.session_patch.run_state === 'completed' ||
          bootstrap.session_patch.run_state === 'idle'
        )
      ) {
        setIsTurnBusy(bootstrap.session_patch.run_state === 'running')
        if (bootstrap.session_patch.run_state !== 'running') {
          setIsInterruptRequested(false)
        }
      }

      if (isActiveSession && bootstrap.run_workbench?.terminal_snapshot) {
        setTerminalOutputs((current) => {
          const allowedIds = new Set(
            bootstrap.run_workbench?.terminal_snapshot.terminals.map((terminal) => terminal.id),
          )
          const nextOutputs: Record<string, SessionTerminalOutputState> = {}
          for (const [terminalId, output] of Object.entries(current)) {
            if (allowedIds.has(terminalId)) {
              nextOutputs[terminalId] = output
            }
          }
          return nextOutputs
        })
      }

      if (parentSession?.id) {
        void queryClient.invalidateQueries({
          queryKey: ['timeline', parentSession.id, 'prefix-source'],
          exact: true,
        })
      }
    },
    [
      applyTimelineSnapshot,
      clearChangeSetDiffCache,
      patchSessionDetailQuery,
      markSessionChangeSetsLoaded,
      parentSession?.id,
      queryClient,
      resetSessionChangeSetsLoaded,
    ],
  )

  const fetchSessionBootstrapSnapshot = useCallback(
    async (reason: 'connected' | 'initial') => {
      if (!sessionId) {
        return null
      }

      const activeRecoverySessionId = sessionId

      if (activeSessionRecoveryPromiseRef.current?.sessionId === activeRecoverySessionId) {
        return activeSessionRecoveryPromiseRef.current.promise
      }

      const recoveryPromise = (async () => {
        const requestId = ++sessionRecoveryRequestIdRef.current
        setSessionRecoveryStatus({
          state: 'recovering',
        })

        try {
          const target = await resolveSessionConnectionTarget()
          const bootstrap = await target.client.getSessionBootstrap(sessionId)
          if (sessionRecoveryRequestIdRef.current !== requestId) {
            return null
          }

          applySessionBootstrapSnapshot(bootstrap)
          lastTimelineResetAtRef.current = Date.now()
          setSessionRecoveryStatus({
            state: 'idle',
          })
          return bootstrap
        } catch (error) {
          if (sessionRecoveryRequestIdRef.current !== requestId) {
            return null
          }

          setSessionRecoveryStatus({
            state: 'failed',
            error:
              error instanceof Error
                ? error.message
                : reason === 'initial'
                    ? '会话加载失败。'
                    : '会话同步失败。',
          })
          return null
        } finally {
          if (activeSessionRecoveryPromiseRef.current?.sessionId === activeRecoverySessionId) {
            activeSessionRecoveryPromiseRef.current = null
          }
        }
      })()

      activeSessionRecoveryPromiseRef.current = {
        sessionId: activeRecoverySessionId,
        promise: recoveryPromise,
      }
      return recoveryPromise
    },
    [applySessionBootstrapSnapshot, resolveSessionConnectionTarget, sessionId],
  )

  const requestInitialBootstrapFallback = useCallback(
    (reason: 'initial' | 'connected') => {
      if (!sessionId) {
        return
      }

      if (initialBootstrapFallbackStartedAtRef.current > 0) {
        return
      }

      initialBootstrapFallbackStartedAtRef.current = Date.now()

      void fetchSessionBootstrapSnapshot(reason)
        .then((bootstrap) => {
          setInitialBootstrapState({
            sessionId,
            pending: false,
            error: bootstrap ? null : 'Unable to load session bootstrap.',
          })
        })
        .catch((error) => {
          setInitialBootstrapState({
            sessionId,
            pending: false,
            error: error instanceof Error ? error.message : 'Unable to load session bootstrap.',
          })
        })
    },
    [fetchSessionBootstrapSnapshot, sessionId],
  )

  const loadSessionChangeSets = useCallback(async () => {
    if (!sessionId) {
      return
    }

    if (loadedChangeSetSessionsRef.current.has(sessionId)) {
      return
    }

    const target = await resolveSessionConnectionTarget()
    const nextChangeSets = await target.client.getSessionChangeSets(sessionId)
    clearChangeSetDiffCache(nextChangeSets.map((changeSet) => changeSet.id))
    queryClient.setQueryData(['change-sets', sessionId], nextChangeSets)
    markSessionChangeSetsLoaded(sessionId)
  }, [
    clearChangeSetDiffCache,
    markSessionChangeSetsLoaded,
    queryClient,
    resolveSessionConnectionTarget,
    sessionId,
  ])

  const loadFullTimelineSnapshot = useCallback(async (
    triggerSource: Exclude<TimelineLoadTrigger, null> = 'click',
  ) => {
    if (!sessionId || isLoadingFullTimeline) {
      return
    }

    const scrollElement = conversationScrollRef.current
    if (scrollElement) {
      timelineHeightBeforeLoadRef.current = scrollElement.scrollHeight
      timelineShouldRestoreScrollRef.current = true
    }

    setTimelineLoadTriggerSource(triggerSource)
    setIsLoadingFullTimeline(true)
    const loadingStartedAt = Date.now()
    try {
      const target = await resolveSessionConnectionTarget()
      const snapshot = await target.client.getSessionTimeline(sessionId, {
        view: 'full_compact',
      })
      applyTimelineSnapshot(snapshot)
    } finally {
      if (triggerSource === 'click') {
        const remainingVisibleMs = TIMELINE_CLICK_LOADING_MIN_MS - (Date.now() - loadingStartedAt)
        if (remainingVisibleMs > 0) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, remainingVisibleMs)
          })
        }
      }
      setIsLoadingFullTimeline(false)
      setTimelinePullDistance(0)
      setIsTimelinePulling(false)
      setTimelineLoadTriggerSource(null)
    }
  }, [applyTimelineSnapshot, isLoadingFullTimeline, resolveSessionConnectionTarget, sessionId])

  const loadChangeSetFileDiff = useCallback(async (
    input: {
      changeSetId: string
      path: string
      itemId?: string | null
    },
  ) => {
    if (!sessionId) {
      return
    }

    const diffKey = getChangeSetFileDiffKey(input.changeSetId, input.path, input.itemId)
    if (changeSetDiffs[diffKey] || loadingChangeSetDiffKeys[diffKey]) {
      return
    }

    setLoadingChangeSetDiffKeys((current) => ({
      ...current,
      [diffKey]: true,
    }))
    setChangeSetDiffErrors((current) => ({
      ...current,
      [diffKey]: undefined,
    }))

    try {
      const target = await resolveSessionConnectionTarget()
      const diff = await target.client.getSessionChangeSetFileDiff(sessionId, input)
      setChangeSetDiffs((current) => ({
        ...current,
        [diffKey]: diff,
      }))
    } catch (error) {
      setChangeSetDiffErrors((current) => ({
        ...current,
        [diffKey]:
          error instanceof Error ? error.message : '无法读取这个文件的差异详情。',
      }))
    } finally {
      setLoadingChangeSetDiffKeys((current) => ({
        ...current,
        [diffKey]: false,
      }))
    }
  }, [changeSetDiffs, loadingChangeSetDiffKeys, resolveSessionConnectionTarget, sessionId])

  const timelineQuery = useQuery({
    queryKey: ['timeline', sessionId],
    enabled: false,
    queryFn: async () => EMPTY_TIMELINE_SNAPSHOT,
    initialData:
      sessionId
        ? (
            readStoredSessionTimelineSnapshot(sessionId) ??
            queryClient.getQueryData<SessionTimelineSnapshot | TimelineEntry[]>(['timeline', sessionId])
          )
        : undefined,
    refetchInterval: false,
  })
  const optimisticTimelineQuery = useQuery({
    queryKey: getTimelineOptimisticQueryKey(sessionId),
    enabled: false,
    queryFn: async () => [] as TimelineEntry[],
    initialData: [] as TimelineEntry[],
  })
  useEffect(() => {
    const optimisticEntry = pendingSessionHandoff?.optimisticEntry
    if (!sessionId || pendingSessionHandoff?.sessionId !== sessionId || !optimisticEntry) {
      return
    }

    queryClient.setQueryData<TimelineEntry[] | undefined>(
      getTimelineOptimisticQueryKey(sessionId),
      (currentEntries) => {
        if (currentEntries?.some((entry) => entry.id === optimisticEntry.id)) {
          return currentEntries
        }

        return appendTimelineEntry(currentEntries, optimisticEntry)
      },
    )
  }, [pendingSessionHandoff, queryClient, sessionId])
  useEffect(() => {
    if (pendingSessionHandoff?.sessionId !== sessionId) {
      return
    }

    const hasResolvedServerSession =
      sessionDetailQuery.data?.session.id === sessionId ||
      Boolean(fetchedWorkspaceDirectory?.sessions.some((item) => item.id === sessionId))

    if (!hasResolvedServerSession) {
      return
    }

    clearPendingSessionHandoff(sessionId)
  }, [fetchedWorkspaceDirectory, pendingSessionHandoff?.sessionId, sessionDetailQuery.data?.session.id, sessionId])
  const timelineSeedEntries = getTimelineSnapshotEntries(
    timelineQuery.data as SessionTimelineSnapshot | TimelineEntry[] | undefined,
  )
  const optimisticTimelineSeedEntries = optimisticTimelineQuery.data ?? []
  const hasTimelineSeed =
    timelineSeedEntries.length > 0 ||
    optimisticTimelineSeedEntries.length > 0 ||
    Boolean(pendingSessionHandoff?.optimisticEntry)
  const parentTimelineQuery = useQuery({
    queryKey: ['timeline', parentSession?.id, 'prefix-source'],
    enabled: Boolean(parentSession?.id),
    queryFn: async () => {
      const target = await resolveConnectionTarget({
        sessionId: parentSession!.id,
        projectId: parentSession!.project_id,
        agentId: parentSession!.agent_id,
      })
      const snapshot = await target.client.getSessionTimeline(parentSession!.id, {
        view: 'tail',
      })
      return snapshot.entries
    },
    refetchInterval: false,
  })
  const openBackgroundAgentIds = useMemo(
    () => {
      const timelineEntries = getTimelineSnapshotEntries(
        timelineQuery.data as SessionTimelineSnapshot | TimelineEntry[] | undefined,
      )
      return (
      session?.subagent
        ? new Set<string>()
        : deriveOpenBackgroundAgentIds(timelineEntries)
      )
    },
    [session?.subagent, timelineQuery.data],
  )
  const activeTurnStartedAt = useMemo(
    () =>
      getActiveTurnStartedAt(
        getTimelineSnapshotEntries(
          timelineQuery.data as SessionTimelineSnapshot | TimelineEntry[] | undefined,
        ),
      ),
    [timelineQuery.data],
  )
  const backgroundAgentSessions = useMemo(
    () => {
      if (session?.subagent) {
        return []
      }

      return sessions
        .filter(
          (item) =>
            item.id !== sessionId &&
            item.subagent?.parent_session_id === sessionId &&
            !item.archived,
        )
        .filter((item) => {
          if (item.run_state === 'running') {
            return true
          }

          if (!(session?.run_state === 'running' || isTurnBusy)) {
            return false
          }

          if (openBackgroundAgentIds.has(item.id)) {
            return true
          }

          if (!activeTurnStartedAt) {
            return false
          }

          const startedAtMs = new Date(activeTurnStartedAt).getTime()
          const lastEventAtMs = new Date(item.last_event_at).getTime()
          return (
            Number.isFinite(startedAtMs) &&
            Number.isFinite(lastEventAtMs) &&
            lastEventAtMs >= startedAtMs - SUBAGENT_RECENT_WINDOW_MS
          )
        })
        .sort((a, b) => +new Date(b.last_event_at) - +new Date(a.last_event_at))
    },
    [activeTurnStartedAt, isTurnBusy, openBackgroundAgentIds, session?.run_state, session?.subagent, sessionId, sessions],
  )

  useEffect(() => {
    if (!sessionId) {
      sessionDetailHydrationRequestedRef.current = null
      sessionEventReconnectAwaitingResetRef.current = false
      sessionEventReconnectAtRef.current = 0
      sessionEventReconnectSessionIdRef.current = null
      setInitialBootstrapState({
        sessionId: null,
        pending: false,
        error: null,
      })
      setConnectionStatus({
        state: 'connected',
        attempt: 0,
        maxAttempts: 5,
      })
      return
    }

    const shouldAwaitBootstrapFallback = !hasTimelineSeed
    setInitialBootstrapState({
      sessionId,
      pending: shouldAwaitBootstrapFallback,
      error: null,
    })
    lastTimelineResetAtRef.current = shouldAwaitBootstrapFallback ? 0 : Date.now()
    initialBootstrapFallbackStartedAtRef.current = 0
  }, [hasTimelineSeed, sessionId])

  useEffect(() => {
    if (!sessionId || !initialBootstrapState.pending) {
      return
    }

    if (connectionStatus.state === 'failed') {
      requestInitialBootstrapFallback('initial')
      return
    }

    if (connectionStatus.state !== 'connected') {
      return
    }

    const connectedAt = lastConnectionEstablishedAtRef.current
    if (connectedAt <= 0) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      if (lastTimelineResetAtRef.current >= connectedAt) {
        return
      }

      requestInitialBootstrapFallback('initial')
    }, 1200)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    connectionStatus.state,
    initialBootstrapState.pending,
    requestInitialBootstrapFallback,
    sessionId,
  ])

  useEffect(() => {
    if (
      !sessionId ||
      connectionStatus.state !== 'connected' ||
      initialBootstrapState.pending ||
      hasTimelineSeed ||
      !sessionEventReconnectAwaitingResetRef.current ||
      sessionEventReconnectSessionIdRef.current !== sessionId
    ) {
      return
    }

    const connectedAt = sessionEventReconnectAtRef.current
    if (connectedAt <= 0) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      if (!sessionEventReconnectAwaitingResetRef.current) {
        return
      }

      if (sessionEventReconnectAtRef.current !== connectedAt) {
        return
      }

      if (lastTimelineResetAtRef.current >= connectedAt) {
        sessionEventReconnectAwaitingResetRef.current = false
        sessionEventReconnectAtRef.current = 0
        sessionEventReconnectSessionIdRef.current = null
        return
      }

      sessionEventReconnectAwaitingResetRef.current = false
      sessionEventReconnectAtRef.current = 0
      sessionEventReconnectSessionIdRef.current = null
      void fetchSessionBootstrapSnapshot('connected')
    }, 1200)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    connectionStatus.state,
    fetchSessionBootstrapSnapshot,
    hasTimelineSeed,
    initialBootstrapState.pending,
    sessionId,
  ])

  const changeSetsQuery = useQuery({
    queryKey: ['change-sets', sessionId],
    enabled: false,
    queryFn: async () => {
      if (!sessionId) {
        return [] as ChangeSetSummary[]
      }

      const target = await resolveSessionConnectionTarget()
      return target.client.getSessionChangeSets(sessionId)
    },
    initialData:
      sessionId
        ? queryClient.getQueryData<ChangeSetSummary[]>(['change-sets', sessionId]) ?? []
        : [],
    refetchInterval: false,
  })
  const gitWorkspaceQuery = useQuery({
    queryKey: ['session-git-workspace', sessionId],
    enabled: Boolean(sessionId && canShowGit && activeSurface === 'git'),
    queryFn: async () => {
      const target = await resolveSessionConnectionTarget()
      return target.client.getSessionGitWorkspace(sessionId)
    },
    refetchInterval: false,
  })
  const gitHistoryQuery = useQuery({
    queryKey: ['session-git-history', sessionId],
    enabled: false,
    queryFn: async () => {
      const target = await resolveSessionConnectionTarget()
      return target.client.getSessionGitHistory(sessionId)
    },
    refetchInterval: false,
  })
  const runWorkbenchQuery = useQuery({
    queryKey: ['session-run-workbench', sessionId],
    enabled:
      Boolean(sessionId) &&
      canShowTerminal &&
      (isRunPanelOpen || isWebsitePanelOpen || activeSurface === 'terminal'),
    queryFn: async () => {
      if (!sessionId) {
        return null as SessionRunWorkbench | null
      }
      const target = await resolveSessionConnectionTarget()
      return target.client.getSessionRunWorkbench(sessionId)
    },
    initialData:
      sessionId
        ? queryClient.getQueryData<SessionRunWorkbench | null>(['session-run-workbench', sessionId]) ?? null
        : null,
    refetchInterval: false,
  })
  const syncRunWorkbenchCache = useCallback(async (
    patch: (current: SessionRunWorkbench) => SessionRunWorkbench,
  ) => {
    if (!sessionId) {
      return
    }

    const queryKey = ['session-run-workbench', sessionId] as const
    const currentWorkbench =
      queryClient.getQueryData<SessionRunWorkbench | null>(queryKey)

    if (currentWorkbench) {
      queryClient.setQueryData<SessionRunWorkbench>(queryKey, patch(currentWorkbench))
      return
    }

    const target = await resolveSessionConnectionTarget()
    const nextWorkbench = await target.client.getSessionRunWorkbench(sessionId)
    queryClient.setQueryData<SessionRunWorkbench>(queryKey, patch(nextWorkbench))
  }, [queryClient, resolveSessionConnectionTarget, sessionId])
  const planQuery = useQuery({
    queryKey: ['plan', sessionId],
    enabled: false,
    queryFn: async () => null as SessionPlanSnapshot | null,
    initialData:
      sessionId
        ? queryClient.getQueryData<SessionPlanSnapshot | null>(['plan', sessionId]) ?? null
        : null,
    refetchInterval: false,
  })
  const interactionsQuery = useQuery({
    queryKey: ['interactions', sessionId],
    enabled: false,
    queryFn: async () => [] as SessionInteractionRequest[],
    initialData:
      sessionId
        ? queryClient.getQueryData<SessionInteractionRequest[]>(['interactions', sessionId]) ?? []
        : [],
    refetchInterval: false,
  })
  const loadTerminalOutput = useCallback(async (
    terminalId: string,
    options?: {
      force?: boolean
    },
  ) => {
    if (!sessionId) {
      return
    }

    setTerminalOutputs((current) => ({
      ...current,
      [terminalId]: {
        chunks: current[terminalId]?.chunks ?? [],
        nextCursor: current[terminalId]?.nextCursor ?? 0,
        truncated: current[terminalId]?.truncated ?? false,
        isLoading: true,
        error: null,
      },
    }))

    try {
      const target = await resolveSessionConnectionTarget()
      const currentOutput = terminalOutputsRef.current[terminalId]
      const nextOutput = await target.client.getSessionTerminalOutput({
        sessionId,
        terminalId,
        cursor:
          options?.force || currentOutput?.truncated
            ? undefined
            : currentOutput?.nextCursor,
      })

      setTerminalOutputs((current) => {
        const previous = current[terminalId]
        const nextChunks =
          options?.force || nextOutput.truncated || !previous
            ? nextOutput.chunks
            : mergeTerminalOutputChunks(previous.chunks, nextOutput.chunks)
        return {
          ...current,
          [terminalId]: {
            chunks: nextChunks,
            nextCursor: nextOutput.next_cursor,
            truncated: nextOutput.truncated,
            isLoading: false,
            error: null,
          },
        }
      })
    } catch (error) {
      setTerminalOutputs((current) => ({
        ...current,
        [terminalId]: {
          chunks: current[terminalId]?.chunks ?? [],
          nextCursor: current[terminalId]?.nextCursor ?? 0,
          truncated: current[terminalId]?.truncated ?? false,
          isLoading: false,
          error: error instanceof Error ? error.message : '无法读取终端输出。',
        },
      }))
    }
  }, [sessionId])

  useEffect(() => {
    const activeTerminalId = runWorkbenchQuery.data?.terminal_snapshot.active_terminal_id
    const activeTerminal = runWorkbenchQuery.data?.terminal_snapshot.terminals.find(
      (terminal) => terminal.id === activeTerminalId,
    )

    if (!activeTerminalId || !activeTerminal) {
      return
    }

    const currentOutput = terminalOutputs[activeTerminalId]
    if (
      !currentOutput ||
      currentOutput.truncated ||
      currentOutput.nextCursor < activeTerminal.output_cursor
    ) {
      void loadTerminalOutput(activeTerminalId)
    }
  }, [loadTerminalOutput, runWorkbenchQuery.data, terminalOutputs])
  const isSubagentTimelinePending = Boolean(
    session?.subagent &&
      parentSession?.id &&
      parentTimelineQuery.isPending &&
      !parentTimelineQuery.data,
  )

  const effectiveTimeline = useMemo(
    () => {
      const timelineEntries = getTimelineSnapshotEntries(
        timelineQuery.data as SessionTimelineSnapshot | TimelineEntry[] | undefined,
      )
      if (!session?.subagent) {
        return timelineEntries
      }

      if (parentSession?.id && parentTimelineQuery.isPending && !parentTimelineQuery.data) {
        return []
      }

      return trimSubagentTimelinePrefix(timelineEntries, parentTimelineQuery.data)
    },
    [parentSession?.id, parentTimelineQuery.data, parentTimelineQuery.isPending, session?.subagent, timelineQuery.data],
  )
  const timeline = useMemo(
    () =>
      mergeDisplayedTimelineEntries(
        effectiveTimeline,
        optimisticTimelineQuery.data,
      ),
    [effectiveTimeline, optimisticTimelineQuery.data],
  )

  useEffect(() => {
    if (sessionId) {
      window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    const pendingOptimisticInput = pendingOptimisticInputRef.current
    if (!pendingOptimisticInput) {
      return
    }

    if (
      !(optimisticTimelineQuery.data ?? []).some(
        (entry) => entry.id === pendingOptimisticInput.optimisticEntryId,
      )
    ) {
      pendingOptimisticInputRef.current = null
    }
  }, [optimisticTimelineQuery.data])

  useEffect(() => {
    setIsBackgroundAgentsOpen(false)
  }, [sessionId])

  useEffect(() => {
    setRenameSessionDraft(session?.title ?? '')
    setIsRenameSessionOpen(false)
  }, [session?.title, sessionId])

  useEffect(() => {
    setIsInterruptRequested(false)
  }, [sessionId])

  useEffect(() => {
    return () => {
      if (busyTimeoutRef.current) {
        window.clearTimeout(busyTimeoutRef.current)
      }
      if (composerAlertTimeoutRef.current) {
        window.clearTimeout(composerAlertTimeoutRef.current)
      }
      if (desktopSidebarResizeFrameRef.current) {
        window.cancelAnimationFrame(desktopSidebarResizeFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (composerAlertTimeoutRef.current) {
      window.clearTimeout(composerAlertTimeoutRef.current)
      composerAlertTimeoutRef.current = null
    }

    if (!composerError) {
      return
    }

    composerAlertTimeoutRef.current = window.setTimeout(() => {
      setComposerError(null)
      composerAlertTimeoutRef.current = null
    }, COMPOSER_ALERT_DISMISS_MS)

    return () => {
      if (composerAlertTimeoutRef.current) {
        window.clearTimeout(composerAlertTimeoutRef.current)
        composerAlertTimeoutRef.current = null
      }
    }
  }, [composerError])

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
      // Ignore persistence failures for sidebar width.
    }
  }, [desktopSidebarWidth])

  useEffect(() => {
    desktopSidebarWidthRef.current = desktopSidebarWidth
  }, [desktopSidebarWidth])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const syncDesktopSidebar = () => {
      const nextIsDesktopSidebar = window.innerWidth >= DESKTOP_SIDEBAR_BREAKPOINT
      setIsDesktopSidebar(nextIsDesktopSidebar)
      if (nextIsDesktopSidebar) {
        setSidebarOpen(false)
      }
    }

    syncDesktopSidebar()
    window.addEventListener('resize', syncDesktopSidebar)
    return () => {
      window.removeEventListener('resize', syncDesktopSidebar)
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
        const pageElement = conversationPageRef.current
        if (targetWidth === null || !pageElement) {
          return
        }

        pageElement.style.setProperty('--desktop-sidebar-width', `${targetWidth}px`)
      })
    }

    const stopDesktopResize = () => {
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
    window.addEventListener('pointerup', stopDesktopResize)
    window.addEventListener('pointercancel', stopDesktopResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopDesktopResize)
      window.removeEventListener('pointercancel', stopDesktopResize)
    }
  }, [isDesktopSidebarResizing])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      setIsContextUsageOpen(false)
      setIsConnectionDetailOpen(false)

      if (
        target instanceof Element &&
        (
          target.closest('.conversation-topbar__actions') ||
          target.closest('.conversation-topbar__title-actions') ||
          target.closest('.picker-sheet') ||
          target.closest('.picker-sheet-wrap')
        )
      ) {
        return
      }

      setIsSessionActionsOpen(false)
      setIsRunPanelOpen(false)
      setIsWebsitePanelOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [])

  useEffect(() => {
    const pageElement = conversationPageRef.current
    if (!pageElement || isDesktopSidebar) {
      return
    }

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (
        event.touches.length !== 1 ||
        !touch ||
        shouldIgnoreSidebarDragStart(event.target)
      ) {
        return
      }

      sidebarTouchPendingRef.current = {
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
        const pendingTouch = sidebarTouchPendingRef.current
        if (!pendingTouch) {
          return
        }

        const deltaX = touch.clientX - pendingTouch.startX
        const deltaY = touch.clientY - pendingTouch.startY
        if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) {
          return
        }

        if (Math.abs(deltaX) <= Math.abs(deltaY)) {
          sidebarTouchPendingRef.current = null
          return
        }

        beginSidebarDrag(pendingTouch.startX, pendingTouch.startY)
      }

      const isDraggingSidebar = moveSidebarDrag(touch.clientX, touch.clientY)
      if (isDraggingSidebar) {
        event.preventDefault()
      }
    }

    const handleTouchEnd = (event: TouchEvent) => {
      sidebarTouchPendingRef.current = null
      if (!dragStateRef.current) {
        return
      }

      const touch = event.changedTouches[0]
      if (!touch) {
        dragStateRef.current = null
        updateSidebarDragShift(null)
        return
      }

      endSidebarDrag(touch.clientX, touch.clientY)
    }

    const handleTouchCancel = () => {
      sidebarTouchPendingRef.current = null
      dragStateRef.current = null
      updateSidebarDragShift(null)
    }

    pageElement.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true })
    pageElement.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true })
    pageElement.addEventListener('touchend', handleTouchEnd, { capture: true })
    pageElement.addEventListener('touchcancel', handleTouchCancel, { capture: true })

    return () => {
      pageElement.removeEventListener('touchstart', handleTouchStart, { capture: true })
      pageElement.removeEventListener('touchmove', handleTouchMove, { capture: true })
      pageElement.removeEventListener('touchend', handleTouchEnd, { capture: true })
      pageElement.removeEventListener('touchcancel', handleTouchCancel, { capture: true })
    }
  }, [isDesktopSidebar, sidebarOpen])

  useEffect(() => {
    const scrollElement = conversationScrollRef.current
    if (!scrollElement) {
      return
    }

    if (timelineShouldRestoreScrollRef.current && timelineHeightBeforeLoadRef.current !== null) {
      const previousHeight = timelineHeightBeforeLoadRef.current
      const nextHeight = scrollElement.scrollHeight
      scrollElement.scrollTop += Math.max(0, nextHeight - previousHeight)
      timelineShouldRestoreScrollRef.current = false
      timelineHeightBeforeLoadRef.current = null
      return
    }

    if (!sessionId || !shouldAutoScrollOnInitialLoadRef.current || effectiveTimeline.length === 0) {
      return
    }

    scrollConversationToBottom()
    const timeoutId = window.setTimeout(() => {
      scrollConversationToBottom()
      shouldAutoScrollOnInitialLoadRef.current = false
    }, 120)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [effectiveTimeline.length, sessionId])

  useEffect(() => {
    const scrollElement = conversationScrollRef.current
    if (!scrollElement) {
      return
    }

    const handleScroll = () => {
      syncJumpToBottomState()
    }

    handleScroll()
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll)

    return () => {
      scrollElement.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [effectiveTimeline.length, sessionId])

  useEffect(() => {
    const scrollElement = conversationScrollRef.current
    if (!scrollElement) {
      return
    }

    const timelineSnapshot = timelineQuery.data as SessionTimelineSnapshot | TimelineEntry[] | undefined
    const canPullToLoad =
      (
        getTimelineSnapshotHasEarlierEntries(timelineSnapshot) ||
        getTimelineSnapshotView(timelineSnapshot) !== 'full_compact'
      ) && !isLoadingFullTimeline

    const resetPullState = () => {
      timelinePullStartXRef.current = null
      timelinePullStartYRef.current = null
      setTimelinePullDistance(0)
      setIsTimelinePulling(false)
    }

    const maybeLoadFullHistory = () => {
      const shouldLoad =
        canPullToLoad && timelinePullStartYRef.current !== null && timelinePullDistance >= TIMELINE_PULL_LOAD_THRESHOLD
      resetPullState()
      if (shouldLoad) {
        void loadFullTimelineSnapshot('pull')
      }
    }

    const handleTouchStart = (event: TouchEvent) => {
      if (
        !canPullToLoad ||
        event.touches.length !== 1 ||
        scrollElement.scrollTop > 0 ||
        isInteractiveTarget(event.target)
      ) {
        return
      }

      timelinePullStartXRef.current = event.touches[0]?.clientX ?? null
      timelinePullStartYRef.current = event.touches[0]?.clientY ?? null
    }

    const handleTouchMove = (event: TouchEvent) => {
      if (event.defaultPrevented) {
        return
      }

      const startX = timelinePullStartXRef.current
      const startY = timelinePullStartYRef.current
      if (startX === null || startY === null || event.touches.length !== 1) {
        return
      }

      const touch = event.touches[0]
      const deltaX = (touch?.clientX ?? startX) - startX
      const deltaY = (touch?.clientY ?? startY) - startY

      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        resetPullState()
        return
      }

      if (deltaY <= 0) {
        setTimelinePullDistance(0)
        setIsTimelinePulling(false)
        return
      }

      if (scrollElement.scrollTop > 0) {
        resetPullState()
        return
      }

      if (event.cancelable) {
        event.preventDefault()
      }
      setIsTimelinePulling(true)
      setTimelinePullDistance(Math.min(TIMELINE_PULL_MAX_DISTANCE, deltaY))
    }

    const handleTouchEnd = () => {
      maybeLoadFullHistory()
    }

    const handleTouchCancel = () => {
      resetPullState()
    }

    scrollElement.addEventListener('touchstart', handleTouchStart, { passive: true })
    scrollElement.addEventListener('touchmove', handleTouchMove, { passive: false })
    scrollElement.addEventListener('touchend', handleTouchEnd)
    scrollElement.addEventListener('touchcancel', handleTouchCancel)

    return () => {
      scrollElement.removeEventListener('touchstart', handleTouchStart)
      scrollElement.removeEventListener('touchmove', handleTouchMove)
      scrollElement.removeEventListener('touchend', handleTouchEnd)
      scrollElement.removeEventListener('touchcancel', handleTouchCancel)
    }
  }, [
    isLoadingFullTimeline,
    loadFullTimelineSnapshot,
    timelinePullDistance,
    timelineQuery.data,
  ])

  useEffect(() => {
    if (!sessionId) {
      if (sessionEventSyncTimerRef.current !== null) {
        clearTimeout(sessionEventSyncTimerRef.current)
        sessionEventSyncTimerRef.current = null
      }
      sessionEventStreamRef.current?.stream.setSessionId(null)
      return
    }

    let cancelled = false
    const requestId = ++sessionEventRequestIdRef.current
    const scopedAgentId = sessionEventScopeRef.current.agentId

    const clearSyncTimer = () => {
      if (sessionEventSyncTimerRef.current !== null) {
        clearTimeout(sessionEventSyncTimerRef.current)
        sessionEventSyncTimerRef.current = null
      }
    }

    const scheduleWorkspaceDirectorySync = () => {
      if (embedded) {
        return
      }

      clearSyncTimer()
      sessionEventSyncTimerRef.current = setTimeout(() => {
        sessionEventSyncTimerRef.current = null
        const currentScope = sessionEventScopeRef.current
        void syncWorkspaceDirectory(queryClient, {
          scope: {
            sessionId: currentScope.sessionId,
            agentId: currentScope.agentId,
          },
          selectedSessionId: currentScope.sessionId,
        })
      }, DIRECTORY_SYNC_DEBOUNCE_MS)
    }

    if (
      scopedAgentId &&
      sessionEventStreamRef.current?.agentId === scopedAgentId
    ) {
      sessionEventStreamRef.current.stream.setSessionId(sessionId)
      return () => {
        cancelled = true
      }
    }

    void resolveSessionConnectionTarget()
      .then((target) => {
        if (cancelled || sessionEventRequestIdRef.current !== requestId) {
          return
        }

        const nextKey = target.client.getConnectionKey()
        if (sessionEventStreamRef.current?.key === nextKey) {
          sessionEventStreamRef.current.stream.setSessionId(sessionId)
          return
        }

        sessionEventStreamRef.current?.stream.close()
        sessionEventHasConnectedOnceRef.current = false
        sessionEventIgnoreNextAgentOnlineRef.current = false

        const stream = target.client.createEventStream((event) => {
        const payloadSessionId =
          typeof event.payload?.sessionId === 'string'
            ? event.payload.sessionId
            : null
        const currentSessionId = sessionEventScopeRef.current.sessionId
        const activeSessionId = payloadSessionId === currentSessionId ? currentSessionId : null
        const payloadProjectId =
          typeof event.payload?.projectId === 'string'
            ? event.payload.projectId
            : null
        if (event.type === 'agent.online') {
          if (sessionEventIgnoreNextAgentOnlineRef.current) {
            sessionEventIgnoreNextAgentOnlineRef.current = false
            return
          }

          resetSessionPaging()
          scheduleWorkspaceDirectorySync()
          return
        }

        if (event.type === 'timeline.reset' && activeSessionId) {
          lastTimelineResetAtRef.current = Date.now()
          sessionEventReconnectAwaitingResetRef.current = false
          sessionEventReconnectAtRef.current = 0
          sessionEventReconnectSessionIdRef.current = null
          setInitialBootstrapState({
            sessionId: activeSessionId,
            pending: false,
            error: null,
          })
          const nextEntries = Array.isArray(event.payload?.entries)
            ? (event.payload.entries as TimelineEntry[])
            : []
          const hasEarlierEntries =
            getTimelineSnapshotHasEarlierEntries(
              queryClient.getQueryData<SessionTimelineSnapshot | TimelineEntry[]>(['timeline', activeSessionId]),
            )
          applyTimelineSnapshot(
            buildTailTimelineSnapshot(activeSessionId, nextEntries, hasEarlierEntries),
          )
          const latestTimestamp = nextEntries[nextEntries.length - 1]?.timestamp
          if (latestTimestamp) {
            patchWorkspaceDirectoryQueries((currentSnapshot) =>
              patchWorkspaceSessionLastEventAtIfNewer(
                currentSnapshot,
                activeSessionId,
                latestTimestamp,
              ),
            )
          }
          window.requestAnimationFrame(syncJumpToBottomState)
          return
        }

        if (event.type === 'interaction.reset' && activeSessionId) {
          const nextRequests = Array.isArray(event.payload?.requests)
            ? (event.payload.requests as SessionInteractionRequest[])
            : []
          queryClient.setQueryData(['interactions', activeSessionId], nextRequests)
          setPendingInteractionRequestId((current) =>
            current && nextRequests.some((request) => request.id === current)
              ? current
              : null,
          )
          return
        }

        if (event.type === 'plan.reset' && activeSessionId) {
          const nextPlanSnapshot =
            event.payload?.planSnapshot && typeof event.payload.planSnapshot === 'object'
              ? (event.payload.planSnapshot as SessionPlanSnapshot)
              : null
          queryClient.setQueryData(['plan', activeSessionId], nextPlanSnapshot)
          return
        }

        if (event.type === 'timeline.delta' && activeSessionId) {
          const nextEntries = Array.isArray(event.payload?.entries)
            ? (event.payload.entries as TimelineEntry[])
            : []
          const hasEarlierEntries =
            getTimelineSnapshotHasEarlierEntries(
              queryClient.getQueryData<SessionTimelineSnapshot | TimelineEntry[]>(['timeline', activeSessionId]),
            )
          applyTimelineSnapshot(
            buildTailTimelineSnapshot(
              activeSessionId,
              mergeTimelineEntries(undefined, nextEntries),
              hasEarlierEntries,
            ),
          )
          const latestTimestamp = nextEntries[nextEntries.length - 1]?.timestamp
          if (latestTimestamp) {
            patchWorkspaceDirectoryQueries((currentSnapshot) =>
              patchWorkspaceSessionLastEventAtIfNewer(
                currentSnapshot,
                activeSessionId,
                latestTimestamp,
              ),
            )
          }
          autoScrollConversationIfNeeded()
          window.requestAnimationFrame(syncJumpToBottomState)
          return
        }

        if (event.type === 'interaction.delta' && activeSessionId) {
          const nextRequests = Array.isArray(event.payload?.requests)
            ? (event.payload.requests as SessionInteractionRequest[])
            : []
          const resolvedRequestIds = Array.isArray(event.payload?.resolvedRequestIds)
            ? event.payload.resolvedRequestIds.filter(
                (value): value is string => typeof value === 'string' && value.trim().length > 0,
              )
            : []

          queryClient.setQueryData<SessionInteractionRequest[] | undefined>(
            ['interactions', activeSessionId],
            (currentRequests) => {
              const byId = new Map((currentRequests ?? []).map((request) => [request.id, request]))
              for (const request of nextRequests) {
                byId.set(request.id, request)
              }
              for (const resolvedRequestId of resolvedRequestIds) {
                byId.delete(resolvedRequestId)
              }
              return [...byId.values()].sort(
                (left, right) =>
                  +new Date(right.updated_at) - +new Date(left.updated_at),
              )
            },
          )
          if (resolvedRequestIds.length > 0) {
            setPendingInteractionRequestId((current) =>
              current && resolvedRequestIds.includes(current) ? null : current,
            )
          }
          return
        }

        if (event.type === 'plan.delta' && activeSessionId) {
          const nextPlanSnapshot =
            event.payload?.planSnapshot && typeof event.payload.planSnapshot === 'object'
              ? (event.payload.planSnapshot as SessionPlanSnapshot)
              : null
          queryClient.setQueryData(['plan', activeSessionId], nextPlanSnapshot)
          return
        }

        if (event.type === 'changeset.reset' && activeSessionId) {
          const nextChangeSets = Array.isArray(event.payload?.changeSets)
            ? (event.payload.changeSets as ChangeSetSummary[])
            : []
          if (nextChangeSets.length > 0) {
            clearChangeSetDiffCache(nextChangeSets.map((changeSet) => changeSet.id))
            queryClient.setQueryData(['change-sets', activeSessionId], nextChangeSets)
            markSessionChangeSetsLoaded(activeSessionId)
          } else if (!loadedChangeSetSessionsRef.current.has(activeSessionId)) {
            queryClient.setQueryData(['change-sets', activeSessionId], [])
            resetSessionChangeSetsLoaded(activeSessionId)
          }
          return
        }

        if (event.type === 'changeset.delta' && activeSessionId) {
          const nextChangeSets = Array.isArray(event.payload?.changeSets)
            ? (event.payload.changeSets as ChangeSetSummary[])
            : []
          clearChangeSetDiffCache(nextChangeSets.map((changeSet) => changeSet.id))
          queryClient.setQueryData<ChangeSetSummary[] | undefined>(
            ['change-sets', activeSessionId],
            (currentChangeSets) => mergeChangeSetSummaries(currentChangeSets, nextChangeSets),
          )
          return
        }

        if (event.type === 'terminal.snapshot' && activeSessionId) {
          const nextSnapshot =
            event.payload?.snapshot && typeof event.payload.snapshot === 'object'
              ? (event.payload.snapshot as SessionTerminalSnapshot)
              : null

          if (!nextSnapshot) {
            return
          }

          queryClient.setQueryData<SessionRunWorkbench | undefined>(
            ['session-run-workbench', activeSessionId],
            (current) =>
              current
                ? {
                    ...current,
                    terminal_snapshot: nextSnapshot,
                  }
                : current,
          )
          setTerminalOutputs((current) => {
            const allowedIds = new Set(nextSnapshot.terminals.map((terminal) => terminal.id))
            const nextOutputs: Record<string, SessionTerminalOutputState> = {}
            for (const [terminalId, output] of Object.entries(current)) {
              if (allowedIds.has(terminalId)) {
                nextOutputs[terminalId] = output
              }
            }
            return nextOutputs
          })
          return
        }

        if (event.type === 'terminal.delta' && activeSessionId) {
          const nextTerminal =
            event.payload?.terminal && typeof event.payload.terminal === 'object'
              ? (event.payload.terminal as SessionTerminal)
              : null
          const nextChunks = Array.isArray(event.payload?.chunks)
            ? (event.payload.chunks as SessionTerminalOutputChunk[])
            : []
          const nextActiveTerminalId =
            typeof event.payload?.activeTerminalId === 'string'
              ? event.payload.activeTerminalId
              : null

          if (!nextTerminal) {
            return
          }

          queryClient.setQueryData<SessionRunWorkbench | undefined>(
            ['session-run-workbench', activeSessionId],
            (current) => {
              if (!current) {
                return current
              }

              const existingTerminals = current.terminal_snapshot.terminals.filter(
                (terminal) => terminal.id !== nextTerminal.id,
              )
              const referenceIndex = current.terminal_snapshot.terminals.findIndex(
                (terminal) => terminal.id === nextTerminal.id,
              )
              const nextTerminals = [...existingTerminals]
              if (referenceIndex <= 0) {
                nextTerminals.unshift(nextTerminal)
              } else {
                nextTerminals.splice(referenceIndex, 0, nextTerminal)
              }

              return {
                ...current,
                terminal_snapshot: {
                  ...current.terminal_snapshot,
                  active_terminal_id: nextActiveTerminalId,
                  updated_at: nextTerminal.updated_at,
                  terminals: nextTerminals,
                },
              }
            },
          )

          setTerminalOutputs((current) => {
            if (nextChunks.length === 0) {
              return current
            }

            const previous = current[nextTerminal.id]
            return {
              ...current,
              [nextTerminal.id]: {
                chunks: mergeTerminalOutputChunks(previous?.chunks ?? [], nextChunks),
                nextCursor:
                  typeof event.payload?.nextCursor === 'number'
                    ? event.payload.nextCursor
                    : nextTerminal.output_cursor,
                truncated: previous?.truncated ?? false,
                isLoading: false,
                error: null,
              },
            }
          })
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
            patchWorkspaceDirectoryQueries((currentSnapshot) =>
              patchWorkspaceProjectIfMatched(currentSnapshot, payloadProjectId, projectPatch),
            )
            return
          }

          if (action === 'reorder' && orderedProjectIds.length > 0) {
            patchWorkspaceDirectoryQueries((currentSnapshot) =>
              reorderWorkspaceProjects(currentSnapshot, orderedProjectIds),
            )
            return
          }

          if (action === 'remove' || action === 'archive') {
            resetSessionPaging()
            patchWorkspaceDirectoryQueries((currentSnapshot) =>
              removeWorkspaceProject(currentSnapshot, payloadProjectId),
            )
            return
          }

          if (action === 'unarchive') {
            resetSessionPaging()
            scheduleWorkspaceDirectorySync()
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
          const detailSessionPatch =
            event.payload?.sessionPatch &&
            typeof event.payload.sessionPatch === 'object'
              ? toWorkspaceSessionDetailPatch(
                  event.payload.sessionPatch as Record<string, unknown>,
                )
              : null

          if (detailSessionPatch) {
            patchSessionDetailQuery(payloadSessionId, detailSessionPatch)
          }

          const hasCachedWorkspaceSession = hasWorkspaceSession(
            workspaceDirectoryRef.current ?? undefined,
            payloadSessionId,
          )
          if (
            sessionPatch &&
            hasCachedWorkspaceSession
          ) {
            patchWorkspaceDirectoryQueries((currentSnapshot) =>
              patchWorkspaceSessionWithSafeLastEventAt(
                currentSnapshot,
                payloadSessionId,
                sessionPatch,
              ),
            )
          } else if (
            sessionEventScopeRef.current.embedded &&
            payloadSessionId === currentSessionId &&
            !workspaceDirectoryRef.current
          ) {
            return
          } else if (hasCachedWorkspaceSession) {
            return
          } else {
            scheduleWorkspaceDirectorySync()
          }

          if (
            activeSessionId &&
            (sessionPatch?.run_state === 'running' ||
              sessionPatch?.run_state === 'completed' ||
              sessionPatch?.run_state === 'idle')
          ) {
            setIsTurnBusy(sessionPatch.run_state === 'running')
            if (sessionPatch.run_state !== 'running') {
              setIsInterruptRequested(false)
            }
          }

          return
        }

        if (event.type === 'turn.completed' && activeSessionId) {
          setIsTurnBusy(false)
          setIsInterruptRequested(false)
          queryClient.setQueryData(['plan', activeSessionId], null)
        }
        }, {
          sessionId,
          reconnectWhenHidden: true,
          onStatus: (status) => {
            setConnectionStatus(status)
            if (status.state === 'connected') {
              const connectedAt = Date.now()
              const didReconnect = sessionEventHasConnectedOnceRef.current
              lastConnectionEstablishedAtRef.current = connectedAt
              sessionEventReconnectAwaitingResetRef.current = didReconnect
              sessionEventReconnectAtRef.current = didReconnect ? connectedAt : 0
              sessionEventReconnectSessionIdRef.current = didReconnect ? sessionId : null
              sessionEventIgnoreNextAgentOnlineRef.current = true
              if (didReconnect) {
                resetSessionPaging()
                scheduleWorkspaceDirectorySync()
              }

              sessionEventHasConnectedOnceRef.current = true
              setIsConnectionDetailOpen(false)
              return
            }

            sessionRecoveryRequestIdRef.current += 1
            setSessionRecoveryStatus({
              state: 'idle',
            })
          },
        })
        sessionEventStreamRef.current = {
          key: nextKey,
          agentId: scopedAgentId,
          target,
          stream,
        }
        stream.setSessionId(sessionId)
      })
      .catch((error) => {
        if (cancelled || sessionEventRequestIdRef.current !== requestId) {
          return
        }

        setConnectionStatus({
          state: 'failed',
          attempt: 0,
          maxAttempts: 5,
          error: error instanceof Error ? error.message : 'Unable to connect to live session.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [
    embedded,
    resolveSessionConnectionTarget,
    sessionId,
  ])

  useEffect(() => () => {
    sessionEventRequestIdRef.current += 1
    if (sessionEventSyncTimerRef.current !== null) {
      clearTimeout(sessionEventSyncTimerRef.current)
      sessionEventSyncTimerRef.current = null
    }
    sessionEventStreamRef.current?.stream.close()
    sessionEventStreamRef.current = null
  }, [])

  useEffect(() => {
    if (!sessionId || session?.run_state !== 'running' || session.context_usage) {
      return
    }

    if (hasSeenMissingContextUsageCheckRef.current !== sessionId) {
      hasSeenMissingContextUsageCheckRef.current = sessionId
      return
    }

    let cancelled = false
    const timeoutId = window.setTimeout(() => {
      if (cancelled) {
        return
      }

      void sessionDetailQuery.refetch()
    }, 1200)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [
    sessionId,
    session?.context_usage,
    session?.run_state,
    sessionDetailQuery.refetch,
  ])

  useEffect(() => {
    if (
      !sessionId ||
      !sessionHasLocalSeed ||
      !session ||
      !project ||
      sessionDetailQuery.data?.session.id === sessionId ||
      sessionDetailQuery.isFetching ||
      sessionDetailHydrationRequestedRef.current === sessionId ||
      typeof window === 'undefined'
    ) {
      return
    }

    sessionDetailHydrationRequestedRef.current = sessionId
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
      cancelIdleCallback?: (handle: number) => void
    }
    const requestHydration = () => {
      void sessionDetailQuery.refetch()
    }
    const idleHandle = idleWindow.requestIdleCallback?.(requestHydration, {
      timeout: 1500,
    })
    const timeoutHandle =
      idleHandle === undefined
        ? window.setTimeout(requestHydration, 320)
        : null

    return () => {
      if (idleHandle !== undefined) {
        idleWindow.cancelIdleCallback?.(idleHandle)
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle)
      }
    }
  }, [
    project,
    session,
    sessionDetailQuery.data?.session.id,
    sessionDetailQuery.isFetching,
    sessionDetailQuery.refetch,
    sessionHasLocalSeed,
    sessionId,
  ])

  useEffect(() => {
    setIsSessionActionsOpen(false)
  }, [isDesktopSidebar, sessionId])

  const applyCommandPanelResult = useCallback((panel: CodexCommandPanel) => {
    setActiveCommandPanel(panel)
    if (panel.effect?.type === 'set_session_model') {
      setSelectedModel(panel.effect.model)
      if (panel.effect.reasoning_effort) {
        setSelectedReasoning(
          panel.effect.reasoning_effort as (typeof REASONING_OPTIONS)[number]['value'],
        )
      }
    }
  }, [])

  const sendMutation = useMutation({
    mutationFn: async (payload: {
      sessionId: string
      input: string
      attachments: SessionInputAttachment[]
      model: string
      reasoningEffort: string
      serviceTier?: 'fast'
      planMode: boolean
      yoloMode: boolean
      clearComposer?: boolean
      proposedPlanEntryId?: string | null
    }) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.sendSessionInput(payload)
    },
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ['timeline', payload.sessionId] })
      setComposerError(null)
      setIsInterruptRequested(false)
      setIsTurnBusy(true)
      setPendingProposedPlanReplyEntryId(payload.proposedPlanEntryId ?? null)
      const shouldClearComposer = payload.clearComposer !== false
      if (shouldClearComposer) {
        setDraft('')
        setPendingAttachments([])
      }
      if (busyTimeoutRef.current) {
        window.clearTimeout(busyTimeoutRef.current)
      }

      const now = new Date().toISOString()
      const optimisticEntryId = `${OPTIMISTIC_USER_ENTRY_PREFIX}${payload.sessionId}:${Date.now()}`
      pendingOptimisticInputRef.current = shouldClearComposer
        ? {
            optimisticEntryId,
            draft: payload.input,
            attachments: payload.attachments,
          }
        : null

      queryClient.setQueryData<TimelineEntry[] | undefined>(
        getTimelineOptimisticQueryKey(payload.sessionId),
        (currentEntries) =>
          appendTimelineEntry(currentEntries, {
            id: optimisticEntryId,
            kind: 'user',
            title: '你',
            body: payload.input,
            body_truncated: false,
            detail_available: false,
            patch_summary: null,
            session_ids: [],
            timestamp: now,
            accent: 'primary',
            attachments: toTimelineAttachments(payload.attachments),
          }),
      )
      patchWorkspaceDirectoryQueries((currentSnapshot) =>
        patchWorkspaceSessionWithSafeLastEventAt(currentSnapshot, payload.sessionId, {
          run_state: 'running',
          run_state_changed_at: now,
          last_event_at: now,
        }),
      )
    },
    onSuccess: async (_data, variables) => {
      setPendingProposedPlanReplyEntryId(null)
      if (variables.proposedPlanEntryId) {
        setProposedPlanReplyDrafts((current) => {
          const nextDrafts = { ...current }
          delete nextDrafts[variables.proposedPlanEntryId!]
          return nextDrafts
        })
      }
      await queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: ['plan', variables.sessionId] })
      await queryClient.invalidateQueries({ queryKey: ['change-sets', variables.sessionId] })
      busyTimeoutRef.current = null
    },
    onError: (error, variables) => {
      setPendingProposedPlanReplyEntryId(null)
      setIsTurnBusy(false)
      const pendingOptimisticInput = pendingOptimisticInputRef.current
      if (pendingOptimisticInput) {
        queryClient.setQueryData<TimelineEntry[] | undefined>(
          getTimelineOptimisticQueryKey(variables.sessionId),
          (currentEntries) =>
            removeOptimisticTimelineEntry(
              currentEntries,
              pendingOptimisticInput.optimisticEntryId,
            ),
        )
        setDraft((currentDraft) => currentDraft || pendingOptimisticInput.draft)
        setPendingAttachments((currentAttachments) =>
          currentAttachments.length > 0
            ? currentAttachments
            : pendingOptimisticInput.attachments,
        )
        pendingOptimisticInputRef.current = null
      }
      setComposerError(error instanceof Error ? error.message : '无法发送消息')
    },
  })

  const commandExecuteMutation = useMutation({
    mutationFn: async (payload: {
      sessionId: string
      input: string
    }) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.executeSessionCommand(payload)
    },
    onMutate: (payload) => {
      setComposerError(null)
      setDraft('')
      setPendingAttachments([])
      const commandName = payload.input.slice(1).trim().split(/\s+/)[0] ?? ''
      const now = new Date().toISOString()
      setActiveCommandPanel({
        panel_id: `command-panel-pending-${Date.now()}`,
        session_id: payload.sessionId,
        command_name: commandName,
        command_text: payload.input,
        title: `正在执行 /${commandName}`,
        description: null,
        status: 'running',
        body: '命令执行中…',
        submitted_at: now,
        updated_at: now,
        input_type: 'none',
        options: [],
        input_placeholder: null,
        submit_label: null,
        effect: null,
      })
    },
    onSuccess: async (data) => {
      applyCommandPanelResult(data.panel)
      await queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY })
    },
    onError: (error, variables) => {
      setActiveCommandPanel(null)
      setDraft((current) => current || variables.input)
      setComposerError(error instanceof Error ? error.message : '无法执行命令')
    },
  })

  const commandRespondMutation = useMutation({
    mutationFn: async (payload: {
      sessionId: string
      panelId: string
      optionId?: string | null
      text?: string | null
    }) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.respondToSessionCommand(payload)
    },
    onMutate: () => {
      setComposerError(null)
    },
    onSuccess: async (data) => {
      applyCommandPanelResult(data.panel)
      await queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY })
    },
    onError: (error) => {
      setComposerError(error instanceof Error ? error.message : '无法继续执行命令')
    },
  })

  const interactionResponseMutation = useMutation({
    mutationFn: async (payload: {
      sessionId: string
      requestId: string
      optionId?: string | null
      text?: string | null
      answers?: Record<string, string>
    }) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.respondToSessionInteraction(payload)
    },
    onMutate: async (payload) => {
      setComposerError(null)
      setPendingInteractionRequestId(payload.requestId)
      queryClient.setQueryData<SessionInteractionRequest[] | undefined>(
        ['interactions', payload.sessionId],
        (currentRequests) =>
          (currentRequests ?? []).map((request) =>
            request.id === payload.requestId
              ? {
                  ...request,
                  status: 'submitting',
                  updated_at: new Date().toISOString(),
                }
              : request,
          ),
      )
    },
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['interactions', variables.sessionId] })
    },
    onError: (error, variables) => {
      queryClient.setQueryData<SessionInteractionRequest[] | undefined>(
        ['interactions', variables.sessionId],
        (currentRequests) =>
          (currentRequests ?? []).map((request) =>
            request.id === variables.requestId
              ? {
                  ...request,
                  status: 'pending',
                }
              : request,
          ),
      )
      setPendingInteractionRequestId(null)
      setComposerError(error instanceof Error ? error.message : '无法提交确认回复')
    },
  })

  const interruptMutation = useMutation({
    mutationFn: async (targetSessionId: string) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.interruptSession(targetSessionId)
    },
    onMutate: async (targetSessionId) => {
      setComposerError(null)
      setIsInterruptRequested(true)
      setIsTurnBusy(false)
      if (busyTimeoutRef.current) {
        window.clearTimeout(busyTimeoutRef.current)
        busyTimeoutRef.current = null
      }

      const interruptedAt = new Date().toISOString()
      patchWorkspaceDirectoryQueries((currentSnapshot) =>
        patchWorkspaceSessionWithSafeLastEventAt(currentSnapshot, targetSessionId, {
            run_state: 'completed',
            run_state_changed_at: interruptedAt,
            last_event_at: interruptedAt,
          }),
      )
      queryClient.setQueryData(['plan', targetSessionId], null)
    },
    onSuccess: (_data, targetSessionId) => {
      setIsInterruptRequested(false)
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['timeline', targetSessionId] })
      void queryClient.invalidateQueries({ queryKey: ['change-sets', targetSessionId] })
    },
    onError: (error, targetSessionId) => {
      setIsInterruptRequested(false)
      setIsTurnBusy(true)
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['plan', targetSessionId] })
      setComposerError(error instanceof Error ? error.message : '无法中断会话')
    },
  })

  useEffect(() => {
    if (!sessionId || !session) {
      return
    }

    if (isInterruptRequested || interruptMutation.isPending) {
      return
    }

    setIsTurnBusy(session.run_state === 'running')
  }, [
    interruptMutation.isPending,
    isInterruptRequested,
    session,
    session?.run_state,
    sessionId,
  ])

  const sessionActionMutation = useMutation({
    mutationFn: async (payload: { sessionId: string; action: 'pin' | 'unpin' | 'archive' | 'delete' | 'rename'; name?: string }) => {
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
        affectedSessionIds?: string[]
      }>
    },
  })
  const gitWorkspaceActionMutation = useMutation({
    mutationFn: async (payload: {
      action: 'discard-file' | 'discard-all' | 'commit-all' | 'switch-branch' | 'push'
      path?: string
      branch?: string
      message?: string
    }) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.executeSessionGitAction({
        sessionId,
        action: payload.action,
        path: payload.path,
        branch: payload.branch,
        message: payload.message,
      })
    },
    onMutate: async () => {
      setGitWorkspaceActionError(null)
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(['session-git-workspace', sessionId], result.workspace)
      if (variables.action === 'commit-all' || variables.action === 'switch-branch') {
        void queryClient.invalidateQueries({ queryKey: ['session-git-history', sessionId] })
      }
    },
    onError: (error) => {
      setGitWorkspaceActionError(error instanceof Error ? error.message : '无法执行 git 操作')
    },
  })
  const rollbackTurnMutation = useMutation({
    mutationFn: async (payload: {
      turnId: string
    }) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.executeSessionTurnAction({
        sessionId,
        turnId: payload.turnId,
        action: 'rollback',
      })
    },
    onMutate: () => {
      setRollbackTurnError(null)
    },
    onSuccess: (result) => {
      setRollbackTurnError(null)
      setRolledBackTurnIds((current) => ({
        ...current,
        [result.turn_id]: true,
      }))
      queryClient.setQueryData(['session-git-workspace', sessionId], result.workspace)
    },
    onError: (error, variables) => {
      setRollbackTurnError({
        turnId: variables.turnId,
        message: error instanceof Error ? error.message : '无法回滚这轮改动',
      })
    },
  })
  const saveRunCommandMutation = useMutation({
    mutationFn: async (payload: {
      action: 'create' | 'update' | 'delete'
      commandId?: string
      command?: SessionRunCommandDraft
    }) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.saveSessionRunCommand({
        sessionId,
        action: payload.action,
        commandId: payload.commandId,
        command: payload.command,
      })
    },
    onMutate: () => {
      setRunWorkbenchError(null)
    },
    onSuccess: async ({ catalog }) => {
      await syncRunWorkbenchCache((current) => ({
        ...current,
        command_catalog: catalog,
      }))
    },
    onError: (error) => {
      setRunWorkbenchError(error instanceof Error ? error.message : '无法保存项目命令。')
    },
  })
  const saveRunWebsiteMutation = useMutation({
    mutationFn: async (payload: {
      action: 'create' | 'update' | 'delete'
      websiteId?: string
      website?: SessionRunWebsiteDraft
    }) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.saveSessionRunWebsite({
        sessionId,
        action: payload.action,
        websiteId: payload.websiteId,
        website: payload.website,
      })
    },
    onMutate: () => {
      setRunWorkbenchError(null)
    },
    onSuccess: async ({ catalog }) => {
      await syncRunWorkbenchCache((current) => ({
        ...current,
        website_catalog: catalog,
      }))
    },
    onError: (error) => {
      setRunWorkbenchError(error instanceof Error ? error.message : '无法保存项目网页。')
    },
  })
  const generateRunCommandMutation = useMutation({
    mutationFn: async () => {
      const target = await resolveSessionConnectionTarget()
      return target.client.generateSessionRunCommand({
        sessionId,
        prompt: '',
        model: readStoredCommandExecutionModel(),
      })
    },
    onMutate: () => {
      setRunWorkbenchError(null)
      setGeneratedRunCommandReason(null)
    },
    onSuccess: async ({ generation, catalog }) => {
      await syncRunWorkbenchCache((current) => ({
        ...current,
        command_catalog: catalog,
      }))
      setGeneratedRunCommandReason(generation.reason)
    },
    onError: (error) => {
      setRunWorkbenchError(error instanceof Error ? error.message : '无法一键生成项目命令。')
    },
  })
  const generateRunWebsiteMutation = useMutation({
    mutationFn: async () => {
      const target = await resolveSessionConnectionTarget()
      return target.client.generateSessionRunWebsite({
        sessionId,
        prompt: '',
        model: readStoredCommandExecutionModel(),
      })
    },
    onMutate: () => {
      setRunWorkbenchError(null)
      setGeneratedRunWebsiteReason(null)
    },
    onSuccess: async ({ generation, catalog }) => {
      await syncRunWorkbenchCache((current) => ({
        ...current,
        website_catalog: catalog,
      }))
      setGeneratedRunWebsiteReason(generation.reason)
    },
    onError: (error) => {
      setRunWorkbenchError(error instanceof Error ? error.message : '无法一键生成项目网页。')
    },
  })
  const terminalActionMutation = useMutation({
    mutationFn: async (payload: {
      action: 'run-command' | 'run-kill-command' | 'stop' | 'close' | 'focus'
      commandId?: string
      terminalId?: string
    }) => {
      const target = await resolveSessionConnectionTarget()
      return target.client.executeSessionTerminalAction({
        sessionId,
        action: payload.action,
        commandId: payload.commandId,
        terminalId: payload.terminalId,
      })
    },
    onMutate: () => {
      setRunWorkbenchError(null)
    },
    onSuccess: async (result, variables) => {
      queryClient.setQueryData<SessionRunWorkbench | undefined>(
        ['session-run-workbench', sessionId],
        (current) =>
          current
            ? {
                ...current,
                terminal_snapshot: result.snapshot,
              }
            : current,
      )

      if (
        (variables.action === 'run-command' || variables.action === 'run-kill-command')
        && result.terminal
      ) {
        setIsRunPanelOpen(false)
        setActiveSurface('terminal')
        await loadTerminalOutput(result.terminal.id, { force: true })
      }

      if (variables.action === 'focus' && variables.terminalId) {
        await loadTerminalOutput(variables.terminalId)
      }

      if (variables.action === 'close' && variables.terminalId) {
        setTerminalOutputs((current) => {
          const next = { ...current }
          delete next[variables.terminalId!]
          return next
        })
      }
    },
    onError: (error) => {
      setRunWorkbenchError(error instanceof Error ? error.message : '无法执行终端操作。')
    },
  })

  const sessionChangeSets = changeSetsQuery.data ?? []
  const compactCompletedTurns =
    session &&
    getTimelineSnapshotView(
      timelineQuery.data as SessionTimelineSnapshot | TimelineEntry[] | undefined,
    ) !== 'tail'
      ? shouldCompactCompletedTurns(session)
      : false
  const renderedTimeline = useMemo(
    () =>
      buildRenderedTimeline(timeline, {
        projectPath: project?.path,
        compactCompletedTurns,
      }),
    [compactCompletedTurns, project?.path, timeline],
  )
  const renderedBlocks = useMemo(
    () => attachChangeSetsToBlocks(renderedTimeline.blocks, sessionChangeSets),
    [renderedTimeline.blocks, sessionChangeSets],
  )
  const timelineLoadState = useMemo(() => {
    const timelineSnapshot = timelineQuery.data as SessionTimelineSnapshot | TimelineEntry[] | undefined
    const hasEarlierEntries = getTimelineSnapshotHasEarlierEntries(timelineSnapshot)
    const currentView = getTimelineSnapshotView(timelineSnapshot)
    const clampedPullDistance = Math.max(
      0,
      Math.min(TIMELINE_PULL_MAX_DISTANCE, timelinePullDistance),
    )
    const pullProgress = Math.max(
      0,
      Math.min(1, clampedPullDistance / TIMELINE_PULL_LOAD_THRESHOLD),
    )

    return {
      hasEarlierEntries,
      canLoadEarlierEntries: hasEarlierEntries || currentView !== 'full_compact',
      isPulling: isTimelinePulling,
      pullDistance: clampedPullDistance,
      isReadyToLoad: clampedPullDistance >= TIMELINE_PULL_LOAD_THRESHOLD,
      isLoadingFull: isLoadingFullTimeline,
      indicatorOffset: isLoadingFullTimeline
        ? TIMELINE_HISTORY_INDICATOR_TARGET_OFFSET
        : Math.min(
            TIMELINE_HISTORY_INDICATOR_TARGET_OFFSET,
            clampedPullDistance * 0.75,
          ),
      indicatorRotation: isLoadingFullTimeline
        ? TIMELINE_HISTORY_INDICATOR_ROTATION_MAX
        : Math.round(pullProgress * TIMELINE_HISTORY_INDICATOR_ROTATION_MAX),
      triggerSource: timelineLoadTriggerSource,
    }
  }, [
    isLoadingFullTimeline,
    isTimelinePulling,
    timelineLoadTriggerSource,
    timelinePullDistance,
    timelineQuery.data,
  ])
  const activeRunningTurn =
    [...renderedBlocks]
      .reverse()
      .find((block): block is RenderedTurnBlock => block.kind === 'turn' && !block.turn.completion) ??
    null

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
      cancelIdleCallback?: (handle: number) => void
    }
    const idleHandle = idleWindow.requestIdleCallback?.(
      () => {
        void loadSessionDiffPreview()
      },
      { timeout: 1500 },
    )
    const timeoutHandle =
      idleHandle === undefined
        ? window.setTimeout(() => {
            void loadSessionDiffPreview()
          }, 320)
        : null

    return () => {
      if (idleHandle !== undefined) {
        idleWindow.cancelIdleCallback?.(idleHandle)
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle)
      }
    }
  }, [])

  const hasResolvedSessionDetail = Boolean(session && project)
  const isSessionDetailPending =
    Boolean(sessionId) && sessionDetailQuery.isPending && !session
  session ??= EMPTY_SESSION_DETAIL
  project ??= EMPTY_PROJECT_REF
  const isBootstrapStateStaleForSession =
    Boolean(sessionId) && initialBootstrapState.sessionId !== sessionId
  const isInitialSessionBootstrapPending =
    Boolean(sessionId) &&
    !hasResolvedSessionDetail &&
    (
      initialBootstrapState.pending ||
      isBootstrapStateStaleForSession ||
      isSessionDetailPending
    )
  const unresolvedSessionMessage = isInitialSessionBootstrapPending
    ? '正在载入会话…'
    : sessionDetailQuery.error instanceof Error
      ? sessionDetailQuery.error.message
    : initialBootstrapState.error
      ? initialBootstrapState.error
      : '没有找到这个会话。'

  const canSendInput = session.capability.can_send_input && !isInterruptRequested
  const canSubmitInput =
    canSendInput &&
    (workspaceAgentIndicatorState === undefined ||
      workspaceAgentIndicatorState === 'online')
  const visibleInteractionRequests = (interactionsQuery.data ?? []).filter(
    (request) => request.status === 'pending' || request.status === 'submitting',
  )
  const showStopIcon =
    ((session.run_state === 'running' || isTurnBusy) && !isInterruptRequested) ||
    interruptMutation.isPending
  const canRespondToProposedPlan =
    canSendInput &&
    visibleInteractionRequests.length === 0 &&
    !showStopIcon &&
    !sendMutation.isPending
  const menuAgentId = currentAgent?.id ?? session.agent_id

  const handleProposedPlanReplyDraftChange = useCallback((entryId: string, value: string) => {
    setProposedPlanReplyDrafts((current) => {
      if (!value.trim()) {
        if (!(entryId in current)) {
          return current
        }

        const nextDrafts = { ...current }
        delete nextDrafts[entryId]
        return nextDrafts
      }

      return {
        ...current,
        [entryId]: value,
      }
    })
  }, [])

  const handleSubmitProposedPlanReply = useCallback((entryId: string, input: string) => {
    const normalizedInput = input.trim()
    if (!normalizedInput || !canRespondToProposedPlan) {
      return
    }

    sendMutation.mutate({
      sessionId: session.id,
      input: normalizedInput,
      attachments: [],
      model: selectedModel,
      reasoningEffort: selectedReasoning,
      serviceTier: isFastModeEnabled ? 'fast' : undefined,
      planMode: isPlanModeEnabled,
      yoloMode: isYoloModeEnabled,
      clearComposer: false,
      proposedPlanEntryId: entryId,
    })
  }, [
    canRespondToProposedPlan,
    isFastModeEnabled,
    isPlanModeEnabled,
    isYoloModeEnabled,
    selectedModel,
    selectedReasoning,
    sendMutation,
    session.id,
  ])

  const handleRollbackTurn = useCallback((turnId: string) => {
    rollbackTurnMutation.mutate({
      turnId,
    })
  }, [rollbackTurnMutation])
  const pendingRollbackTurnId = rollbackTurnMutation.isPending
    ? rollbackTurnMutation.variables?.turnId ?? null
    : null

  const conversationThreadContent = useMemo(() => (
    <SessionThreadContent
      key={session.id}
      sessionId={session.id}
      sessions={sessions}
      sessionRunState={session.run_state}
      isDesktopSidebar={embedded ? Boolean(isDesktopSidebarProp) : isDesktopSidebar}
      projectPath={project.path}
      renderedBlocks={renderedBlocks}
      lastToolGroupId={renderedTimeline.lastToolGroupId}
      sessionChangeSets={sessionChangeSets}
      isSubagentTimelinePending={isSubagentTimelinePending}
      isInitialTimelinePending={
        Boolean(sessionId) &&
        timeline.length === 0 &&
        (initialBootstrapState.pending || isBootstrapStateStaleForSession)
      }
      hasTimeline={timeline.length > 0}
      proposedPlanReplyDrafts={proposedPlanReplyDrafts}
      pendingProposedPlanReplyEntryId={pendingProposedPlanReplyEntryId}
      canRespondToProposedPlan={canRespondToProposedPlan}
      onProposedPlanReplyDraftChange={handleProposedPlanReplyDraftChange}
      onSubmitProposedPlanReply={handleSubmitProposedPlanReply}
      onPreviewImage={setPreviewImage}
      changeSetDiffs={changeSetDiffs}
      changeSetDiffErrors={changeSetDiffErrors}
      loadingChangeSetDiffKeys={loadingChangeSetDiffKeys}
      onLoadSessionChangeSets={loadSessionChangeSets}
      onLoadChangeSetFileDiff={loadChangeSetFileDiff}
      onLoadFullTimeline={() => {
        void loadFullTimelineSnapshot()
      }}
      timelineLoadState={timelineLoadState}
      canRollbackChangeSets={canShowGit}
      pendingRollbackTurnId={pendingRollbackTurnId}
      rollbackTurnError={rollbackTurnError}
      rolledBackTurnIds={rolledBackTurnIds}
      onRollbackTurn={handleRollbackTurn}
    />
  ), [
    canShowGit,
    canRespondToProposedPlan,
    changeSetDiffErrors,
    changeSetDiffs,
    handleProposedPlanReplyDraftChange,
    handleSubmitProposedPlanReply,
    embedded,
    isDesktopSidebar,
    isDesktopSidebarProp,
    isSubagentTimelinePending,
    loadSessionChangeSets,
    loadChangeSetFileDiff,
    loadFullTimelineSnapshot,
    loadingChangeSetDiffKeys,
    handleRollbackTurn,
    pendingProposedPlanReplyEntryId,
    project.path,
    proposedPlanReplyDrafts,
    renderedBlocks,
    renderedTimeline.lastToolGroupId,
    pendingRollbackTurnId,
    rollbackTurnError,
    rolledBackTurnIds,
    session.id,
    session.run_state,
    sessionChangeSets,
    sessions,
    timeline.length,
    timelineLoadState,
  ])

  const handleSessionAction = useCallback(async (
    targetSessionId: string,
    action: 'pin' | 'unpin' | 'delete' | 'rename',
    name?: string,
  ) => {
    setComposerError(null)
    setIsSessionActionsOpen(false)

    if (action === 'pin' || action === 'unpin') {
      flushSync(() => {
        patchWorkspaceDirectoryQueries((currentSnapshot) =>
          patchWorkspaceSessionIfMatched(currentSnapshot, targetSessionId, {
            pinned: action === 'pin',
          }),
        )
      })
    } else if (action === 'rename' && name?.trim()) {
      patchWorkspaceDirectoryQueries((currentSnapshot) =>
        patchWorkspaceSessionIfMatched(currentSnapshot, targetSessionId, {
          title: name.trim(),
        }),
      )
    }

    try {
      const result = await sessionActionMutation.mutateAsync({
        sessionId: targetSessionId,
        action,
        name,
      })
      const affectedSessionIds = result.affectedSessionIds?.length
        ? result.affectedSessionIds
        : [targetSessionId]

      if (action === 'delete') {
        patchWorkspaceDirectoryQueries((currentSnapshot) =>
          removeWorkspaceSessions(currentSnapshot, affectedSessionIds),
        )
        resetSessionPaging()
        for (const affectedSessionId of affectedSessionIds) {
          queryClient.removeQueries({ queryKey: ['timeline', affectedSessionId], exact: true })
          queryClient.removeQueries({
            queryKey: getTimelineOptimisticQueryKey(affectedSessionId),
            exact: true,
          })
          queryClient.removeQueries({ queryKey: ['change-sets', affectedSessionId], exact: true })
          resetSessionChangeSetsLoaded(affectedSessionId)
        }
      } else {
        patchWorkspaceDirectoryQueries((currentSnapshot) =>
          patchWorkspaceSessions(currentSnapshot, affectedSessionIds, {
            ...(action === 'rename' && name?.trim()
              ? { title: name.trim() }
              : { pinned: action === 'pin' }),
          }),
        )
      }

      if (targetSessionId === session.id && action === 'delete') {
        const nextSessionId = result.nextSessionId
        if (nextSessionId) {
          await openSessionTarget(nextSessionId)
        } else {
          await openNodesTarget()
        }
      }
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY })
      setComposerError(error instanceof Error ? error.message : '无法更新会话')
    }
  }, [
    openNodesTarget,
    openSessionTarget,
    queryClient,
    resetSessionPaging,
    resetSessionChangeSetsLoaded,
    session.id,
    sessionActionMutation,
  ])
  const handleThreadAction = useCallback(async (
    projectId: string,
    action: 'pin' | 'unpin' | 'rename' | 'remove' | 'archive' | 'unarchive' | 'reorder',
    payload?: {
      name?: string
      orderedProjectIds?: string[]
    },
  ) => {
    setComposerError(null)
    setIsSessionActionsOpen(false)
    const nextName = payload?.name?.trim()

    if (action === 'pin' || action === 'unpin') {
      flushSync(() => {
        patchWorkspaceDirectoryQueries((currentSnapshot) =>
          patchWorkspaceProjectIfMatched(currentSnapshot, projectId, {
            pinned: action === 'pin',
          }),
        )
      })
    } else if (action === 'rename' && nextName) {
      patchWorkspaceDirectoryQueries((currentSnapshot) =>
        patchWorkspaceProjectIfMatched(currentSnapshot, projectId, {
          display_name: nextName,
        }),
      )
    } else if (action === 'reorder' && payload?.orderedProjectIds?.length) {
      patchWorkspaceDirectoryQueries((currentSnapshot) =>
        reorderWorkspaceProjects(currentSnapshot, payload.orderedProjectIds ?? []),
      )
    } else if (action === 'remove' || action === 'archive') {
      patchWorkspaceDirectoryQueries((currentSnapshot) =>
        removeWorkspaceProject(currentSnapshot, projectId),
      )
      resetSessionPaging()
    } else if (action === 'unarchive') {
      resetSessionPaging()
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY })
    }

    try {
      const result = await threadActionMutation.mutateAsync({
        projectId,
        agentId: currentAgent?.id ?? session.agent_id,
        action,
        name: payload?.name,
        orderedProjectIds: payload?.orderedProjectIds,
      })

      if (action === 'remove' || action === 'archive' || action === 'unarchive') {
        const nextSessionId = result.nextSessionId
        if (nextSessionId) {
          await openSessionTarget(nextSessionId)
        } else {
          await openNodesTarget()
        }
      }
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY })
      setComposerError(error instanceof Error ? error.message : '无法更新线程')
    }
  }, [
    openNodesTarget,
    openSessionTarget,
    queryClient,
    resetSessionPaging,
    threadActionMutation,
  ])
  const openNewThreadPage = useCallback(async (projectId: string) => {
    if (!menuAgentId) {
      return
    }

    writeStoredAgentId(menuAgentId)
    writeStoredSessionId(null)
    queuePendingSessionId(null)
    queuePendingProjectId(projectId)

    await navigate({ to: '/' })
  }, [menuAgentId, navigate])
  const hasActivePlanStep =
    planQuery.data?.steps.some((step) => step.status === 'pending' || step.status === 'in_progress') ??
    false
  const isSessionLikelyRunning =
    session.run_state === 'running' || isTurnBusy
  const hasFreshPlanSnapshot = Boolean(
    planQuery.data?.updated_at &&
      Date.now() - new Date(planQuery.data.updated_at).getTime() <= LIVE_PLAN_GRACE_MS,
  )
  const visiblePlanSnapshot =
    planQuery.data &&
    (hasActivePlanStep || (isSessionLikelyRunning && hasFreshPlanSnapshot))
      ? planQuery.data
      : null
  const contextUsage = session.context_usage
  const usedPercent = contextUsage ? Math.round(contextUsage.percent_used) : 0
  const remainingPercent = Math.max(0, 100 - usedPercent)
  const contextUsageRingStyle = contextUsage
    ? ({
        '--usage-progress': `${Math.max(0, Math.min(100, contextUsage.percent_used))}%`,
      } as CSSProperties)
    : undefined
  const showThinkingStatus =
    connectionStatus.state === 'connected' &&
    sessionRecoveryStatus.state === 'idle' &&
    isSessionLikelyRunning &&
    !isInterruptRequested &&
    !interruptMutation.isPending &&
    !activeRunningTurn?.turn.completion
  const hasBackgroundAgentStrip = Boolean(parentSession) || backgroundAgentSessions.length > 0

  useEffect(() => {
    if (!sessionId) {
      return
    }
    sessionRecoveryRequestIdRef.current += 1
    setSessionRecoveryStatus({
      state: 'idle',
    })
  }, [sessionId])

  useEffect(() => {
    if (!pendingInteractionRequestId) {
      return
    }

    const stillPending = (interactionsQuery.data ?? []).some(
      (request) =>
        request.id === pendingInteractionRequestId &&
        request.status === 'submitting',
    )
    if (!stillPending) {
      setPendingInteractionRequestId(null)
    }
  }, [interactionsQuery.data, pendingInteractionRequestId])

  useEffect(() => {
    if (
      !sessionId ||
      !hasResolvedSessionDetail ||
      session.run_state === 'running' ||
      sendMutation.isPending ||
      interruptMutation.isPending ||
      activeRunningTurn ||
      planQuery.data?.is_active
    ) {
      return
    }

    if (busyTimeoutRef.current) {
      window.clearTimeout(busyTimeoutRef.current)
      busyTimeoutRef.current = null
    }

    setIsTurnBusy(false)
  }, [
    activeRunningTurn,
    hasResolvedSessionDetail,
    interruptMutation.isPending,
    planQuery.data?.is_active,
    sendMutation.isPending,
    session,
    session?.run_state,
    sessionId,
  ])

  const sidebarShiftMax = isDesktopSidebar ? 0 : getSidebarShiftMax()
  const effectiveSidebarOpen = isDesktopSidebar || sidebarOpen
  const sidebarShift = isDesktopSidebar
    ? 0
    : sidebarDragShift ?? (sidebarOpen ? sidebarShiftMax : 0)
  const renameSessionDialog =
    isRenameSessionOpen && typeof document !== 'undefined'
      ? createPortal(
          <div className="sheet-wrap sheet-wrap--centered" role="dialog" aria-modal="true">
            <button
              type="button"
              className="sheet-wrap__scrim"
              onClick={() => {
                setIsRenameSessionOpen(false)
                setRenameSessionDraft(session.title)
              }}
              aria-label="关闭重命名会话面板"
            />
            <div className="sheet-wrap__center">
              <div className="sheet-panel sheet-panel--form sheet-panel--centered">
                <div className="sheet-panel__title">重命名会话</div>
                <input
                  className="sheet-panel__input"
                  value={renameSessionDraft}
                  onChange={(event) => setRenameSessionDraft(event.target.value)}
                  placeholder="输入会话名称"
                  autoFocus
                />
                <div className="sheet-panel__actions">
                  <button
                    type="button"
                    className="sheet-panel__button"
                    onClick={() => {
                      setIsRenameSessionOpen(false)
                      setRenameSessionDraft(session.title)
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="sheet-panel__button is-primary"
                    disabled={!renameSessionDraft.trim() || (sessionActionMutation.isPending && sessionActionMutation.variables?.sessionId === session.id)}
                    onClick={() => {
                      void handleSessionAction(session.id, 'rename', renameSessionDraft.trim())
                      setIsRenameSessionOpen(false)
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
  const mobileSessionActionsDialog =
    !(embedded ? Boolean(isDesktopSidebarProp) : isDesktopSidebar) &&
    isSessionActionsOpen &&
    typeof document !== 'undefined'
      ? createPortal(
          <div className="picker-sheet-wrap" role="dialog" aria-modal="true">
            <button
              type="button"
              className="picker-sheet__scrim"
              onClick={() => setIsSessionActionsOpen(false)}
              aria-label="关闭会话操作菜单"
            />
            <div className="picker-sheet">
              <div className="picker-sheet__header">
                <strong>{session.title}</strong>
              </div>

              <div className="picker-sheet__list">
                <button
                  type="button"
                  className="picker-sheet__item"
                  disabled={sessionActionMutation.isPending && sessionActionMutation.variables?.sessionId === session.id}
                  onClick={() => void handleSessionAction(session.id, session.pinned ? 'unpin' : 'pin')}
                >
                  <span>{session.pinned ? '取消置顶会话' : '置顶会话'}</span>
                </button>
                <button
                  type="button"
                  className="picker-sheet__item"
                  disabled={sessionActionMutation.isPending && sessionActionMutation.variables?.sessionId === session.id}
                  onClick={() => {
                    setIsSessionActionsOpen(false)
                    setIsRenameSessionOpen(true)
                  }}
                >
                  <span>重命名会话</span>
                </button>
                <button
                  type="button"
                  className="picker-sheet__item is-danger"
                  disabled={sessionActionMutation.isPending && sessionActionMutation.variables?.sessionId === session.id}
                  onClick={() => void handleSessionAction(session.id, 'delete')}
                >
                  <span>删除会话</span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null
  const sidebarProgress = isDesktopSidebar
    ? 1
    : sidebarShiftMax > 0
      ? sidebarShift / sidebarShiftMax
      : 0
  const isSidebarDragging = !isDesktopSidebar && sidebarDragShift !== null
  const conversationPageStyle = isDesktopSidebar
    ? ({
        '--desktop-sidebar-width': `${desktopSidebarWidth}px`,
      } as CSSProperties)
    : undefined
  const layoutIsDesktopSidebar = embedded ? Boolean(isDesktopSidebarProp) : isDesktopSidebar
  const layoutSidebarShift = embedded ? sidebarOffset : sidebarShift
  const layoutIsSidebarDragging = embedded ? isSidebarDraggingProp : isSidebarDragging
  const gitWorkspacePendingAction = gitWorkspaceActionMutation.isPending
    ? gitWorkspaceActionMutation.variables ?? null
    : null
  const gitWorkspaceError =
    gitWorkspaceActionError ??
    (gitWorkspaceQuery.error instanceof Error ? gitWorkspaceQuery.error.message : null)
  const gitHistoryError =
    gitHistoryQuery.error instanceof Error ? gitHistoryQuery.error.message : null
  const resolvedRunWorkbenchError =
    runWorkbenchError ??
    (runWorkbenchQuery.error instanceof Error ? runWorkbenchQuery.error.message : null)
  const runWorkbench = runWorkbenchQuery.data ?? null
  const terminalSnapshot = runWorkbench?.terminal_snapshot ?? null
  const runCommands = runWorkbench?.command_catalog.commands ?? []
  const runWebsites = runWorkbench?.website_catalog.websites ?? []
  const commandExecutionModelLabel = getSessionModelLabelFromOptions(
    readStoredCommandExecutionModel(),
    modelOptions,
  )
  const activeTerminal =
    terminalSnapshot?.terminals.find(
      (terminal) => terminal.id === terminalSnapshot.active_terminal_id,
    ) ??
    terminalSnapshot?.terminals[0] ??
    null
  const isTerminalSurfaceActive = canShowTerminal && activeSurface === 'terminal'
  const isGitSurfaceActive = canShowGit && activeSurface === 'git'
  const isDesktopTerminalFullscreen =
    layoutIsDesktopSidebar && isTerminalSurfaceActive && isTerminalFullscreen
  const showDesktopGitPanel = isGitSurfaceActive && layoutIsDesktopSidebar
  const showDesktopWorkbenchPanel =
    (isTerminalSurfaceActive || isGitSurfaceActive) &&
    layoutIsDesktopSidebar &&
    !isDesktopTerminalFullscreen
  const showMobileWorkbenchSurface =
    (isTerminalSurfaceActive || isGitSurfaceActive) && !layoutIsDesktopSidebar
  const pendingRunCommandId =
    terminalActionMutation.isPending && terminalActionMutation.variables?.action === 'run-command'
      ? terminalActionMutation.variables.commandId ?? null
      : null
  const pendingKillCommandId =
    terminalActionMutation.isPending
    && terminalActionMutation.variables?.action === 'run-kill-command'
      ? terminalActionMutation.variables.commandId ?? null
      : null
  const pendingDeleteCommandId =
    saveRunCommandMutation.isPending && saveRunCommandMutation.variables?.action === 'delete'
      ? saveRunCommandMutation.variables.commandId ?? null
      : null
  const pendingDeleteWebsiteId =
    saveRunWebsiteMutation.isPending && saveRunWebsiteMutation.variables?.action === 'delete'
      ? saveRunWebsiteMutation.variables.websiteId ?? null
      : null

  useEffect(() => {
    if (!layoutIsDesktopSidebar && isTerminalFullscreen) {
      setIsTerminalFullscreen(false)
    }
  }, [isTerminalFullscreen, layoutIsDesktopSidebar])

  const updateSidebarDragShift = (value: number | null) => {
    sidebarDragShiftRef.current = value
    setSidebarDragShift(value)
  }

  const beginSidebarDrag = (startX: number, startY: number, pointerId?: number) => {
    dragStateRef.current = {
      mode: sidebarOpen ? 'close' : 'open',
      startX,
      startY,
      axis: 'pending',
      pointerId,
    }

    return true
  }

  const moveSidebarDrag = (clientX: number, clientY: number) => {
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

    const nextShift =
      state.mode === 'open'
        ? Math.max(0, Math.min(sidebarShiftMax, deltaX))
        : Math.max(0, Math.min(sidebarShiftMax, sidebarShiftMax + deltaX))

    updateSidebarDragShift(nextShift)
    return true
  }

  const endSidebarDrag = (clientX: number, clientY: number) => {
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

    const finalShift =
      state.axis === 'x'
        ? sidebarDragShiftRef.current ?? (state.mode === 'open'
            ? Math.max(0, Math.min(sidebarShiftMax, deltaX))
            : Math.max(0, Math.min(sidebarShiftMax, sidebarShiftMax + deltaX)))
        : sidebarOpen
          ? sidebarShiftMax
          : 0

    const shouldOpen = finalShift >= sidebarShiftMax * SIDEBAR_CLOSE_THRESHOLD
    setSidebarOpen(shouldOpen)
    dragStateRef.current = null
    updateSidebarDragShift(null)
  }
  const handleOpenSidebar = useCallback(() => {
    if (embedded) {
      onOpenSidebar?.()
      return
    }

    setSidebarOpen(true)
  }, [embedded, onOpenSidebar])

  const handleToggleConnectionDetail = useCallback(() => {
    setIsConnectionDetailOpen((current) => !current)
  }, [])

  const handleDismissComposerError = useCallback(() => {
    setComposerError(null)
  }, [])

  const handleToggleBackgroundAgents = useCallback(() => {
    setIsBackgroundAgentsOpen((current) => !current)
  }, [])

  const handleOpenBackgroundSession = useCallback((nextSessionId: string) => {
    void openSessionTarget(nextSessionId)
  }, [openSessionTarget])

  const openLocalModelCommandPanel = useCallback((commandText: string) => {
    const now = new Date().toISOString()
    if (modelOptions.length === 0) {
      setActiveCommandPanel({
        panel_id: `${LOCAL_MODEL_COMMAND_PANEL_PREFIX}${Date.now()}`,
        session_id: session.id,
        command_name: 'model',
        command_text: commandText,
        title: '选择模型',
        description: '选择后会更新当前会话后续发送时使用的模型。',
        status: 'completed',
        body: '当前没有可选模型，请先去设置页维护模型列表。',
        submitted_at: now,
        updated_at: now,
        input_type: 'none',
        options: [],
        input_placeholder: null,
        submit_label: null,
        effect: null,
      })
      return
    }

    setActiveCommandPanel({
      panel_id: `${LOCAL_MODEL_COMMAND_PANEL_PREFIX}${Date.now()}`,
      session_id: session.id,
      command_name: 'model',
      command_text: commandText,
      title: '选择模型',
      description: '选择后会更新当前会话后续发送时使用的模型。',
      status: 'awaiting_input',
      body: '在下面选择一个模型。',
      submitted_at: now,
      updated_at: now,
      input_type: 'choice',
      options: modelOptions.map((option) => ({
        id: option.value,
        label: option.label,
        description: option.description ?? null,
      })),
      input_placeholder: null,
      submit_label: null,
      effect: null,
    })
  }, [modelOptions, session.id])

  const handleSubmitDraft = useCallback(() => {
    if (!canSubmitInput) {
      return
    }

    if (isSlashCommandInput(draft)) {
      if (pendingAttachments.length > 0) {
        setComposerError('命令暂不支持附件，请先移除附件后再执行。')
        return
      }

      const commandName = parseSlashCommandName(draft)
      if (commandName === 'model') {
        setComposerError(null)
        setDraft('')
        openLocalModelCommandPanel(draft)
        return
      }

      commandExecuteMutation.mutate({
        sessionId: session.id,
        input: draft,
      })
      return
    }

    sendMutation.mutate({
      sessionId: session.id,
      input: draft.trim(),
      attachments: pendingAttachments,
      model: selectedModel,
      reasoningEffort: selectedReasoning,
      serviceTier: isFastModeEnabled ? 'fast' : undefined,
      planMode: isPlanModeEnabled,
      yoloMode: isYoloModeEnabled,
    })
  }, [
    canSubmitInput,
    draft,
    isFastModeEnabled,
    isPlanModeEnabled,
    isYoloModeEnabled,
    commandExecuteMutation,
    openLocalModelCommandPanel,
    pendingAttachments,
    selectedModel,
    selectedReasoning,
    sendMutation,
    session.id,
  ])

  const handleDismissCommandPanel = useCallback(() => {
    setActiveCommandPanel(null)
  }, [])

  const handleCommandPanelOptionSelect = useCallback((optionId: string) => {
    if (!activeCommandPanel) {
      return
    }

    if (activeCommandPanel.panel_id.startsWith(LOCAL_MODEL_COMMAND_PANEL_PREFIX)) {
      setSelectedModel(optionId)
      setActiveCommandPanel((current) =>
        current
          ? {
              ...current,
              status: 'completed',
              body: `后续消息将优先使用 ${getSessionModelLabelFromOptions(optionId, modelOptions)}。`,
              updated_at: new Date().toISOString(),
              input_type: 'none',
              options: [],
            }
          : current,
      )
      return
    }

    commandRespondMutation.mutate({
      sessionId: session.id,
      panelId: activeCommandPanel.panel_id,
      optionId,
    })
  }, [activeCommandPanel, commandRespondMutation, modelOptions, session.id])

  const handleCommandPanelTextSubmit = useCallback((value: string) => {
    if (!activeCommandPanel) {
      return
    }

    commandRespondMutation.mutate({
      sessionId: session.id,
      panelId: activeCommandPanel.panel_id,
      text: value,
    })
  }, [activeCommandPanel, commandRespondMutation, session.id])

  const handleRespondInteraction = useCallback((input: {
    requestId: string
    optionId?: string | null
    text?: string | null
    answers?: Record<string, string>
  }) => {
    interactionResponseMutation.mutate({
      sessionId: session.id,
      requestId: input.requestId,
      optionId: input.optionId ?? null,
      text: input.text ?? null,
      answers: input.answers,
    })
  }, [interactionResponseMutation, session.id])

  const handleUploadFiles = useCallback((files: FileList) => {
    const fileList = [...files]
    if (fileList.length === 0) {
      return
    }

    setComposerError(null)
    void Promise.all(fileList.map((file) => createSessionInputAttachment(file)))
      .then((attachments) => {
        setPendingAttachments((current) => [...current, ...attachments])
      })
      .catch((error) => {
        setComposerError(error instanceof Error ? error.message : '无法读取附件')
      })
  }, [])

  const handleRemovePendingAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    )
  }, [])

  const handleInterruptSession = useCallback(() => {
    if (interruptMutation.isPending || isInterruptRequested) {
      return
    }

    interruptMutation.mutate(session.id)
  }, [interruptMutation, isInterruptRequested, session.id])

  const handleToggleContextUsage = useCallback(() => {
    setIsContextUsageOpen((current) => !current)
  }, [])

  const handleSelectSurface = useCallback((nextSurface: WorkspaceSurface) => {
    if (nextSurface === 'git' && !canShowGit) {
      return
    }
    if (nextSurface === 'terminal' && !canShowTerminal) {
      return
    }
    setGitWorkspaceActionError(null)
    setRunWorkbenchError(null)
    setIsRunPanelOpen(false)
    setIsWebsitePanelOpen(false)
    setIsTerminalFullscreen(false)
    setActiveSurface(nextSurface)
  }, [canShowGit, canShowTerminal])

  useEffect(() => {
    if (!showDesktopWorkbenchPanel) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }

      if (workbenchRailRef.current?.contains(target) || topbarViewToggleRef.current?.contains(target)) {
        return
      }

      handleSelectSurface('code')
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [handleSelectSurface, showDesktopWorkbenchPanel])

  const handleRefreshGitWorkspace = useCallback(() => {
    setGitWorkspaceActionError(null)
    void gitWorkspaceQuery.refetch()
  }, [gitWorkspaceQuery])

  const handleRefreshGitHistory = useCallback(() => {
    void gitHistoryQuery.refetch()
  }, [gitHistoryQuery])

  const handleRequestGitHistory = useCallback(() => {
    if (gitHistoryQuery.data || gitHistoryQuery.isFetching) {
      return
    }

    void gitHistoryQuery.refetch()
  }, [gitHistoryQuery])

  const handleDiscardGitFile = useCallback((filePath: string) => {
    gitWorkspaceActionMutation.mutate({
      action: 'discard-file',
      path: filePath,
    })
  }, [gitWorkspaceActionMutation])

  const handleDiscardAllGitChanges = useCallback(() => {
    gitWorkspaceActionMutation.mutate({
      action: 'discard-all',
    })
  }, [gitWorkspaceActionMutation])

  const handleCommitAllGitChanges = useCallback((message: string) => {
    gitWorkspaceActionMutation.mutate({
      action: 'commit-all',
      message,
    })
  }, [gitWorkspaceActionMutation])

  const handleSwitchGitBranch = useCallback(async (branch: string, message?: string) => {
    setGitWorkspaceActionError(null)
    const nextMessage = message?.trim() ?? ''

    if (nextMessage) {
      await gitWorkspaceActionMutation.mutateAsync({
        action: 'commit-all',
        message: nextMessage,
      })
    }

    await gitWorkspaceActionMutation.mutateAsync({
      action: 'switch-branch',
      branch,
    })
  }, [gitWorkspaceActionMutation])

  const handlePushGitBranch = useCallback(() => {
    gitWorkspaceActionMutation.mutate({
      action: 'push',
    })
  }, [gitWorkspaceActionMutation])

  const handleLoadGitHistoryFileDiff = useCallback(async (
    commitOid: string,
    filePath: string,
    previousPath?: string | null,
  ) => {
    const target = await resolveSessionConnectionTarget()
    return target.client.getSessionGitHistoryFileDiff(session.id, {
      commitOid,
      path: filePath,
      previousPath,
    })
  }, [resolveSessionConnectionTarget, session.id])
  const handleLoadGitWorkspaceFileDiff = useCallback(async (
    filePath: string,
    previousPath?: string | null,
  ) => {
    const target = await resolveSessionConnectionTarget()
    return target.client.getSessionGitWorkspaceFileDiff(session.id, {
      path: filePath,
      previousPath,
    })
  }, [resolveSessionConnectionTarget, session.id])
  const handleRunCommand = useCallback((commandId: string) => {
    terminalActionMutation.mutate({
      action: 'run-command',
      commandId,
    })
  }, [terminalActionMutation])

  const handleRunAllCommands = useCallback(async () => {
    if (runCommands.length === 0 || isStartingAllRunCommands || isStoppingAllRunCommands) {
      return
    }

    setIsStartingAllRunCommands(true)
    try {
      for (const command of runCommands) {
        await terminalActionMutation.mutateAsync({
          action: 'run-command',
          commandId: command.id,
        })
      }
    } finally {
      setIsStartingAllRunCommands(false)
    }
  }, [isStartingAllRunCommands, isStoppingAllRunCommands, runCommands, terminalActionMutation])

  const handleRunAllKillCommands = useCallback(async () => {
    if (isStartingAllRunCommands || isStoppingAllRunCommands) {
      return
    }

    const stoppableCommands = runCommands.filter((command) => Boolean(command.kill_command))
    if (stoppableCommands.length === 0) {
      return
    }

    setIsStoppingAllRunCommands(true)
    try {
      for (const command of stoppableCommands) {
        await terminalActionMutation.mutateAsync({
          action: 'run-kill-command',
          commandId: command.id,
        })
      }
    } finally {
      setIsStoppingAllRunCommands(false)
    }
  }, [isStartingAllRunCommands, isStoppingAllRunCommands, runCommands, terminalActionMutation])

  const handleRunKillCommand = useCallback((commandId: string) => {
    terminalActionMutation.mutate({
      action: 'run-kill-command',
      commandId,
    })
  }, [terminalActionMutation])

  const handleSaveRunCommand = useCallback((input: {
    commandId?: string
    draft: SessionRunCommandDraft
  }) => {
    saveRunCommandMutation.mutate({
      action: input.commandId ? 'update' : 'create',
      commandId: input.commandId,
      command: input.draft,
    })
  }, [saveRunCommandMutation])

  const handleDeleteRunCommand = useCallback((commandId: string) => {
    saveRunCommandMutation.mutate({
      action: 'delete',
      commandId,
    })
  }, [saveRunCommandMutation])

  const handleGenerateRunCommand = useCallback(() => {
    generateRunCommandMutation.mutate()
  }, [generateRunCommandMutation])

  const handleSaveRunWebsite = useCallback((input: {
    websiteId?: string
    draft: SessionRunWebsiteDraft
  }) => {
    saveRunWebsiteMutation.mutate({
      action: input.websiteId ? 'update' : 'create',
      websiteId: input.websiteId,
      website: input.draft,
    })
  }, [saveRunWebsiteMutation])

  const handleDeleteRunWebsite = useCallback((websiteId: string) => {
    saveRunWebsiteMutation.mutate({
      action: 'delete',
      websiteId,
    })
  }, [saveRunWebsiteMutation])

  const handleGenerateRunWebsite = useCallback(() => {
    generateRunWebsiteMutation.mutate()
  }, [generateRunWebsiteMutation])

  const handleOpenRunWebsite = useCallback(() => {
    setIsWebsitePanelOpen(false)
  }, [])

  const handleSelectTerminal = useCallback((terminalId: string) => {
    terminalActionMutation.mutate({
      action: 'focus',
      terminalId,
    })
    setActiveSurface('terminal')
  }, [terminalActionMutation])

  const handleCloseTerminal = useCallback((terminalId: string) => {
    terminalActionMutation.mutate({
      action: 'close',
      terminalId,
    })
  }, [terminalActionMutation])

  const handleToggleTerminalFullscreen = useCallback(() => {
    if (!layoutIsDesktopSidebar || !canShowTerminal) {
      return
    }

    setActiveSurface('terminal')
    setIsTerminalFullscreen((current) => !current)
  }, [canShowTerminal, layoutIsDesktopSidebar])

  const titleActions = useMemo(
    () => (
      <div className="conversation-topbar__title-actions">
        <button
          type="button"
          className="conversation-topbar__more"
          onClick={() => setIsSessionActionsOpen((current) => !current)}
          aria-label="更多会话选项"
        >
          <IconMore />
        </button>

        {isSessionActionsOpen ? (
          layoutIsDesktopSidebar ? (
            <div className="topbar-menu" role="menu">
              <button
                type="button"
                className="topbar-menu__item"
                disabled={sessionActionMutation.isPending && sessionActionMutation.variables?.sessionId === session.id}
                onClick={() => void handleSessionAction(session.id, session.pinned ? 'unpin' : 'pin')}
              >
                {session.pinned ? '取消置顶会话' : '置顶会话'}
              </button>
              <button
                type="button"
                className="topbar-menu__item"
                disabled={sessionActionMutation.isPending && sessionActionMutation.variables?.sessionId === session.id}
                onClick={() => {
                  setIsSessionActionsOpen(false)
                  setIsRenameSessionOpen(true)
                }}
              >
                重命名会话
              </button>
              <button
                type="button"
                className="topbar-menu__item is-danger"
                disabled={sessionActionMutation.isPending && sessionActionMutation.variables?.sessionId === session.id}
                onClick={() => void handleSessionAction(session.id, 'delete')}
              >
                删除会话
              </button>
            </div>
          ) : null
        ) : null}
      </div>
    ),
    [
      handleSessionAction,
      isSessionActionsOpen,
      layoutIsDesktopSidebar,
      session.id,
      session.pinned,
      sessionActionMutation.isPending,
      sessionActionMutation.variables?.sessionId,
    ],
  )

  const topbarActions = useMemo(
    () => (
      canShowTerminal || canShowGit ? (
        <div className="conversation-topbar__actions">
          {canShowTerminal ? (
            <div className="conversation-topbar__run-group">
              <button
                type="button"
                className={`conversation-topbar__run-button ${isRunPanelOpen ? 'is-active' : ''}`}
                onClick={() => {
                  setIsWebsitePanelOpen(false)
                  setIsRunPanelOpen((current) => !current)
                }}
                aria-expanded={isRunPanelOpen}
                aria-haspopup="dialog"
                aria-label="打开项目命令列表"
              >
                <IconRun />
              </button>

              {isRunPanelOpen ? (
                <div className="conversation-run-popover" role="dialog" aria-label="项目命令列表">
                  <SessionRunCommandPanel
                    commands={runCommands}
                    nodeRuntime={runWorkbench?.node_runtime ?? null}
                    error={resolvedRunWorkbenchError}
                    pendingRunCommandId={pendingRunCommandId}
                    pendingKillCommandId={pendingKillCommandId}
                    pendingDeleteCommandId={pendingDeleteCommandId}
                    isSaving={saveRunCommandMutation.isPending}
                    isGenerating={generateRunCommandMutation.isPending}
                    isStartingAll={isStartingAllRunCommands}
                    isStoppingAll={isStoppingAllRunCommands}
                    generationReason={generatedRunCommandReason}
                    executionModelLabel={commandExecutionModelLabel}
                    onRun={handleRunCommand}
                    onRunAll={handleRunAllCommands}
                    onRunAllKill={handleRunAllKillCommands}
                    onRunKill={handleRunKillCommand}
                    onSave={handleSaveRunCommand}
                    onDelete={handleDeleteRunCommand}
                    onGenerate={handleGenerateRunCommand}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {canShowTerminal ? (
            <div className="conversation-topbar__run-group">
              <button
                type="button"
                className={`conversation-topbar__run-button ${isWebsitePanelOpen ? 'is-active' : ''}`}
                onClick={() => {
                  setIsRunPanelOpen(false)
                  setIsWebsitePanelOpen((current) => !current)
                }}
                aria-expanded={isWebsitePanelOpen}
                aria-haspopup="dialog"
                aria-label="打开项目网页列表"
              >
                <IconWeb />
              </button>

              {isWebsitePanelOpen ? (
                <div className="conversation-run-popover" role="dialog" aria-label="项目网页列表">
                  <SessionRunWebsitePanel
                    websites={runWebsites}
                    error={resolvedRunWorkbenchError}
                    pendingDeleteWebsiteId={pendingDeleteWebsiteId}
                    isSaving={saveRunWebsiteMutation.isPending}
                    isGenerating={generateRunWebsiteMutation.isPending}
                    generationReason={generatedRunWebsiteReason}
                    executionModelLabel={commandExecutionModelLabel}
                    onOpen={handleOpenRunWebsite}
                    onSave={handleSaveRunWebsite}
                    onDelete={handleDeleteRunWebsite}
                    onGenerate={handleGenerateRunWebsite}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {(canShowTerminal || canShowGit) ? (
            <div ref={topbarViewToggleRef} className="conversation-topbar__view-toggle" aria-label="切换工作台面板">
              <button
                type="button"
                className={`conversation-topbar__view-button ${activeSurface === 'code' ? 'is-active' : ''}`}
                onClick={() => handleSelectSurface('code')}
                aria-pressed={activeSurface === 'code'}
                aria-label="切换到代码会话视图"
              >
                <IconCode />
              </button>
              {canShowTerminal ? (
                <button
                  type="button"
                  className={`conversation-topbar__view-button ${activeSurface === 'terminal' ? 'is-active' : ''}`}
                  onClick={() => handleSelectSurface('terminal')}
                  aria-pressed={activeSurface === 'terminal'}
                  aria-label="切换到终端视图"
                >
                  <IconTerminal />
                </button>
              ) : null}
              {canShowGit ? (
                <button
                  type="button"
                  className={`conversation-topbar__view-button ${activeSurface === 'git' ? 'is-active' : ''}`}
                  onClick={() => handleSelectSurface('git')}
                  aria-pressed={activeSurface === 'git'}
                  aria-label="切换到 git 视图"
                >
                  <IconGit />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null
    ),
    [
      activeSurface,
      canShowGit,
      canShowTerminal,
      generatedRunCommandReason,
      generatedRunWebsiteReason,
      isStartingAllRunCommands,
      isStoppingAllRunCommands,
      commandExecutionModelLabel,
      generateRunCommandMutation.isPending,
      generateRunWebsiteMutation.isPending,
      handleDeleteRunCommand,
      handleGenerateRunCommand,
      handleDeleteRunWebsite,
      handleGenerateRunWebsite,
      handleOpenRunWebsite,
      handleRunCommand,
      handleRunAllCommands,
      handleRunAllKillCommands,
      handleSaveRunCommand,
      handleSaveRunWebsite,
      handleSelectSurface,
      isRunPanelOpen,
      isWebsitePanelOpen,
      pendingDeleteCommandId,
      pendingDeleteWebsiteId,
      pendingRunCommandId,
      runCommands,
      runWebsites,
      resolvedRunWorkbenchError,
      saveRunCommandMutation.isPending,
      saveRunWebsiteMutation.isPending,
    ],
  )

  const gitPanel = (
    <SessionGitPanel
      workspace={gitWorkspaceQuery.data ?? null}
      history={gitHistoryQuery.data ?? null}
      isLoading={gitWorkspaceQuery.isPending}
      isHistoryLoading={gitHistoryQuery.isFetching}
      error={gitWorkspaceError}
      historyError={gitHistoryError}
      onRefresh={handleRefreshGitWorkspace}
      onRefreshHistory={handleRefreshGitHistory}
      onRequestHistory={handleRequestGitHistory}
      onDiscardFile={handleDiscardGitFile}
      onDiscardAll={handleDiscardAllGitChanges}
      onCommitAll={handleCommitAllGitChanges}
      onSwitchBranch={handleSwitchGitBranch}
      onPush={handlePushGitBranch}
      onLoadWorkspaceFileDiff={handleLoadGitWorkspaceFileDiff}
      onLoadHistoryFileDiff={handleLoadGitHistoryFileDiff}
      pendingAction={gitWorkspacePendingAction}
      compact={showDesktopGitPanel}
    />
  )
  const terminalPanel = (
    <SessionTerminalPanel
      terminals={terminalSnapshot?.terminals ?? []}
      activeTerminalId={activeTerminal?.id ?? null}
      outputs={terminalOutputs}
      error={resolvedRunWorkbenchError}
      compact={showDesktopWorkbenchPanel || isDesktopTerminalFullscreen}
      canToggleFullscreen={layoutIsDesktopSidebar}
      isFullscreen={isDesktopTerminalFullscreen}
      onSelectTerminal={handleSelectTerminal}
      onCloseTerminal={handleCloseTerminal}
      onToggleFullscreen={handleToggleTerminalFullscreen}
    />
  )

  const conversationComposer = (
    <SessionComposer
      isDesktopSidebar={layoutIsDesktopSidebar}
      sidebarShift={layoutSidebarShift}
      isSidebarDragging={layoutIsSidebarDragging}
      composerError={composerError}
      onDismissComposerError={handleDismissComposerError}
      interactionRequests={visibleInteractionRequests}
      pendingInteractionRequestId={pendingInteractionRequestId}
      onRespondInteraction={handleRespondInteraction}
      parentSession={parentSession}
      backgroundAgentSessions={backgroundAgentSessions}
      isBackgroundAgentsOpen={isBackgroundAgentsOpen}
      planSnapshot={visiblePlanSnapshot}
      onToggleBackgroundAgents={handleToggleBackgroundAgents}
      onOpenSession={handleOpenBackgroundSession}
      getBackgroundAgentStatusLabel={getBackgroundAgentStatusLabel}
      getBackgroundAgentAccent={getBackgroundAgentAccent}
      formatBackgroundAgentsLabel={formatBackgroundAgentsLabel}
      hasBackgroundAgentStrip={hasBackgroundAgentStrip}
      commandPanel={activeCommandPanel}
      isCommandPanelPending={
        commandExecuteMutation.isPending || commandRespondMutation.isPending
      }
      onDismissCommandPanel={handleDismissCommandPanel}
      onCommandPanelOptionSelect={handleCommandPanelOptionSelect}
      onCommandPanelTextSubmit={handleCommandPanelTextSubmit}
      projectId={session.project_id}
      agentId={currentAgent?.id ?? session.agent_id}
      draft={draft}
      pendingAttachments={pendingAttachments}
      canSendInput={canSendInput}
      canSubmitInput={canSubmitInput}
      isInputLocked={visibleInteractionRequests.length > 0}
      readOnlyPlaceholder={
        visibleInteractionRequests.length > 0
          ? '请先处理上方确认请求'
          : undefined
      }
      onDraftChange={setDraft}
      onUploadFiles={handleUploadFiles}
      onRemoveAttachment={handleRemovePendingAttachment}
      onSubmit={handleSubmitDraft}
      showStopIcon={showStopIcon}
      isSendPending={
        sendMutation.isPending ||
        commandExecuteMutation.isPending ||
        commandRespondMutation.isPending
      }
      onInterrupt={handleInterruptSession}
      isFastModeEnabled={isFastModeEnabled}
      isPlanModeEnabled={isPlanModeEnabled}
      isYoloModeEnabled={isYoloModeEnabled}
      onToggleFastMode={() => setIsFastModeEnabled((current) => !current)}
      onTogglePlanMode={() => setIsPlanModeEnabled((current) => !current)}
      onToggleYoloMode={() => setIsYoloModeEnabled((current) => !current)}
      showModeBadges
      selectedModel={selectedModel}
      modelOptions={modelOptions}
      selectedReasoning={selectedReasoning}
      onSelectModel={setSelectedModel}
      onSelectReasoning={(value) =>
        setSelectedReasoning(
          value as (typeof REASONING_OPTIONS)[number]['value'],
        )
      }
      contextUsage={contextUsage}
      isContextUsageOpen={isContextUsageOpen}
      onToggleContextUsage={handleToggleContextUsage}
      contextUsageRingStyle={contextUsageRingStyle}
      usedPercent={usedPercent}
      remainingPercent={remainingPercent}
      usedTokensLabel={formatTokenCountCompact(contextUsage?.used_tokens ?? 0)}
      totalTokensLabel={formatTokenCountCompact(contextUsage?.total_tokens ?? 0)}
      showJumpToBottom={showJumpToBottom}
      onJumpToBottom={scrollConversationToBottom}
    />
  )

  const workbenchPanel = isTerminalSurfaceActive ? terminalPanel : gitPanel

  const showWorkbenchSurface = showMobileWorkbenchSurface || isDesktopTerminalFullscreen

  const conversationSurface = showWorkbenchSurface
    ? (
      <div
        ref={conversationMainRef}
        className={`conversation-main ${layoutIsDesktopSidebar ? 'has-desktop-sidebar' : ''} ${isDesktopTerminalFullscreen ? 'is-terminal-fullscreen' : ''}`}
        style={{
          transform: `translateX(${layoutSidebarShift}px)`,
          transition: layoutIsSidebarDragging ? 'none' : undefined,
        }}
      >
        <div className="conversation-topbar">
          {!layoutIsDesktopSidebar ? (
            <button
              type="button"
              className="conversation-menu"
              onClick={handleOpenSidebar}
              aria-label="打开侧边栏"
            >
              <span />
              <span className="short" />
            </button>
          ) : null}

          <div className="conversation-topbar__meta">
            <div className="conversation-topbar__title-row">
              <h1>{session.title}</h1>
              {titleActions}
            </div>
          </div>

          {topbarActions}
        </div>

        <div
          ref={conversationScrollRef}
          className={`conversation-scroll ${showWorkbenchSurface ? 'conversation-scroll--workbench' : ''}`}
        >
          <div className={`session-workbench-surface ${isDesktopTerminalFullscreen ? 'is-terminal-fullscreen' : ''}`}>
            {workbenchPanel}
          </div>
        </div>
      </div>
    )
    : (
      <>
        <div className={`session-detail-workspace ${showDesktopWorkbenchPanel ? 'has-workbench-panel' : ''}`}>
          <SessionTimeline
            conversationMainRef={conversationMainRef}
            conversationScrollRef={conversationScrollRef}
            isDesktopSidebar={layoutIsDesktopSidebar}
            sidebarShift={layoutSidebarShift}
            isSidebarDragging={layoutIsSidebarDragging}
            title={session.title}
            titleActions={titleActions}
            topbarActions={topbarActions}
            onOpenSidebar={handleOpenSidebar}
            threadContent={conversationThreadContent}
            connectionStatus={connectionStatus}
            sessionRecoveryStatus={sessionRecoveryStatus}
            isConnectionDetailOpen={isConnectionDetailOpen}
            onToggleConnectionDetail={handleToggleConnectionDetail}
            showThinkingStatus={showThinkingStatus}
          />

          {showDesktopWorkbenchPanel ? (
            <aside ref={workbenchRailRef} className="session-workbench-rail">
              {workbenchPanel}
            </aside>
          ) : null}
        </div>

        {isDesktopTerminalFullscreen ? null : conversationComposer}
      </>
    )

  const overlayContent = (
    <>
      {renameSessionDialog}
      {mobileSessionActionsDialog}
      {previewImage && typeof document !== 'undefined'
        ? createPortal(
            <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={`预览 ${previewImage.label}`}>
              <button
                type="button"
                className="attachment-lightbox__scrim"
                onClick={() => setPreviewImage(null)}
                aria-label="关闭图片预览"
              />
              <div className="attachment-lightbox__panel">
                <button
                  type="button"
                  className="attachment-lightbox__close"
                  onClick={() => setPreviewImage(null)}
                  aria-label="关闭图片预览"
                >
                  <IconClose />
                </button>
                <div className="attachment-lightbox__frame">
                  <img
                    src={previewImage.src}
                    alt={previewImage.label}
                    className="attachment-lightbox__image"
                  />
                </div>
                <div className="attachment-lightbox__meta">
                  <div className="attachment-lightbox__title">{previewImage.label}</div>
                  <div className="attachment-lightbox__hint">{previewImage.meta}</div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

    </>
  )

  if (!hasResolvedSessionDetail) {
    const emptyState = (
      <div className="conversation-main conversation-main--empty">
        {isInitialSessionBootstrapPending ? (
          <div className="empty-panel empty-panel--loading" role="status" aria-live="polite" aria-busy="true">
            <span className="empty-panel__loading-dots" aria-hidden="true">
              <span className="empty-panel__loading-dot" />
              <span className="empty-panel__loading-dot" />
              <span className="empty-panel__loading-dot" />
            </span>
            <span className="sr-only">正在加载会话</span>
          </div>
        ) : (
          <div className="empty-panel">{unresolvedSessionMessage}</div>
        )}
      </div>
    )

    if (embedded) {
      return (
        <>
          {emptyState}
          {overlayContent}
        </>
      )
    }

    return (
      <div className="conversation-page">
        {emptyState}
        {overlayContent}
      </div>
    )
  }

  if (embedded) {
    return (
      <>
        {conversationSurface}
        {overlayContent}
      </>
    )
  }

  return (
    <div
      ref={conversationPageRef}
      className={`conversation-page ${isDesktopSidebar ? 'has-desktop-sidebar' : ''}`}
      style={conversationPageStyle}
      onPointerDown={(event) => {
        if (isDesktopSidebar) {
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

        const isDraggingSidebar = moveSidebarDrag(event.clientX, event.clientY)
        if (!isDraggingSidebar) {
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

        endSidebarDrag(event.clientX, event.clientY)
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
        agentIndicatorState={
          currentAgent
            ? (workspaceAgentIndicatorState ??
              (currentAgent.status === 'online' ? 'online' : 'offline'))
            : undefined
        }
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
        activeSessionId={session.id}
        onCreateSession={(projectId) => {
          void openNewThreadPage(projectId)
        }}
        onSessionAction={handleSessionAction}
        onThreadAction={handleThreadAction}
        onLoadMoreHistory={(projectId) => {
          void loadMoreHistory(projectId)
        }}
        onLoadMoreArchived={(projectId) => {
          void loadMoreArchived(projectId)
        }}
        pendingSessionActionId={sessionActionMutation.isPending ? sessionActionMutation.variables?.sessionId ?? null : null}
        pendingThreadActionId={threadActionMutation.isPending ? threadActionMutation.variables?.projectId ?? null : null}
      />

      {conversationSurface}

      {overlayContent}
    </div>
  )
}

export const SessionDetailPanel = (props: SessionDetailPageProps) => (
  <SessionDetailPage {...props} />
)
