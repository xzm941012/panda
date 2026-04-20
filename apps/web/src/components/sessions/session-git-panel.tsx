import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  SessionGitHistory,
  SessionGitHistoryCommit,
  SessionGitHistoryCommitFile,
  SessionGitHistoryFileDiff,
  SessionGitWorkspace,
  SessionGitWorkspaceFileDiff,
} from '@panda/protocol'

const LazySessionDiffPreview = lazy(async () => {
  const module = await import('./session-diff-preview')
  return {
    default: module.SessionDiffPreview,
  }
})

type PendingGitAction =
  | {
      action: 'discard-file' | 'discard-all' | 'commit-all' | 'switch-branch' | 'push'
      path?: string
      branch?: string
    }
  | null

type CommitComposerMode = 'commit' | 'switch-branch' | null

type GraphLane = {
  oid: string
  colorIndex: number
}

type GraphRow = {
  beforeLanes: GraphLane[]
  afterLanes: GraphLane[]
  laneIndex: number
  nodeColorIndex: number
  parentLaneIndexes: number[]
}

type SessionGitPanelProps = {
  workspace: SessionGitWorkspace | null
  history: SessionGitHistory | null
  isLoading: boolean
  isHistoryLoading: boolean
  error: string | null
  historyError: string | null
  onRefresh: () => void
  onRefreshHistory: () => void
  onRequestHistory: () => void
  onDiscardFile: (filePath: string) => void
  onDiscardAll: () => void
  onCommitAll: (message: string) => void
  onSwitchBranch: (branch: string, message?: string) => Promise<void> | void
  onPush: () => void
  onLoadWorkspaceFileDiff: (
    filePath: string,
    previousPath?: string | null,
  ) => Promise<SessionGitWorkspaceFileDiff>
  onLoadHistoryFileDiff: (
    commitOid: string,
    filePath: string,
    previousPath?: string | null,
  ) => Promise<SessionGitHistoryFileDiff>
  pendingAction: PendingGitAction
  compact?: boolean
}

const GRAPH_COLOR_VARIABLES = [
  'var(--session-git-graph-1)',
  'var(--session-git-graph-2)',
  'var(--session-git-graph-3)',
  'var(--session-git-graph-4)',
  'var(--session-git-graph-5)',
  'var(--session-git-graph-6)',
]

const GRAPH_COLUMN_GAP = 14
const GRAPH_PADDING_X = 10
const GRAPH_MID_Y = 24
const GRAPH_ROW_HEIGHT = 48

const IconChevron = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
)

const IconRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 11a8 8 0 1 0 2.2 5.5" />
    <path d="M20 4v7h-7" />
  </svg>
)

const IconHistory = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 2.64-6.36" />
    <path d="M3 4v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
)

const IconDiscard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h8a8 8 0 1 1 0 16h-1" />
  </svg>
)

const IconCommit = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.5 12.5 10.5 15.5 16.5 8.5" />
    <circle cx="12" cy="12" r="8.5" />
  </svg>
)

const IconPush = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 16V5" />
    <path d="m7.5 9.5 4.5-4.5 4.5 4.5" />
    <path d="M5 19h14" />
  </svg>
)

const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6 18 18" />
    <path d="M18 6 6 18" />
  </svg>
)

const IconBranch = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 4v10" />
    <path d="M7 14a4 4 0 0 0 4 4h6" />
    <path d="M17 6a4 4 0 0 0-4 4H7" />
    <circle cx="7" cy="4" r="2" />
    <circle cx="17" cy="6" r="2" />
    <circle cx="17" cy="18" r="2" />
  </svg>
)

const IconLocal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="5" width="16" height="11" rx="2" />
    <path d="M8 19h8" />
    <path d="M10 16v3" />
    <path d="M14 16v3" />
  </svg>
)

const IconCloud = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.5 18a4.5 4.5 0 1 1 .9-8.91A5.5 5.5 0 0 1 19 11a3.5 3.5 0 0 1-.5 7Z" />
  </svg>
)

const IconMerge = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 4v10" />
    <path d="M7 14a4 4 0 0 0 4 4h6" />
    <path d="M7 10a4 4 0 0 1 4-4h6" />
    <circle cx="7" cy="4" r="2" />
    <circle cx="17" cy="6" r="2" />
    <circle cx="17" cy="18" r="2" />
  </svg>
)

type GitActionButtonProps = {
  label: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'primary' | 'danger'
  pending?: boolean
  className?: string
}

const GitActionButton = ({
  label,
  icon,
  onClick,
  disabled = false,
  variant = 'default',
  pending = false,
  className,
}: GitActionButtonProps) => (
  <button
    type="button"
    className={`session-git-panel__icon-button is-${variant} ${pending ? 'is-pending' : ''} ${className ?? ''}`.trim()}
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
  >
    <span className="session-git-panel__icon-button-glyph" aria-hidden="true">
      {icon}
    </span>
  </button>
)

const getGitStatusLabel = (status: SessionGitWorkspace['files'][number]['status']) => {
  switch (status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'untracked':
      return 'U'
    default:
      return 'M'
  }
}

