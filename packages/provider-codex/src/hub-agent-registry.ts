import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentControlPlaneSync,
  PhaseOneSnapshot,
  ProjectRef,
  SessionRef,
} from '@panda/protocol'
import { agentControlPlaneSyncSchema } from '@panda/protocol'

type LoggerLike = {
  info?: (payload: Record<string, unknown>, message: string) => void
  warn?: (payload: Record<string, unknown>, message: string) => void
  error?: (payload: Record<string, unknown>, message: string) => void
}

type RegistryPersistence = {
  version: 1
  saved_at: string
  agents: AgentControlPlaneSync[]
}

export type HubAgentRegistryOptions = {
  storageFilePath?: string | null
  heartbeatTimeoutMs: number
  logger?: LoggerLike
}

const REGISTRY_PERSISTENCE_VERSION = 1
const PERSIST_DEBOUNCE_MS = 300

const isoNow = () => new Date().toISOString()

const sortSessionsByActivity = (sessions: SessionRef[]) =>
  [...sessions].sort(
    (left, right) =>
      new Date(right.last_event_at).getTime() - new Date(left.last_event_at).getTime(),
  )

const sortAgents = (agents: AgentControlPlaneSync['agent'][]) =>
  [...agents].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === 'online' ? -1 : 1
    }

    const rightSeen = new Date(right.last_seen_at ?? 0).getTime()
    const leftSeen = new Date(left.last_seen_at ?? 0).getTime()
    if (leftSeen !== rightSeen) {
      return rightSeen - leftSeen
    }

    const leftLabel = left.display_name?.trim() || left.name
    const rightLabel = right.display_name?.trim() || right.name
    return leftLabel.localeCompare(rightLabel)
  })

const safeIso = (value: string | null | undefined, fallback: string) => {
  const timestamp = typeof value === 'string' ? new Date(value).getTime() : Number.NaN
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback
}

const normalizeHostname = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) {
    return ''
  }

  return normalized
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase()
}

