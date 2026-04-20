import type {
  ProjectRef,
  SessionRef,
  WorkspaceDirectorySnapshot,
  WorkspaceProjectDirectory,
  WorkspaceSessionDirectory,
} from '@panda/protocol'
import {
  mergeEntityArrayByKey,
  reuseStructurallyEqualValue,
} from './directory-structural-sharing'

type WorkspaceSession = WorkspaceDirectorySnapshot['sessions'][number]
type WorkspaceProject = WorkspaceDirectorySnapshot['projects'][number]

const sortSessionsByActivity = (sessions: WorkspaceSession[]) =>
  [...sessions].sort((a, b) => {
    const pinnedDelta = Number(b.pinned) - Number(a.pinned)
    if (pinnedDelta !== 0) {
      return pinnedDelta
    }

    return +new Date(b.last_event_at) - +new Date(a.last_event_at)
  })

const recomputeProjectStats = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
): WorkspaceDirectorySnapshot | undefined => {
  if (!snapshot) {
    return snapshot
  }

  const previousStats = new Map(
    snapshot.project_stats.map((stat) => [stat.project_id, stat]),
  )

  return {
    ...snapshot,
    project_stats: snapshot.projects.map((project) => {
      const projectSessions = snapshot.sessions.filter(
        (session) => session.project_id === project.id,
      )
      const previous = previousStats.get(project.id)
      return {
        project_id: project.id,
        visible_session_count: projectSessions.filter((session) => !session.archived).length,
        archived_session_count: previous?.archived_session_count ?? 0,
        hidden_history_count: previous?.hidden_history_count ?? 0,
      }
    }),
  }
}

const toWorkspaceSessionDirectory = (
  session: SessionRef | WorkspaceSessionDirectory,
): WorkspaceSessionDirectory => ({
  id: session.id,
  agent_id: session.agent_id,
  project_id: session.project_id,
  archived: session.archived,
  title: session.title,
  last_event_at: session.last_event_at,
  pinned: session.pinned,
  run_state: session.run_state,
  run_state_changed_at: session.run_state_changed_at,
  subagent: session.subagent,
})

const toWorkspaceProjectDirectory = (
  project: ProjectRef | WorkspaceProjectDirectory,
): WorkspaceProjectDirectory => ({
  id: project.id,
  agent_id: project.agent_id,
  name: project.name,
  display_name: project.display_name,
  pinned: project.pinned,
  path: project.path,
})

export const toWorkspaceSessionDirectoryPatch = (
  patch: Record<string, unknown> | null | undefined,
): Partial<WorkspaceSession> | null => {
  if (!patch) {
    return null
  }

  const nextPatch: Partial<WorkspaceSession> = {}

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
  if (
    patch.subagent === null ||
    (typeof patch.subagent === 'object' && patch.subagent !== null)
  ) {
    nextPatch.subagent = patch.subagent as WorkspaceSession['subagent']
  }

  return Object.keys(nextPatch).length > 0 ? nextPatch : null
}

export const hasWorkspaceSession = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  sessionId: string,
) => Boolean(snapshot?.sessions.some((session) => session.id === sessionId))

export const patchWorkspaceSessionIfMatched = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  sessionId: string,
  sessionPatch: Partial<WorkspaceSession>,
) => {
  if (!snapshot || !hasWorkspaceSession(snapshot, sessionId)) {
    return snapshot
  }

  return recomputeProjectStats({
    ...snapshot,
    sessions: sortSessionsByActivity(
      snapshot.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              ...sessionPatch,
            }
          : session,
      ),
    ),
  })
}

export const patchWorkspaceSessionLastEventAtIfNewer = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  sessionId: string,
  lastEventAt: string,
) => {
  if (!snapshot) {
    return snapshot
  }

  const currentSession = snapshot.sessions.find((session) => session.id === sessionId)
  if (!currentSession) {
    return snapshot
  }

  const nextTimestamp = new Date(lastEventAt).getTime()
  const currentTimestamp = new Date(currentSession.last_event_at).getTime()
  if (
    !Number.isFinite(nextTimestamp) ||
    (Number.isFinite(currentTimestamp) && nextTimestamp <= currentTimestamp)
  ) {
    return snapshot
  }

  return patchWorkspaceSessionIfMatched(snapshot, sessionId, {
    last_event_at: lastEventAt,
  })
}

export const patchWorkspaceSessionWithSafeLastEventAt = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  sessionId: string,
  sessionPatch: Partial<WorkspaceSession>,
) => {
  if (!snapshot) {
    return snapshot
  }

  const { last_event_at, ...restPatch } = sessionPatch
  let nextSnapshot = patchWorkspaceSessionIfMatched(snapshot, sessionId, restPatch)

  if (typeof last_event_at === 'string' && last_event_at.trim()) {
    nextSnapshot = patchWorkspaceSessionLastEventAtIfNewer(
      nextSnapshot,
      sessionId,
      last_event_at,
    )
  }

  return nextSnapshot
}

export const patchWorkspaceSessions = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  sessionIds: string[],
  sessionPatch: Partial<WorkspaceSession>,
) => {
  if (!snapshot || sessionIds.length === 0) {
    return snapshot
  }

  const targetIds = new Set(sessionIds)
  return recomputeProjectStats({
    ...snapshot,
    sessions: sortSessionsByActivity(
      snapshot.sessions.map((session) =>
        targetIds.has(session.id)
          ? {
              ...session,
              ...sessionPatch,
            }
          : session,
      ),
    ),
  })
}

