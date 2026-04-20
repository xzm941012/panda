import type {
  SessionRef,
  TimelineEntry,
  WorkspaceProjectDirectory,
} from '@panda/protocol'

export const LAST_AGENT_STORAGE_KEY = 'panda:last-agent-id'
export const LAST_SESSION_STORAGE_KEY = 'panda:last-session-id'
export const PENDING_SESSION_STORAGE_KEY = 'panda:pending-session-id'
export const PENDING_PROJECT_STORAGE_KEY = 'panda:pending-project-id'
export const PENDING_DIRECTORY_PICKER_STORAGE_KEY = 'panda:pending-directory-picker'
export const PENDING_SESSION_HANDOFF_STORAGE_KEY = 'panda:pending-session-handoff'
export const SELECTED_AGENT_CONNECTION_HINT_STORAGE_KEY =
  'panda:selected-agent-connection-hint'

const PENDING_SESSION_HANDOFF_TTL_MS = 30_000
const SELECTED_AGENT_CONNECTION_HINT_TTL_MS = 30 * 60 * 1000

export type PendingSessionHandoff = {
  sessionId: string
  agentId: string
  projectId: string
  createdAt: string
  session: SessionRef
  project: WorkspaceProjectDirectory | null
  optimisticEntry: TimelineEntry | null
}

export type SelectedAgentConnectionHint = {
  agentId: string
  name: string
  displayName: string | null
  directBaseUrl: string
  wsBaseUrl: string
  createdAt: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const normalizePendingSessionHandoff = (value: unknown): PendingSessionHandoff | null => {
  if (!isRecord(value)) {
    return null
  }

  const {
    sessionId,
    agentId,
    projectId,
    createdAt,
    session,
    project,
    optimisticEntry,
  } = value

  if (
    typeof sessionId !== 'string' ||
    typeof agentId !== 'string' ||
    typeof projectId !== 'string' ||
    typeof createdAt !== 'string' ||
    !isRecord(session) ||
    session.id !== sessionId ||
    session.agent_id !== agentId ||
    session.project_id !== projectId
  ) {
    return null
  }

  if (
    project !== null &&
    (!isRecord(project) ||
      project.id !== projectId ||
      project.agent_id !== agentId ||
      typeof project.name !== 'string' ||
      typeof project.path !== 'string')
  ) {
    return null
  }

  if (
    optimisticEntry !== null &&
    (!isRecord(optimisticEntry) ||
      typeof optimisticEntry.id !== 'string' ||
      typeof optimisticEntry.kind !== 'string' ||
      typeof optimisticEntry.body !== 'string' ||
      typeof optimisticEntry.timestamp !== 'string')
  ) {
    return null
  }

  return {
    sessionId,
    agentId,
    projectId,
    createdAt,
    session: session as SessionRef,
    project: (project ?? null) as WorkspaceProjectDirectory | null,
    optimisticEntry: (optimisticEntry ?? null) as TimelineEntry | null,
  }
}

const isPendingSessionHandoffExpired = (handoff: PendingSessionHandoff) => {
  const createdAtMs = new Date(handoff.createdAt).getTime()
  if (!Number.isFinite(createdAtMs)) {
    return true
  }

  return Date.now() - createdAtMs > PENDING_SESSION_HANDOFF_TTL_MS
}

const normalizeSelectedAgentConnectionHint = (
  value: unknown,
): SelectedAgentConnectionHint | null => {
  if (!isRecord(value)) {
    return null
  }

  const {
    agentId,
    name,
    displayName,
    directBaseUrl,
    wsBaseUrl,
    createdAt,
  } = value

  if (
    typeof agentId !== 'string' ||
    typeof name !== 'string' ||
    (displayName !== null && typeof displayName !== 'string') ||
    typeof directBaseUrl !== 'string' ||
    typeof wsBaseUrl !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    return null
  }

  return {
    agentId,
    name,
    displayName,
    directBaseUrl,
    wsBaseUrl,
    createdAt,
  }
}

const isSelectedAgentConnectionHintExpired = (
  hint: SelectedAgentConnectionHint,
) => {
  const createdAtMs = new Date(hint.createdAt).getTime()
  if (!Number.isFinite(createdAtMs)) {
    return true
  }

  return Date.now() - createdAtMs > SELECTED_AGENT_CONNECTION_HINT_TTL_MS
}

export const writePendingSessionHandoff = (handoff: PendingSessionHandoff | null) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (!handoff) {
      window.sessionStorage.removeItem(PENDING_SESSION_HANDOFF_STORAGE_KEY)
      return
    }

    window.sessionStorage.setItem(
      PENDING_SESSION_HANDOFF_STORAGE_KEY,
      JSON.stringify(handoff),
    )
  } catch {
    // Ignore storage failures; transient session hand-off is best-effort only.
  }
}

export const readPendingSessionHandoff = (sessionId?: string | null) => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.sessionStorage.getItem(PENDING_SESSION_HANDOFF_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const handoff = normalizePendingSessionHandoff(JSON.parse(raw))
    if (!handoff || isPendingSessionHandoffExpired(handoff)) {
      window.sessionStorage.removeItem(PENDING_SESSION_HANDOFF_STORAGE_KEY)
      return null
    }

    if (sessionId && handoff.sessionId !== sessionId) {
      return null
    }

    return handoff
  } catch {
    return null
  }
}

export const clearPendingSessionHandoff = (sessionId?: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const handoff = readPendingSessionHandoff()
    if (sessionId && handoff?.sessionId && handoff.sessionId !== sessionId) {
      return
    }

    window.sessionStorage.removeItem(PENDING_SESSION_HANDOFF_STORAGE_KEY)
  } catch {
    // Ignore storage failures; transient session hand-off is best-effort only.
  }
}

