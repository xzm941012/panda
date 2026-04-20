import type {
  WorkspaceSessionDetail,
  WorkspaceSessionDetailResponse,
  WorkspaceSessionListItem,
} from '@panda/protocol'

const DEFAULT_SESSION_CAPABILITY: WorkspaceSessionDetail['capability'] = {
  can_stream_live: false,
  can_send_input: false,
  can_interrupt: false,
  can_approve: false,
  can_reject: false,
  can_show_git: false,
  can_show_terminal: false,
}

const synthesizeWorkspaceSessionDetail = (
  summary: WorkspaceSessionListItem,
): WorkspaceSessionDetail => ({
  id: summary.id,
  agent_id: summary.agent_id,
  project_id: summary.project_id,
  archived: summary.archived,
  title: summary.title,
  last_event_at: summary.last_event_at,
  pinned: summary.pinned,
  run_state: summary.run_state,
  run_state_changed_at: summary.run_state_changed_at,
  subagent: summary.subagent,
  provider: 'codex',
  mode: 'managed',
  health: 'active',
  branch: '',
  worktree: '',
  summary: '',
  latest_assistant_message: null,
  context_usage: null,
  capability: DEFAULT_SESSION_CAPABILITY,
})

export const mergeWorkspaceSessionSummaryIntoDetail = (
  summary: WorkspaceSessionListItem | null | undefined,
  detail: WorkspaceSessionDetail | null | undefined,
) => {
  if (!summary) {
    return detail ?? null
  }

  if (!detail || detail.id !== summary.id) {
    return synthesizeWorkspaceSessionDetail(summary)
  }

  return {
    ...detail,
    id: summary.id,
    agent_id: summary.agent_id,
    project_id: summary.project_id,
    archived: summary.archived,
    title: summary.title,
    last_event_at: summary.last_event_at,
    pinned: summary.pinned,
    run_state: summary.run_state,
    run_state_changed_at: summary.run_state_changed_at,
    subagent: summary.subagent,
  } satisfies WorkspaceSessionDetail
}

export const toWorkspaceSessionDetailPatch = (
  patch: Record<string, unknown> | null | undefined,
): Partial<WorkspaceSessionDetail> | null => {
  if (!patch) {
    return null
  }

  const nextPatch: Partial<WorkspaceSessionDetail> = {}

  if (typeof patch.title === 'string') {
    nextPatch.title = patch.title
  }
  if (typeof patch.archived === 'boolean') {
    nextPatch.archived = patch.archived
  }
  if (typeof patch.pinned === 'boolean') {
    nextPatch.pinned = patch.pinned
  }
  if (typeof patch.last_event_at === 'string') {
    nextPatch.last_event_at = patch.last_event_at
  }
  if (
    patch.run_state === 'idle' ||
    patch.run_state === 'running' ||
    patch.run_state === 'completed'
  ) {
    nextPatch.run_state = patch.run_state
  }
  if (
    patch.run_state_changed_at === null ||
    typeof patch.run_state_changed_at === 'string'
  ) {
    nextPatch.run_state_changed_at = patch.run_state_changed_at
  }
  if (typeof patch.summary === 'string') {
    nextPatch.summary = patch.summary
  }
  if (
    patch.latest_assistant_message === null ||
    typeof patch.latest_assistant_message === 'string'
  ) {
    nextPatch.latest_assistant_message = patch.latest_assistant_message
  }
  if (typeof patch.provider === 'string') {
    nextPatch.provider = patch.provider as WorkspaceSessionDetail['provider']
  }
  if (typeof patch.mode === 'string') {
    nextPatch.mode = patch.mode as WorkspaceSessionDetail['mode']
  }
  if (typeof patch.health === 'string') {
    nextPatch.health = patch.health as WorkspaceSessionDetail['health']
  }
  if (typeof patch.branch === 'string') {
    nextPatch.branch = patch.branch
  }
  if (typeof patch.worktree === 'string') {
    nextPatch.worktree = patch.worktree
  }
  if (
    patch.context_usage === null ||
    (typeof patch.context_usage === 'object' && patch.context_usage !== null)
  ) {
    nextPatch.context_usage = patch.context_usage as WorkspaceSessionDetail['context_usage']
  }
  if (
    patch.subagent === null ||
    (typeof patch.subagent === 'object' && patch.subagent !== null)
  ) {
    nextPatch.subagent = patch.subagent as WorkspaceSessionDetail['subagent']
  }
  if (typeof patch.capability === 'object' && patch.capability !== null) {
    nextPatch.capability = patch.capability as WorkspaceSessionDetail['capability']
  }

  return Object.keys(nextPatch).length > 0 ? nextPatch : null
}

export const patchWorkspaceSessionDetailWithSafeLastEventAt = (
  current: WorkspaceSessionDetailResponse | undefined,
  sessionId: string,
  patch: Partial<WorkspaceSessionDetail>,
) => {
  if (!current || current.session.id !== sessionId) {
    return current
  }

  const { last_event_at, ...restPatch } = patch
  let nextSession: WorkspaceSessionDetail = {
    ...current.session,
    ...restPatch,
  }

  if (typeof last_event_at === 'string' && last_event_at.trim()) {
    const nextTimestamp = new Date(last_event_at).getTime()
    const currentTimestamp = new Date(current.session.last_event_at).getTime()
    if (
      Number.isFinite(nextTimestamp) &&
      (!Number.isFinite(currentTimestamp) || nextTimestamp > currentTimestamp)
    ) {
      nextSession = {
        ...nextSession,
        last_event_at: last_event_at,
      }
    }
  }

  return {
    ...current,
    session: nextSession,
  } satisfies WorkspaceSessionDetailResponse
}