const getGitEmptyMessage = (file: SessionGitWorkspace['files'][number]) => {
  if (file.status === 'renamed' && file.previous_path) {
    return `该变更仅包含重命名：${file.previous_path} -> ${file.path}`
  }
  if (file.status === 'deleted') {
    return '该文件已删除，没有可展示的补丁内容。'
  }
  if (file.status === 'untracked') {
    return '该文件还没有可展示的补丁内容。'
  }
  return '此变更没有可展示的补丁内容。'
}

const getHistoryFileEmptyMessage = (
  file: SessionGitHistoryCommitFile,
  diff: SessionGitHistoryFileDiff | null,
) => {
  if (diff && diff.diff.trim()) {
    return '此变更没有可展示的补丁内容。'
  }
  if (file.status === 'renamed' && file.previous_path) {
    return `该提交仅包含重命名：${file.previous_path} -> ${file.path}`
  }
  if (file.status === 'deleted') {
    return '该文件在这次提交中已删除，没有可展示的补丁内容。'
  }
  return '该文件在这次提交中没有可展示的补丁内容。'
}

const getGraphColor = (colorIndex: number) =>
  GRAPH_COLOR_VARIABLES[colorIndex % GRAPH_COLOR_VARIABLES.length] ?? GRAPH_COLOR_VARIABLES[0]

const getGraphX = (laneIndex: number) => GRAPH_PADDING_X + laneIndex * GRAPH_COLUMN_GAP

const getHistoryFileKey = (commitOid: string, filePath: string) =>
  `${commitOid}\u0000${filePath}`

const getCommitParentOids = (commit: SessionGitHistoryCommit) =>
  Array.isArray(commit.parent_oids) ? commit.parent_oids.filter(Boolean) : []

const getCommitRefs = (commit: SessionGitHistoryCommit) =>
  Array.isArray(commit.refs) ? commit.refs.filter(Boolean) : []

const buildHistoryGraphRows = (commits: SessionGitHistoryCommit[]) => {
  const rows: Record<string, GraphRow> = {}
  let active: GraphLane[] = []
  let nextColorIndex = 0

  const allocateColorIndex = () => {
    const colorIndex = nextColorIndex
    nextColorIndex += 1
    return colorIndex
  }

  for (const commit of commits) {
    let laneIndex = active.findIndex((lane) => lane.oid === commit.oid)
    if (laneIndex < 0) {
      active = [...active, { oid: commit.oid, colorIndex: allocateColorIndex() }]
      laneIndex = active.length - 1
    }

    const beforeLanes = active.map((lane) => ({ ...lane }))
    const nodeColorIndex = beforeLanes[laneIndex]?.colorIndex ?? allocateColorIndex()
    const parentOids = [...new Set(getCommitParentOids(commit))]
    const afterLanes = beforeLanes.map((lane) => ({ ...lane }))

    if (parentOids.length > 0) {
      afterLanes[laneIndex] = {
        oid: parentOids[0]!,
        colorIndex: nodeColorIndex,
      }
    } else {
      afterLanes.splice(laneIndex, 1)
    }

    const parentLaneIndexes: number[] = []
    if (parentOids.length > 0) {
      const firstParentLaneIndex = afterLanes.findIndex((lane) => lane.oid === parentOids[0])
      parentLaneIndexes.push(firstParentLaneIndex >= 0 ? firstParentLaneIndex : laneIndex)
    }

    parentOids.slice(1).forEach((parentOid, extraParentIndex) => {
      let parentLaneIndex = afterLanes.findIndex((lane) => lane.oid === parentOid)
      if (parentLaneIndex < 0) {
        parentLaneIndex = Math.min(afterLanes.length, laneIndex + 1 + extraParentIndex)
        afterLanes.splice(parentLaneIndex, 0, {
          oid: parentOid,
          colorIndex: allocateColorIndex(),
        })
      }
      parentLaneIndexes.push(parentLaneIndex)
    })

    rows[commit.oid] = {
      beforeLanes,
      afterLanes,
      laneIndex,
      nodeColorIndex,
      parentLaneIndexes,
    }

    active = afterLanes.filter(
      (lane, index, lanes) => lanes.findIndex((candidate) => candidate.oid === lane.oid) === index,
    )
  }

  return rows
}