export const removeWorkspaceSessions = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  sessionIds: string[],
) => {
  if (!snapshot || sessionIds.length === 0) {
    return snapshot
  }

  const targetIds = new Set(sessionIds)
  const nextSessions = snapshot.sessions.filter((session) => !targetIds.has(session.id))
  const nextActiveSessionId =
    targetIds.has(snapshot.active_session_id) ? nextSessions[0]?.id ?? '' : snapshot.active_session_id

  return recomputeProjectStats({
    ...snapshot,
    active_session_id: nextActiveSessionId,
    sessions: sortSessionsByActivity(nextSessions),
  })
}

export const patchWorkspaceProjectIfMatched = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  projectId: string,
  projectPatch: Partial<WorkspaceProject>,
) => {
  if (!snapshot || !snapshot.projects.some((project) => project.id === projectId)) {
    return snapshot
  }

  return recomputeProjectStats({
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            ...projectPatch,
          }
        : project,
    ),
  })
}

export const reorderWorkspaceProjects = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  orderedProjectIds: string[],
) => {
  if (!snapshot || orderedProjectIds.length === 0 || snapshot.projects.length <= 1) {
    return snapshot
  }

  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]))
  const seen = new Set<string>()
  const nextProjects: WorkspaceProject[] = []

  for (const projectId of orderedProjectIds) {
    const project = projectById.get(projectId)
    if (!project || seen.has(projectId)) {
      continue
    }

    seen.add(projectId)
    nextProjects.push(project)
  }

  for (const project of snapshot.projects) {
    if (seen.has(project.id)) {
      continue
    }

    nextProjects.push(project)
  }

  if (nextProjects.every((project, index) => project.id === snapshot.projects[index]?.id)) {
    return snapshot
  }

  return recomputeProjectStats({
    ...snapshot,
    projects: nextProjects,
  })
}

export const removeWorkspaceProject = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  projectId: string,
) => {
  if (!snapshot) {
    return snapshot
  }

  const nextSessions = snapshot.sessions.filter((session) => session.project_id !== projectId)
  const nextActiveSessionId =
    nextSessions.some((session) => session.id === snapshot.active_session_id)
      ? snapshot.active_session_id
      : nextSessions[0]?.id ?? ''

  return recomputeProjectStats({
    ...snapshot,
    active_session_id: nextActiveSessionId,
    projects: snapshot.projects.filter((project) => project.id !== projectId),
    sessions: sortSessionsByActivity(nextSessions),
  })
}

export const upsertWorkspaceSession = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  session: SessionRef | WorkspaceSessionDirectory,
) => {
  if (!snapshot) {
    return snapshot
  }

  const nextSession = toWorkspaceSessionDirectory(session)

  const nextSessions = [
    nextSession,
    ...snapshot.sessions.filter((item) => item.id !== nextSession.id),
  ]

  return recomputeProjectStats({
    ...snapshot,
    generated_at: new Date().toISOString(),
    active_session_id: nextSession.id,
    sessions: sortSessionsByActivity(nextSessions),
  })
}

export const upsertWorkspaceProject = (
  snapshot: WorkspaceDirectorySnapshot | undefined,
  project: ProjectRef | WorkspaceProjectDirectory,
) => {
  if (!snapshot) {
    return snapshot
  }

  const nextProject = toWorkspaceProjectDirectory(project)
  const nextProjects = [
    nextProject,
    ...snapshot.projects.filter((item) => item.id !== nextProject.id),
  ]

  return recomputeProjectStats({
    ...snapshot,
    generated_at: new Date().toISOString(),
    projects: nextProjects,
  })
}

export const mergeWorkspaceDirectorySnapshot = (
  current: WorkspaceDirectorySnapshot | undefined,
  next: WorkspaceDirectorySnapshot,
): WorkspaceDirectorySnapshot => {
  if (!current) {
    return next
  }

  const agent = next.agent
    ? reuseStructurallyEqualValue(current.agent ?? undefined, next.agent)
    : current.agent === null
      ? current.agent
      : null
  const projects = mergeEntityArrayByKey(current.projects, next.projects, (project) => project.id)
  const projectStats = mergeEntityArrayByKey(
    current.project_stats,
    next.project_stats,
    (stat) => stat.project_id,
  )
  const sessions = mergeEntityArrayByKey(current.sessions, next.sessions, (session) => session.id)
  const generatedAt = reuseStructurallyEqualValue(current.generated_at, next.generated_at)
  const activeSessionId = reuseStructurallyEqualValue(
    current.active_session_id,
    next.active_session_id,
  )

  if (
    current.agent === agent &&
    current.projects === projects &&
    current.project_stats === projectStats &&
    current.sessions === sessions &&
    current.generated_at === generatedAt &&
    current.active_session_id === activeSessionId
  ) {
    return current
  }

  return {
    ...next,
    generated_at: generatedAt,
    agent,
    projects,
    project_stats: projectStats,
    sessions,
    active_session_id: activeSessionId,
  }
}