export const writeSelectedAgentConnectionHint = (
  hint: SelectedAgentConnectionHint | null,
) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (!hint) {
      window.sessionStorage.removeItem(SELECTED_AGENT_CONNECTION_HINT_STORAGE_KEY)
      return
    }

    window.sessionStorage.setItem(
      SELECTED_AGENT_CONNECTION_HINT_STORAGE_KEY,
      JSON.stringify(hint),
    )
  } catch {
    // Ignore storage failures; connection hints are best-effort only.
  }
}

export const readSelectedAgentConnectionHint = (agentId?: string | null) => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.sessionStorage.getItem(
      SELECTED_AGENT_CONNECTION_HINT_STORAGE_KEY,
    )
    if (!raw) {
      return null
    }

    const hint = normalizeSelectedAgentConnectionHint(JSON.parse(raw))
    if (!hint || isSelectedAgentConnectionHintExpired(hint)) {
      window.sessionStorage.removeItem(SELECTED_AGENT_CONNECTION_HINT_STORAGE_KEY)
      return null
    }

    if (agentId && hint.agentId !== agentId) {
      return null
    }

    return hint
  } catch {
    return null
  }
}

export const clearSelectedAgentConnectionHint = (agentId?: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const hint = readSelectedAgentConnectionHint()
    if (agentId && hint?.agentId && hint.agentId !== agentId) {
      return
    }

    window.sessionStorage.removeItem(SELECTED_AGENT_CONNECTION_HINT_STORAGE_KEY)
  } catch {
    // Ignore storage failures; connection hints are best-effort only.
  }
}


export const readStoredAgentId = () => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.localStorage.getItem(LAST_AGENT_STORAGE_KEY)
  } catch {
    return null
  }
}

export const writeStoredAgentId = (agentId: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (agentId) {
      window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, agentId)
      return
    }

    window.localStorage.removeItem(LAST_AGENT_STORAGE_KEY)
  } catch {
    // Ignore storage failures; selection persistence is best-effort only.
  }
}

export const readStoredSessionId = () => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.localStorage.getItem(LAST_SESSION_STORAGE_KEY)
  } catch {
    return null
  }
}

export const writeStoredSessionId = (sessionId: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (sessionId) {
      window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, sessionId)
      return
    }

    window.localStorage.removeItem(LAST_SESSION_STORAGE_KEY)
  } catch {
    // Ignore storage failures; selection persistence is best-effort only.
  }
}

export const queuePendingSessionId = (sessionId: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (sessionId) {
      window.sessionStorage.setItem(PENDING_SESSION_STORAGE_KEY, sessionId)
      return
    }

    window.sessionStorage.removeItem(PENDING_SESSION_STORAGE_KEY)
  } catch {
    // Ignore storage failures; transient session hand-off is best-effort only.
  }
}

export const consumePendingSessionId = () => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const sessionId = window.sessionStorage.getItem(PENDING_SESSION_STORAGE_KEY)
    if (sessionId) {
      window.sessionStorage.removeItem(PENDING_SESSION_STORAGE_KEY)
    }
    return sessionId
  } catch {
    return null
  }
}

export const queuePendingProjectId = (projectId: string | null) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (projectId) {
      window.sessionStorage.setItem(PENDING_PROJECT_STORAGE_KEY, projectId)
      return
    }

    window.sessionStorage.removeItem(PENDING_PROJECT_STORAGE_KEY)
  } catch {
    // Ignore storage failures; transient project hand-off is best-effort only.
  }
}

export const consumePendingProjectId = () => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const projectId = window.sessionStorage.getItem(PENDING_PROJECT_STORAGE_KEY)
    if (projectId) {
      window.sessionStorage.removeItem(PENDING_PROJECT_STORAGE_KEY)
    }
    return projectId
  } catch {
    return null
  }
}

export const queuePendingDirectoryPicker = (open: boolean) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    if (open) {
      window.sessionStorage.setItem(PENDING_DIRECTORY_PICKER_STORAGE_KEY, '1')
      return
    }

    window.sessionStorage.removeItem(PENDING_DIRECTORY_PICKER_STORAGE_KEY)
  } catch {
    // Ignore storage failures; transient picker hand-off is best-effort only.
  }
}

export const consumePendingDirectoryPicker = () => {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    const value = window.sessionStorage.getItem(PENDING_DIRECTORY_PICKER_STORAGE_KEY)
    if (value) {
      window.sessionStorage.removeItem(PENDING_DIRECTORY_PICKER_STORAGE_KEY)
    }
    return value === '1'
  } catch {
    return false
  }
}

export const clearStoredSessionSelection = () => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.removeItem(LAST_AGENT_STORAGE_KEY)
    window.localStorage.removeItem(LAST_SESSION_STORAGE_KEY)
    window.sessionStorage.removeItem(PENDING_SESSION_STORAGE_KEY)
    window.sessionStorage.removeItem(PENDING_PROJECT_STORAGE_KEY)
    window.sessionStorage.removeItem(PENDING_DIRECTORY_PICKER_STORAGE_KEY)
    window.sessionStorage.removeItem(PENDING_SESSION_HANDOFF_STORAGE_KEY)
    window.sessionStorage.removeItem(SELECTED_AGENT_CONNECTION_HINT_STORAGE_KEY)
  } catch {
    // Ignore storage failures; selection persistence is best-effort only.
  }
}
