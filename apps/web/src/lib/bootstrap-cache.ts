import type { PhaseOneSnapshot, SessionRef } from '@panda/protocol'

type BootstrapSession = PhaseOneSnapshot['sessions'][number]
type BootstrapProject = PhaseOneSnapshot['projects'][number]

const sortSessionsByActivity = (sessions: BootstrapSession[]) =>
  [...sessions].sort((a, b) => {
    const pinnedDelta = Number(b.pinned) - Number(a.pinned)
    if (pinnedDelta !== 0) {
      return pinnedDelta
    }

    return +new Date(b.last_event_at) - +new Date(a.last_event_at)
  })

export const hasBootstrapSession = (
  snapshot: PhaseOneSnapshot | undefined,
  sessionId: string,
) => Boolean(snapshot?.sessions.some((session) => session.id === sessionId))

export const patchBootstrapSessionIfMatched = (
  snapshot: PhaseOneSnapshot | undefined,
  sessionId: string,
  sessionPatch: Partial<BootstrapSession>,
) => {
  if (!snapshot || !hasBootstrapSession(snapshot, sessionId)) {
    return snapshot
  }

  return {
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
  }
}

export const patchBootstrapSessionLastEventAtIfNewer = (
  snapshot: PhaseOneSnapshot | undefined,
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

  return patchBootstrapSessionIfMatched(snapshot, sessionId, {
    last_event_at: lastEventAt,
  })
}

export const patchBootstrapSessionWithSafeLastEventAt = (
  snapshot: PhaseOneSnapshot | undefined,
  sessionId: string,
  sessionPatch: Partial<BootstrapSession>,
) => {
  if (!snapshot) {
    return snapshot
  }

  const { last_event_at, ...restPatch } = sessionPatch
  let nextSnapshot = patchBootstrapSessionIfMatched(snapshot, sessionId, restPatch)

  if (typeof last_event_at === 'string' && last_event_at.trim()) {
    nextSnapshot = patchBootstrapSessionLastEventAtIfNewer(
      nextSnapshot,
      sessionId,
      last_event_at,
    )
  }

  return nextSnapshot
}

export const patchBootstrapSessions = (
  snapshot: PhaseOneSnapshot | undefined,
  sessionIds: string[],
  sessionPatch: Partial<BootstrapSession>,
) => {
  if (!snapshot || sessionIds.length === 0) {
    return snapshot
  }

  const targetIds = new Set(sessionIds)
  return {
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
  }
}

export const removeBootstrapSessions = (
  snapshot: PhaseOneSnapshot | undefined,
  sessionIds: string[],
) => {
  if (!snapshot || sessionIds.length === 0) {
    return snapshot
  }

  const targetIds = new Set(sessionIds)
  const nextSessions = snapshot.sessions.filter((session) => !targetIds.has(session.id))
  const nextActiveSessionId =
    targetIds.has(snapshot.active_session_id) ? nextSessions[0]?.id ?? '' : snapshot.active_session_id

  return {
    ...snapshot,
    active_session_id: nextActiveSessionId,
    sessions: sortSessionsByActivity(nextSessions),
  }
}

export const patchBootstrapProjectIfMatched = (
  snapshot: PhaseOneSnapshot | undefined,
  projectId: string,
  projectPatch: Partial<BootstrapProject>,
) => {
  if (!snapshot || !snapshot.projects.some((project) => project.id === projectId)) {
    return snapshot
  }

  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            ...projectPatch,
          }
        : project,
    ),
  }
}

export const reorderBootstrapProjects = (
  snapshot: PhaseOneSnapshot | undefined,
  orderedProjectIds: string[],
) => {
  if (!snapshot || orderedProjectIds.length === 0 || snapshot.projects.length <= 1) {
    return snapshot
  }

  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]))
  const seen = new Set<string>()
  const nextProjects: BootstrapProject[] = []

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

  return {
    ...snapshot,
    projects: nextProjects,
  }
}

export const removeBootstrapProject = (
  snapshot: PhaseOneSnapshot | undefined,
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

  return {
    ...snapshot,
    active_session_id: nextActiveSessionId,
    projects: snapshot.projects.filter((project) => project.id !== projectId),
    sessions: sortSessionsByActivity(nextSessions),
  }
}

export const upsertBootstrapProject = (
  snapshot: PhaseOneSnapshot | undefined,
  project: BootstrapProject,
) => {
  if (!snapshot) {
    return snapshot
  }

  return {
    ...snapshot,
    generated_at: new Date().toISOString(),
    projects: [
      project,
      ...snapshot.projects.filter((item) => item.id !== project.id),
    ],
  }
}

export const upsertBootstrapSession = (
  snapshot: PhaseOneSnapshot | undefined,
  session: SessionRef,
) => {
  if (!snapshot) {
    return snapshot
  }

  const nextSessions = [
    session,
    ...snapshot.sessions.filter((item) => item.id !== session.id),
  ]

  return {
    ...snapshot,
    generated_at: new Date().toISOString(),
    active_session_id: session.id,
    sessions: sortSessionsByActivity(nextSessions),
  }
}