const normalizeUrlHost = (value: string) => {
  const normalized = value.trim()
  if (!normalized) {
    return ''
  }

  try {
    const parsed = new URL(normalized)
    const hostname = normalizeHostname(parsed.hostname)
    if (hostname) {
      parsed.hostname = hostname
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return normalized
  }
}

const normalizeAgentSync = (
  input: AgentControlPlaneSync,
  existing: AgentControlPlaneSync | null,
  options?: { touchHeartbeat?: boolean },
): AgentControlPlaneSync => {
  const receivedAt = isoNow()
  const parsed = agentControlPlaneSyncSchema.parse(input)
  const directBaseUrl = normalizeUrlHost(parsed.agent.direct_base_url)
  const wsBaseUrl = normalizeUrlHost(parsed.agent.ws_base_url)
  const registeredAt = existing?.agent.registered_at ?? parsed.agent.registered_at ?? receivedAt
  const lastSeenAt =
    options?.touchHeartbeat === false
      ? parsed.agent.last_seen_at ?? receivedAt
      : receivedAt
  const host =
    normalizeHostname(parsed.agent.host) ||
    normalizeHostname(parsed.agent.tailscale_dns_name) ||
    parsed.agent.tailscale_ip?.trim() ||
    directBaseUrl ||
    parsed.agent.id
  const agent = {
    ...parsed.agent,
    display_name: parsed.agent.display_name ?? existing?.agent.display_name ?? null,
    host,
    tailscale_dns_name: normalizeHostname(parsed.agent.tailscale_dns_name) || null,
    direct_base_url: directBaseUrl,
    ws_base_url: wsBaseUrl,
    status:
      options?.touchHeartbeat === false
        ? parsed.agent.status
        : 'online' as const,
    project_count: parsed.projects.length,
    session_count: parsed.sessions.length,
    registered_at: safeIso(registeredAt, receivedAt),
    last_seen_at: safeIso(lastSeenAt, receivedAt),
  }

  const projects = parsed.projects.map((project) => ({
    ...project,
    agent_id: agent.id,
  }))
  const sessions = parsed.sessions.map((session) => ({
    ...session,
    agent_id: agent.id,
  }))

  return {
    agent,
    projects,
    sessions,
    active_session_id:
      parsed.active_session_id ||
      sessions.find((session) => !session.archived)?.id ||
      sessions[0]?.id ||
      '',
    generated_at: safeIso(parsed.generated_at, receivedAt),
  }
}

export const createHubAgentRegistry = ({
  storageFilePath,
  heartbeatTimeoutMs,
  logger,
}: HubAgentRegistryOptions) => {
  const entries = new Map<string, AgentControlPlaneSync>()
  let persistTimer: NodeJS.Timeout | null = null

  const schedulePersist = () => {
    if (!storageFilePath || persistTimer) {
      return
    }

    persistTimer = setTimeout(() => {
      persistTimer = null
      void persist().catch((error) => {
        logger?.error?.(
          {
            error: error instanceof Error ? error.message : String(error),
            storageFilePath,
          },
          'Failed to persist Panda hub agent registry.',
        )
      })
    }, PERSIST_DEBOUNCE_MS)
  }

  const persist = async () => {
    if (!storageFilePath) {
      return
    }

    const payload: RegistryPersistence = {
      version: REGISTRY_PERSISTENCE_VERSION,
      saved_at: isoNow(),
      agents: [...entries.values()],
    }
    await fs.mkdir(path.dirname(storageFilePath), { recursive: true })
    await fs.writeFile(storageFilePath, JSON.stringify(payload, null, 2), 'utf8')
  }

  const load = async () => {
    if (!storageFilePath) {
      return
    }

    try {
      const raw = await fs.readFile(storageFilePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<RegistryPersistence>
      if (
        parsed.version !== REGISTRY_PERSISTENCE_VERSION ||
        !Array.isArray(parsed.agents)
      ) {
        return
      }

      for (const candidate of parsed.agents) {
        const normalized = normalizeAgentSync(candidate, null, {
          touchHeartbeat: false,
        })
        entries.set(normalized.agent.id, normalized)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return
      }

      logger?.warn?.(
        {
          error: error instanceof Error ? error.message : String(error),
          storageFilePath,
        },
        'Unable to load Panda hub agent registry cache.',
      )
    }
  }

  const upsert = async (input: AgentControlPlaneSync) => {
    const existing = entries.get(input.agent.id) ?? null
    const normalized = normalizeAgentSync(input, existing)
    entries.set(normalized.agent.id, normalized)
    schedulePersist()
    return normalized
  }

  const setDisplayName = async (agentId: string, displayName: string | null) => {
    const existing = entries.get(agentId)
    if (!existing) {
      return null
    }

    const nextEntry = {
      ...existing,
      agent: {
        ...existing.agent,
        display_name: displayName,
      },
    }
    entries.set(agentId, nextEntry)
    schedulePersist()
    return nextEntry
  }

  const remove = async (agentId: string) => {
    const deleted = entries.delete(agentId)
    if (deleted) {
      schedulePersist()
    }
    return deleted
  }

  const markOfflineExpired = () => {
    const expiredAgentIds: string[] = []
    const now = Date.now()

    for (const [agentId, entry] of entries) {
      const lastSeenAt = new Date(entry.agent.last_seen_at ?? 0).getTime()
      if (
        entry.agent.status === 'online' &&
        Number.isFinite(lastSeenAt) &&
        now - lastSeenAt > heartbeatTimeoutMs
      ) {
        entries.set(agentId, {
          ...entry,
          agent: {
            ...entry.agent,
            status: 'offline',
          },
        })
        expiredAgentIds.push(agentId)
      }
    }

    if (expiredAgentIds.length > 0) {
      schedulePersist()
    }

    return expiredAgentIds
  }

  const buildSnapshot = (): PhaseOneSnapshot => {
    markOfflineExpired()

    const syncedEntries = [...entries.values()]
    const projects: ProjectRef[] = []
    const sessions: SessionRef[] = []

    for (const entry of syncedEntries) {
      projects.push(...entry.projects)
      sessions.push(...entry.sessions)
    }

    const orderedSessions = sortSessionsByActivity(sessions)
    const activeSessionId =
      orderedSessions.find((session) => !session.archived)?.id ??
      orderedSessions[0]?.id ??
      ''

    return {
      generated_at: isoNow(),
      agents: sortAgents(
        syncedEntries.map((entry) => ({
          ...entry.agent,
          project_count: entry.projects.length,
          session_count: entry.sessions.length,
        })),
      ),
      projects,
      sessions: orderedSessions,
      active_session_id: activeSessionId,
      timeline: [],
      changed_files: [],
      runtime_processes: [],
      previews: [],
      approvals: [],
    }
  }

  return {
    load,
    upsert,
    setDisplayName,
    remove,
    markOfflineExpired,
    buildSnapshot,
    list: () => [...entries.values()],
  }
}