const SessionGitHistoryGraph = ({
  commit,
  row,
  isLocalHead,
  isRemoteHead,
  isFirstRow,
  maxLaneCount,
}: {
  commit: SessionGitHistoryCommit
  row: GraphRow
  isLocalHead: boolean
  isRemoteHead: boolean
  isFirstRow: boolean
  maxLaneCount: number
}) => {
  const parentCount = getCommitParentOids(commit).length
  const laneCount = Math.max(maxLaneCount, row.beforeLanes.length, row.afterLanes.length, 1)
  const width = Math.max(40, GRAPH_PADDING_X * 2 + (laneCount - 1) * GRAPH_COLUMN_GAP)
  const nodeX = getGraphX(row.laneIndex)
  const nodeRadius = parentCount > 1 ? 4.7 : 3.9
  const beforeLineEndY = Math.max(0, GRAPH_MID_Y - nodeRadius - 1.1)
  const graphStyle = {
    '--session-git-graph-width': `${Math.max(48, Math.ceil(width * (56 / GRAPH_ROW_HEIGHT)))}px`,
  } as CSSProperties

  return (
    <span className="session-git-history__graph" style={graphStyle}>
      <svg
        className={`session-git-history__graph-svg ${parentCount > 1 ? 'is-merge' : ''}`}
        viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
        preserveAspectRatio="xMinYMid meet"
        aria-hidden="true"
      >
        {row.beforeLanes.map((lane, index) => (
          <path
            key={`before:${lane.oid}:${index}`}
            d={`M ${getGraphX(index)} ${isFirstRow ? beforeLineEndY : 0} L ${getGraphX(index)} ${beforeLineEndY}`}
            stroke={getGraphColor(lane.colorIndex)}
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
            opacity={isFirstRow ? 0 : 1}
          />
        ))}

        {row.afterLanes.map((lane, index) => {
          const previousLaneIndex = row.beforeLanes.findIndex((beforeLane) => beforeLane.oid === lane.oid)
          const fromX = previousLaneIndex >= 0 ? getGraphX(previousLaneIndex) : getGraphX(index)
          const toX = getGraphX(index)
          const path =
            fromX === toX
              ? `M ${toX} ${GRAPH_MID_Y} L ${toX} ${GRAPH_ROW_HEIGHT}`
              : `M ${fromX} ${GRAPH_MID_Y} C ${fromX} 27 ${toX} 31 ${toX} ${GRAPH_ROW_HEIGHT}`

          return (
            <path
              key={`after:${lane.oid}:${index}`}
              d={path}
              stroke={getGraphColor(lane.colorIndex)}
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          )
        })}

        {row.parentLaneIndexes.map((parentLaneIndex, index) => {
          const parentX = getGraphX(parentLaneIndex)
          const connectorColor = getGraphColor(
            row.afterLanes[parentLaneIndex]?.colorIndex ?? row.nodeColorIndex,
          )
          const path =
            parentX === nodeX
              ? `M ${nodeX} ${GRAPH_MID_Y} L ${parentX} ${GRAPH_ROW_HEIGHT}`
              : `M ${nodeX} ${GRAPH_MID_Y} C ${nodeX} 27 ${parentX} 31 ${parentX} ${GRAPH_ROW_HEIGHT}`

          return (
            <path
              key={`parent:${commit.oid}:${index}`}
              d={path}
              stroke={connectorColor}
              strokeWidth={index > 0 || parentCount > 1 ? '2.2' : '2'}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              opacity={index > 0 || parentCount > 1 ? 0.96 : 0.88}
            />
          )
        })}

        <circle
          cx={nodeX}
          cy={GRAPH_MID_Y}
          r={nodeRadius}
          fill="var(--color-surface-panel)"
          stroke={getGraphColor(row.nodeColorIndex)}
          strokeWidth={parentCount > 1 ? '1.8' : '1.55'}
        />
        <circle
          cx={nodeX}
          cy={GRAPH_MID_Y}
          r={isLocalHead || isRemoteHead ? 1.6 : 1.05}
          fill={getGraphColor(row.nodeColorIndex)}
        />
        {isLocalHead && isRemoteHead ? (
          <circle
            cx={nodeX}
            cy={GRAPH_MID_Y}
            r="6.4"
            fill="none"
            stroke="color-mix(in oklab, var(--color-accent-primary) 22%, transparent)"
            strokeWidth="1"
            strokeDasharray="1.5 3"
          />
        ) : null}
      </svg>
    </span>
  )
}

export const SessionGitPanel = ({
  workspace,
  history,
  isLoading,
  isHistoryLoading,
  error,
  historyError,
  onRefresh,
  onRefreshHistory,
  onRequestHistory,
  onDiscardFile,
  onDiscardAll,
  onCommitAll,
  onSwitchBranch,
  onPush,
  onLoadWorkspaceFileDiff,
  onLoadHistoryFileDiff,
  pendingAction,
  compact = false,
}: SessionGitPanelProps) => {
  const [activeView, setActiveView] = useState<'changes' | 'history'>('changes')
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({})
  const [workspaceFileDiffs, setWorkspaceFileDiffs] = useState<Record<string, SessionGitWorkspaceFileDiff>>({})
  const [workspaceFileLoadingKeys, setWorkspaceFileLoadingKeys] = useState<Record<string, boolean>>({})
  const [workspaceFileErrors, setWorkspaceFileErrors] = useState<Record<string, string>>({})
  const [expandedCommits, setExpandedCommits] = useState<Record<string, boolean>>({})
  const [selectedHistoryFiles, setSelectedHistoryFiles] = useState<Record<string, string | null>>({})
  const [historyFileDiffs, setHistoryFileDiffs] = useState<Record<string, SessionGitHistoryFileDiff>>({})
  const [historyFileLoadingKeys, setHistoryFileLoadingKeys] = useState<Record<string, boolean>>({})
  const [historyFileErrors, setHistoryFileErrors] = useState<Record<string, string>>({})
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false)
  const [composerMode, setComposerMode] = useState<CommitComposerMode>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [pendingBranch, setPendingBranch] = useState<string | null>(null)
  const branchMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setExpandedFiles((current) => {
      if (!workspace?.files.length) {
        return {}
      }

      const allowedPaths = new Set(workspace.files.map((file) => file.path))
      let changed = false
      const nextState: Record<string, boolean> = {}
      for (const [path, value] of Object.entries(current)) {
        if (!allowedPaths.has(path)) {
          changed = true
          continue
        }
        nextState[path] = value
      }

      return changed ? nextState : current
    })

    const allowedPaths = new Set(workspace?.files.map((file) => file.path) ?? [])

    setWorkspaceFileDiffs((current) => {
      let changed = false
      const nextState: Record<string, SessionGitWorkspaceFileDiff> = {}
      for (const [path, value] of Object.entries(current)) {
        if (!allowedPaths.has(path)) {
          changed = true
          continue
        }
        nextState[path] = value
      }
      return changed ? nextState : current
    })

    setWorkspaceFileLoadingKeys((current) => {
      let changed = false
      const nextState: Record<string, boolean> = {}
      for (const [path, value] of Object.entries(current)) {
        if (!allowedPaths.has(path)) {
          changed = true
          continue
        }
        nextState[path] = value
      }
      return changed ? nextState : current
    })

    setWorkspaceFileErrors((current) => {
      let changed = false
      const nextState: Record<string, string> = {}
      for (const [path, value] of Object.entries(current)) {
        if (!allowedPaths.has(path)) {
          changed = true
          continue
        }
        nextState[path] = value
      }
      return changed ? nextState : current
    })
  }, [workspace?.files])

  useEffect(() => {
    const allowedCommitIds = new Set(history?.commits.map((commit) => commit.oid) ?? [])
    const allowedHistoryFileKeys = new Set(
      history?.commits.flatMap((commit) =>
        commit.files.map((file) => getHistoryFileKey(commit.oid, file.path)),
      ) ?? [],
    )

    setExpandedCommits((current) => {
      let changed = false
      const nextState: Record<string, boolean> = {}

      for (const [oid, value] of Object.entries(current)) {
        if (!allowedCommitIds.has(oid)) {
          changed = true
          continue
        }
        nextState[oid] = value
      }

      return changed ? nextState : current
    })

    setSelectedHistoryFiles((current) => {
      let changed = false
      const nextState: Record<string, string | null> = {}

      for (const [oid, value] of Object.entries(current)) {
        if (!allowedCommitIds.has(oid)) {
          changed = true
          continue
        }
        if (value && !allowedHistoryFileKeys.has(getHistoryFileKey(oid, value))) {
          changed = true
          nextState[oid] = null
          continue
        }
        nextState[oid] = value
      }

      return changed ? nextState : current
    })

    setHistoryFileDiffs((current) => {
      let changed = false
      const nextState: Record<string, SessionGitHistoryFileDiff> = {}

      for (const [key, value] of Object.entries(current)) {
        if (!allowedHistoryFileKeys.has(key)) {
          changed = true
          continue
        }
        nextState[key] = value
      }

      return changed ? nextState : current
    })

    setHistoryFileLoadingKeys((current) => {
      let changed = false
      const nextState: Record<string, boolean> = {}

      for (const [key, value] of Object.entries(current)) {
        if (!allowedHistoryFileKeys.has(key)) {
          changed = true
          continue
        }
        nextState[key] = value
      }

      return changed ? nextState : current
    })

    setHistoryFileErrors((current) => {
      let changed = false
      const nextState: Record<string, string> = {}

      for (const [key, value] of Object.entries(current)) {
        if (!allowedHistoryFileKeys.has(key)) {
          changed = true
          continue
        }
        nextState[key] = value
      }

      return changed ? nextState : current
    })
  }, [history?.commits])

  useEffect(() => {
    if (!isBranchMenuOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!branchMenuRef.current?.contains(event.target as Node)) {
        setIsBranchMenuOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isBranchMenuOpen])

  useEffect(() => {
    if (!workspace) {
      return
    }

    if (composerMode === 'commit' && pendingAction?.action !== 'commit-all' && workspace.files.length === 0) {
      setComposerMode(null)
      setCommitMessage('')
    }

    if (pendingBranch && workspace.branch === pendingBranch) {
      setPendingBranch(null)
      setComposerMode(null)
      setCommitMessage('')
      setIsBranchMenuOpen(false)
    }
  }, [composerMode, pendingAction?.action, pendingBranch, workspace])

  useEffect(() => {
    if (!workspace?.branches.length) {
      setIsBranchMenuOpen(false)
    }
  }, [workspace?.branches])

  useEffect(() => {
    setWorkspaceFileDiffs({})
    setWorkspaceFileLoadingKeys({})
    setWorkspaceFileErrors({})
  }, [workspace?.updated_at])

  const files = workspace?.files ?? []
  const commits = history?.commits ?? []
  const hasFiles = files.length > 0
  const hasHistory = commits.length > 0
  const isDiscardAllPending = pendingAction?.action === 'discard-all'
  const isCommitPending = pendingAction?.action === 'commit-all'
  const isBranchPending = pendingAction?.action === 'switch-branch'
  const isPushPending = pendingAction?.action === 'push'
  const isChangesView = activeView === 'changes'
  const composerTitle =
    composerMode === 'switch-branch' && pendingBranch
      ? `提交后切换到 ${pendingBranch}`
      : '提交全部改动'
  const headerMeta = useMemo(() => {
    if (!workspace) {
      return null
    }

    const parts: string[] = []
    if (workspace.upstream_branch) {
      parts.push(workspace.upstream_branch)
    }
    if (workspace.ahead_count > 0) {
      parts.push(`ahead ${workspace.ahead_count}`)
    }
    if (workspace.behind_count > 0) {
      parts.push(`behind ${workspace.behind_count}`)
    }

    return parts.join(' · ')
  }, [workspace])
  const historyMeta = useMemo(() => {
    if (!history) {
      return null
    }

    const parts = [history.branch]
    if (history.upstream_branch) {
      parts.push(history.upstream_branch)
    }

    return parts.join(' · ')
  }, [history])
  const historyGraphRows = useMemo(
    () => (activeView === 'history' ? buildHistoryGraphRows(commits) : {}),
    [activeView, commits],
  )
  const historyGraphLaneCount = useMemo(
    () => {
      if (activeView !== 'history') {
        return 1
      }

      return Math.max(
        1,
        ...Object.values(historyGraphRows).map((row) =>
          Math.max(row.beforeLanes.length, row.afterLanes.length, row.laneIndex + 1),
        ),
      )
    },
    [activeView, historyGraphRows],
  )

  const ensureWorkspaceFileDiff = (
    filePath: string,
    previousPath?: string | null,
  ) => {
    if (workspaceFileDiffs[filePath] || workspaceFileLoadingKeys[filePath]) {
      return
    }

    setWorkspaceFileLoadingKeys((current) => ({
      ...current,
      [filePath]: true,
    }))
    setWorkspaceFileErrors((current) => {
      const nextState = { ...current }
      delete nextState[filePath]
      return nextState
    })

    void onLoadWorkspaceFileDiff(filePath, previousPath)
      .then((diff) => {
        setWorkspaceFileDiffs((current) => ({
          ...current,
          [filePath]: diff,
        }))
      })
      .catch((loadError) => {
        setWorkspaceFileErrors((current) => ({
          ...current,
          [filePath]: loadError instanceof Error ? loadError.message : '无法读取该文件的差异。',
        }))
      })
      .finally(() => {
        setWorkspaceFileLoadingKeys((current) => {
          const nextState = { ...current }
          delete nextState[filePath]
          return nextState
        })
      })
  }

  useEffect(() => {
    if (activeView !== 'changes' || files.length === 0) {
      return
    }

    for (const file of files) {
      if (expandedFiles[file.path]) {
        ensureWorkspaceFileDiff(file.path, file.previous_path)
      }
    }
  }, [
    activeView,
    expandedFiles,
    files,
    onLoadWorkspaceFileDiff,
    workspaceFileDiffs,
    workspaceFileLoadingKeys,
  ])

  const resetComposer = () => {
    setComposerMode(null)
    setCommitMessage('')
    setPendingBranch(null)
  }

  const handleToggleCommitComposer = () => {
    setPendingBranch(null)
    setComposerMode((current) => {
      if (current === 'commit') {
        setCommitMessage('')
        return null
      }
      return 'commit'
    })
  }

  const handleSubmitComposer = () => {
    const nextMessage = commitMessage.trim()
    if (!nextMessage) {
      return
    }

    if (composerMode === 'switch-branch' && pendingBranch) {
      void Promise.resolve(onSwitchBranch(pendingBranch, nextMessage)).catch(() => {})
      return
    }

    onCommitAll(nextMessage)
  }

  const handleSelectBranch = (branch: string) => {
    if (!workspace || branch === workspace.branch || pendingAction) {
      return
    }

    setIsBranchMenuOpen(false)
    if (workspace.files.length > 0) {
      setPendingBranch(branch)
      setComposerMode('switch-branch')
      return
    }

    void Promise.resolve(onSwitchBranch(branch)).catch(() => {})
  }

  const handleRefreshCurrentView = () => {
    if (isChangesView) {
      onRefresh()
      return
    }
    onRefreshHistory()
  }

  const handleToggleView = () => {
    setActiveView((current) => {
      const nextView = current === 'changes' ? 'history' : 'changes'
      if (nextView === 'history') {
        onRequestHistory()
      }
      return nextView
    })
  }

  const handleToggleHistoryFile = (
    commit: SessionGitHistoryCommit,
    file: SessionGitHistoryCommitFile,
  ) => {
    const diffKey = getHistoryFileKey(commit.oid, file.path)
    const isCurrentlySelected = selectedHistoryFiles[commit.oid] === file.path

    setSelectedHistoryFiles((current) => ({
      ...current,
      [commit.oid]: isCurrentlySelected ? null : file.path,
    }))

    if (isCurrentlySelected || historyFileDiffs[diffKey] || historyFileLoadingKeys[diffKey]) {
      return
    }

    setHistoryFileLoadingKeys((current) => ({
      ...current,
      [diffKey]: true,
    }))
    setHistoryFileErrors((current) => {
      const nextState = { ...current }
      delete nextState[diffKey]
      return nextState
    })

    void onLoadHistoryFileDiff(commit.oid, file.path, file.previous_path)
      .then((diff) => {
        setHistoryFileDiffs((current) => ({
          ...current,
          [diffKey]: diff,
        }))
      })
      .catch((loadError) => {
        setHistoryFileErrors((current) => ({
          ...current,
          [diffKey]: loadError instanceof Error ? loadError.message : '无法读取该文件的提交差异。',
        }))
      })
      .finally(() => {
        setHistoryFileLoadingKeys((current) => {
          const nextState = { ...current }
          delete nextState[diffKey]
          return nextState
        })
      })
  }

  const formatCommitTime = (value: string) => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return value
    }

    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  }

  return (
    <section className={`session-git-panel ${compact ? 'is-compact' : ''}`}>
      <div className="session-git-panel__header">
        <div className="session-git-panel__heading" ref={branchMenuRef}>
          <button
            type="button"
            className="session-git-panel__branch-button"
            onClick={() => setIsBranchMenuOpen((current) => !current)}
            disabled={!workspace || Boolean(pendingAction)}
            aria-haspopup="menu"
            aria-expanded={isBranchMenuOpen}
            title={workspace ? `切换分支：${workspace.branch}` : '分支加载中'}
          >
            <span className="session-git-panel__branch-icon" aria-hidden="true">
              <IconBranch />
            </span>
            <span className="session-git-panel__branch">{workspace?.branch ?? '加载中'}</span>
            <span className={`session-git-panel__branch-chevron ${isBranchMenuOpen ? 'is-open' : ''}`} aria-hidden="true">
              <IconChevron />
            </span>
          </button>

          {isBranchMenuOpen && workspace ? (
            <div className="session-git-panel__branch-menu" role="menu" aria-label="分支列表">
              {workspace.branches.map((branch) => {
                const isCurrentBranch = branch === workspace.branch
                const isPendingBranchTarget =
                  pendingAction?.action === 'switch-branch' && pendingAction.branch === branch
                return (
                  <button
                    key={branch}
                    type="button"
                    className={`session-git-panel__branch-option ${isCurrentBranch ? 'is-current' : ''}`}
                    onClick={() => handleSelectBranch(branch)}
                    disabled={isCurrentBranch || Boolean(pendingAction)}
                    role="menuitemradio"
                    aria-checked={isCurrentBranch}
                    title={isCurrentBranch ? `${branch}（当前）` : `切换到 ${branch}`}
                  >
                    <span className="session-git-panel__branch-option-name">{branch}</span>
                    {isCurrentBranch ? (
                      <span className="session-git-panel__branch-option-meta">当前</span>
                    ) : null}
                    {isPendingBranchTarget ? (
                      <span className="session-git-panel__branch-option-meta">切换中</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>

        <div className="session-git-panel__toolbar">
              <GitActionButton
                label={isChangesView ? '切换到提交历史' : '返回修改列表'}
                icon={<IconHistory />}
                onClick={handleToggleView}
                disabled={Boolean(pendingAction)}
                variant={isChangesView ? 'default' : 'primary'}
                className={!isChangesView ? 'is-active' : undefined}
          />
          <GitActionButton
            label={isChangesView ? (isLoading ? '正在刷新' : '刷新') : (isHistoryLoading ? '正在刷新历史' : '刷新历史')}
            icon={<IconRefresh />}
            onClick={handleRefreshCurrentView}
            disabled={isChangesView ? (isLoading || Boolean(pendingAction)) : isHistoryLoading}
            pending={isChangesView ? isLoading : isHistoryLoading}
          />
          {isChangesView && hasFiles ? (
            <>
              <GitActionButton
                label={isDiscardAllPending ? '正在撤回全部修改' : '撤回全部修改'}
                icon={<IconDiscard />}
                onClick={onDiscardAll}
                disabled={Boolean(pendingAction)}
                variant="danger"
                pending={isDiscardAllPending}
              />
              <GitActionButton
                label={
                  isCommitPending
                    ? '正在提交全部修改'
                    : composerMode === 'commit'
                      ? '收起提交编辑器'
                      : '提交全部修改'
                }
                icon={<IconCommit />}
                onClick={handleToggleCommitComposer}
                disabled={Boolean(pendingAction)}
                variant="primary"
                pending={isCommitPending}
              />
            </>
          ) : null}
          {isChangesView && !hasFiles ? (
            <GitActionButton
              label={isPushPending ? '正在推送当前分支' : '推送当前分支'}
              icon={<IconPush />}
              onClick={onPush}
              disabled={Boolean(pendingAction)}
              variant="primary"
              pending={isPushPending}
            />
          ) : null}
        </div>
      </div>

      {isChangesView && workspace ? (
        <div className="session-git-panel__summary">
          <span className="session-git-panel__summary-text">
            {hasFiles ? `${files.length} 个文件待处理` : '当前工作区没有待提交改动'}
          </span>
          {headerMeta ? (
            <span className="session-git-panel__summary-meta">{headerMeta}</span>
          ) : null}
        </div>
      ) : null}

      {!isChangesView && history ? (
        <div className="session-git-panel__summary">
          <span className="session-git-panel__summary-text">
            {hasHistory ? `${commits.length} 条最近提交` : '当前分支还没有提交历史'}
          </span>
          {historyMeta ? (
            <span className="session-git-panel__summary-meta">{historyMeta}</span>
          ) : null}
        </div>
      ) : null}

      {isChangesView && composerMode && hasFiles ? (
        <div className="session-git-panel__composer">
          <div className="session-git-panel__composer-title">{composerTitle}</div>
          <div className="session-git-panel__composer-row">
            <input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="输入 commit message"
              className="session-git-panel__input"
              disabled={Boolean(pendingAction)}
            />
            <GitActionButton
              label={composerMode === 'switch-branch' ? '提交并切换分支' : '确认提交'}
              icon={<IconCommit />}
              onClick={handleSubmitComposer}
              disabled={!commitMessage.trim() || Boolean(pendingAction)}
              variant="primary"
              pending={isCommitPending || isBranchPending}
            />
            <GitActionButton
              label="取消提交"
              icon={<IconClose />}
              onClick={resetComposer}
              disabled={Boolean(pendingAction)}
            />
          </div>
        </div>
      ) : null}

      {isChangesView && error ? (
        <div className="session-git-panel__notice is-error">{error}</div>
      ) : null}

      {!isChangesView && historyError ? (
        <div className="session-git-panel__notice is-error">{historyError}</div>
      ) : null}

      {isChangesView && isLoading && !workspace ? (
        <div className="session-git-panel__empty">正在读取当前工作区改动…</div>
      ) : null}

      {!isChangesView && isHistoryLoading && !history ? (
        <div className="session-git-panel__empty">正在读取当前分支提交历史…</div>
      ) : null}

      {isChangesView && !isLoading && workspace && !hasFiles ? (
        <div className="session-git-panel__empty">
          当前分支没有待提交改动。你现在可以直接推送当前分支。
        </div>
      ) : null}

      {!isChangesView && !isHistoryLoading && history && !hasHistory ? (
        <div className="session-git-panel__empty">
          当前分支还没有提交历史。
        </div>
      ) : null}

      {isChangesView && hasFiles ? (
        <div className="session-git-panel__list">
          {files.map((file) => {
            const isExpanded = Boolean(expandedFiles[file.path])
            const isDiscardPending =
              pendingAction?.action === 'discard-file' && pendingAction.path === file.path
            const workspaceFileDiff = workspaceFileDiffs[file.path]
            const isFileLoading = Boolean(workspaceFileLoadingKeys[file.path])
            const workspaceFileError = workspaceFileErrors[file.path] ?? null

            return (
              <article
                key={file.path}
                className={`session-git-file ${isExpanded ? 'is-expanded' : ''}`}
              >
                <div className="session-git-file__head">
                  <button
                    type="button"
                    className="session-git-file__toggle"
                    onClick={() => {
                      const nextExpanded = !isExpanded
                      setExpandedFiles((current) => ({
                        ...current,
                        [file.path]: nextExpanded,
                      }))
                      if (nextExpanded) {
                        ensureWorkspaceFileDiff(file.path, file.previous_path)
                      }
                    }}
                    aria-expanded={isExpanded}
                  >
                    <span className="session-git-file__main">
                      <span className="session-git-file__path">{file.path}</span>
                      {file.previous_path ? (
                        <span className="session-git-file__rename">
                          来自 {file.previous_path}
                        </span>
                      ) : null}
                    </span>
                    <span className="session-git-file__meta">
                      <span className={`session-git-file__status is-${file.status}`}>
                        {getGitStatusLabel(file.status)}
                      </span>
                      <span className="session-git-file__counts">
                        <span className="is-add">+{file.additions}</span>
                        <span className="is-remove">-{file.deletions}</span>
                      </span>
                      <span className="session-git-file__chevron" aria-hidden="true">
                        <IconChevron />
                      </span>
                    </span>
                  </button>

                  <GitActionButton
                    label={isDiscardPending ? `正在撤回 ${file.path}` : `撤回 ${file.path}`}
                    icon={<IconDiscard />}
                    onClick={() => onDiscardFile(file.path)}
                    disabled={Boolean(pendingAction)}
                    variant="danger"
                    pending={isDiscardPending}
                    className="session-git-file__action"
                  />
                </div>

                {isExpanded ? (
                  <div className="session-git-file__detail">
                    {workspaceFileError ? (
                      <div className="session-git-panel__notice is-error">{workspaceFileError}</div>
                    ) : isFileLoading ? (
                      <div className="patch-file-card__empty">正在读取该文件的差异…</div>
                    ) : (
                      <Suspense fallback={<div className="patch-file-card__empty">正在展开差异…</div>}>
                        <LazySessionDiffPreview
                          diffText={workspaceFileDiff?.diff ?? ''}
                          filePath={file.path}
                          emptyMessage={getGitEmptyMessage(file)}
                        />
                      </Suspense>
                    )}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : null}

      {!isChangesView && hasHistory ? (
        <div className="session-git-history">
          {commits.map((commit, commitIndex) => {
            const isExpanded = Boolean(expandedCommits[commit.oid])
            const commitParentOids = getCommitParentOids(commit)
            const selectedHistoryFilePath = selectedHistoryFiles[commit.oid] ?? null
            const graphRow = historyGraphRows[commit.oid]
            const isLocalHead = history?.head_oid === commit.oid
            const isRemoteHead = history?.upstream_head_oid === commit.oid
            const visibleRefs = getCommitRefs(commit).filter((ref) => {
              if (!ref) {
                return false
              }
              if (ref === history?.branch || ref === history?.upstream_branch) {
                return false
              }
              if (ref === `HEAD -> ${history?.branch}`) {
                return false
              }
              return ref !== 'HEAD'
            })

            return (
              <article
                key={commit.oid}
                className={`session-git-history__item ${isExpanded ? 'is-expanded' : ''} ${
                  commitParentOids.length > 1 ? 'is-merge' : ''
                } ${isLocalHead ? 'is-local-head' : ''} ${isRemoteHead ? 'is-remote-head' : ''}`.trim()}
              >
                <button
                  type="button"
                  className="session-git-history__toggle"
                  onClick={() =>
                    setExpandedCommits((current) => ({
                      ...current,
                      [commit.oid]: !current[commit.oid],
                    }))
                  }
                  aria-expanded={isExpanded}
                >
                  {graphRow ? (
                    <SessionGitHistoryGraph
                      commit={commit}
                      row={graphRow}
                      isLocalHead={isLocalHead}
                      isRemoteHead={isRemoteHead}
                      isFirstRow={commitIndex === 0}
                      maxLaneCount={historyGraphLaneCount}
                    />
                  ) : null}
                  <span className="session-git-history__content">
                    <span className="session-git-history__subject">{commit.subject}</span>
                    <span className="session-git-history__meta">
                      <span>{commit.short_oid}</span>
                      <span>{commit.author_name}</span>
                      <span>{formatCommitTime(commit.committed_at)}</span>
                    </span>
                  </span>
                  <span className="session-git-history__refs">
                    {isLocalHead ? (
                      <span className="session-git-history__ref is-local" title="本地当前 HEAD">
                        <IconLocal />
                      </span>
                    ) : null}
                    {isRemoteHead ? (
                      <span
                        className="session-git-history__ref is-remote"
                        title={history?.upstream_branch ? `云端位置：${history.upstream_branch}` : '云端位置'}
                      >
                        <IconCloud />
                      </span>
                    ) : null}
                    {commitParentOids.length > 1 ? (
                      <span className="session-git-history__ref is-merge" title="合并提交">
                        <IconMerge />
                      </span>
                    ) : null}
                    {visibleRefs.slice(0, 2).map((ref) => (
                      <span
                        key={`${commit.oid}:${ref}`}
                        className="session-git-history__ref is-label"
                        title={ref}
                      >
                        {ref}
                      </span>
                    ))}
                  </span>
                  <span className="session-git-history__chevron" aria-hidden="true">
                    <IconChevron />
                  </span>
                </button>

                {isExpanded ? (
                  <div className="session-git-history__files">
                    <div className="session-git-history__files-list">
                      {commit.files.map((file) => {
                        const isSelected = selectedHistoryFilePath === file.path
                        const historyFileKey = getHistoryFileKey(commit.oid, file.path)
                        const fileDiff = historyFileDiffs[historyFileKey]
                        const isFileLoading = Boolean(historyFileLoadingKeys[historyFileKey])
                        const fileDiffError = historyFileErrors[historyFileKey] ?? null

                        return (
                          <div
                            key={`${commit.oid}:${file.path}`}
                            className={`session-git-history-file-row ${isSelected ? 'is-selected' : ''}`}
                          >
                            <button
                              type="button"
                              className={`session-git-history-file ${isSelected ? 'is-selected' : ''}`}
                              onClick={() => handleToggleHistoryFile(commit, file)}
                              aria-pressed={isSelected}
                            >
                              <span className={`session-git-file__status is-${file.status}`}>
                                {getGitStatusLabel(file.status)}
                              </span>
                              <span className="session-git-history-file__path">{file.path}</span>
                              {file.previous_path ? (
                                <span className="session-git-history-file__rename">
                                  来自 {file.previous_path}
                                </span>
                              ) : null}
                              <span className="session-git-history-file__meta">
                                {fileDiff ? (
                                  <span className="session-git-history-file__counts">
                                    <span className="is-add">+{fileDiff.additions}</span>
                                    <span className="is-remove">-{fileDiff.deletions}</span>
                                  </span>
                                ) : isFileLoading ? (
                                  <span className="session-git-history-file__loading">读取中…</span>
                                ) : (
                                  <span className="session-git-history-file__hint">点击查看</span>
                                )}
                              </span>
                            </button>

                            {isSelected ? (
                              <div className="session-git-history__diff is-inline">
                                <div className="session-git-history__diff-header">
                                  <span className="session-git-history__diff-path">{file.path}</span>
                                  {file.previous_path ? (
                                    <span className="session-git-history__diff-rename">
                                      来自 {file.previous_path}
                                    </span>
                                  ) : null}
                                </div>

                                {fileDiffError ? (
                                  <div className="session-git-panel__notice is-error">{fileDiffError}</div>
                                ) : isFileLoading ? (
                                  <div className="patch-file-card__empty">正在读取该文件的提交差异…</div>
                                ) : (
                                  <Suspense fallback={<div className="patch-file-card__empty">正在展开差异…</div>}>
                                    <LazySessionDiffPreview
                                      diffText={fileDiff?.diff ?? ''}
                                      filePath={file.path}
                                      emptyMessage={getHistoryFileEmptyMessage(file, fileDiff ?? null)}
                                    />
                                  </Suspense>
                                )}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
