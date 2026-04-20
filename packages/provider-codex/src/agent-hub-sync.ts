import os from 'node:os'
import {
  agentRegistrationResponseSchema,
  phaseOneSnapshotSchema,
  type AgentControlPlaneSync,
  type AgentNode,
  type PhaseOneSnapshot,
} from '@panda/protocol'
import { readTailscaleStatus } from './tailscale'

type LoggerLike = {
  info?: (message: string, ...args: unknown[]) => void
  warn?: (message: string, ...args: unknown[]) => void
  error?: (message: string, ...args: unknown[]) => void
}

export type AgentNetworkIdentity = {
  host: string
  tailscaleIp: string | null
  tailscaleDnsName: string | null
  directBaseUrl: string
  wsBaseUrl: string
}

export type AgentHubSyncOptions = {
  hubUrl: string
  hubApiKey?: string | null
  localBaseUrl: string
  agentId: string
  agentName: string
  transport: AgentNode['transport']
  heartbeatIntervalMs?: number
  networkIdentity: AgentNetworkIdentity
  version?: string | null
  logger?: LoggerLike
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

const trimToNull = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  return normalized ? normalized : null
}

const normalizeHostname = (value: string | null | undefined) => {
  const normalized = trimToNull(value)
  if (!normalized) {
    return null
  }

  return normalized
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase()
}

const readHostnameFromUrl = (value: string | null | undefined) => {
  const normalized = trimToNull(value)
  if (!normalized) {
    return null
  }

  try {
    return normalizeHostname(new URL(normalized).hostname)
  } catch {
    return null
  }
}

const toWsUrl = (baseUrl: string) => {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  return url.toString()
}

const toIdentitySlug = (value: string | null | undefined) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const formatHostForUrl = (value: string) => {
  if (!value.includes(':') || value.startsWith('[')) {
    return value
  }

  return `[${value}]`
}

export const resolveAgentGroupHost = (value: string | null | undefined) =>
  normalizeHostname(value) ?? trimToNull(value)

export const buildAgentServiceBaseUrl = (options: {
  host: string | null | undefined
  port: number
  protocol?: 'http' | 'ws'
}) => {
  const host = resolveAgentGroupHost(options.host)
  if (!host) {
    return null
  }

  const protocol = options.protocol ?? 'http'
  const suffix = protocol === 'ws' ? '/ws' : ''
  return `${protocol}://${formatHostForUrl(host)}:${String(options.port)}${suffix}`
}

export const resolveAgentEndpointLabel = (options?: {
  directBaseUrl?: string | null
  host?: string | null
  port?: number | null
}) => {
  const fallbackPort =
    typeof options?.port === 'number' && Number.isFinite(options.port) && options.port > 0
      ? Math.round(options.port)
      : null
  const normalizedBaseUrl = trimToNull(options?.directBaseUrl)
  if (normalizedBaseUrl) {
    try {
      const parsed = new URL(normalizedBaseUrl)
      const hostname = normalizeHostname(parsed.hostname)
      if (hostname) {
        if (parsed.port) {
          return `${hostname}:${parsed.port}`
        }

        return fallbackPort ? `${hostname}:${String(fallbackPort)}` : hostname
      }
    } catch {
      return normalizedBaseUrl.replace(/\/+$/, '')
    }
  }

  const hostname = normalizeHostname(options?.host)
  if (!hostname) {
    return null
  }

  return fallbackPort ? `${hostname}:${String(fallbackPort)}` : hostname
}

export const resolveDefaultAgentId = (options?: {
  directBaseUrl?: string | null
  agentName?: string | null
  host?: string | null
  port?: number | null
}) => {
  const identity =
    resolveAgentEndpointLabel({
      directBaseUrl: options?.directBaseUrl,
      host: options?.host,
      port: options?.port,
    }) ??
    trimToNull(options?.agentName) ??
    normalizeHostname(options?.host) ??
    'local'

  return `agent-${toIdentitySlug(identity) || 'local'}`
}

const resolveHostAddress = () => {
  const interfaces = os.networkInterfaces()
  let fallback: string | null = null

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') {
        continue
      }

      if (name.toLowerCase().includes('tailscale') || entry.address.startsWith('100.')) {
        return entry.address
      }

      fallback ??= entry.address
    }
  }

  return fallback ?? os.hostname()
}

export const resolveAgentNetworkIdentity = (options?: {
  directBaseUrl?: string | null
  wsBaseUrl?: string | null
  tailscaleIp?: string | null
  tailscaleDnsName?: string | null
  groupHost?: string | null
  port?: number
}) => {
  const tailscaleStatus = readTailscaleStatus()
  const detectedDnsName = normalizeHostname(tailscaleStatus?.Self?.DNSName)
  const detectedTailscaleIp = trimToNull(tailscaleStatus?.Self?.TailscaleIPs?.[0])
  const port = options?.port ?? 4242
  const host =
    readHostnameFromUrl(options?.directBaseUrl) ??
    resolveAgentGroupHost(options?.groupHost) ??
    normalizeHostname(options?.tailscaleDnsName) ??
    trimToNull(options?.tailscaleIp) ??
    detectedDnsName ??
    detectedTailscaleIp ??
    resolveHostAddress()
  const directBaseUrl =
    trimToNull(options?.directBaseUrl) ??
    buildAgentServiceBaseUrl({
      host,
      port,
    }) ??
    `http://${host}:${port}`
  const wsBaseUrl = trimToNull(options?.wsBaseUrl) ?? toWsUrl(directBaseUrl)

  return {
    host,
    tailscaleIp: trimToNull(options?.tailscaleIp) ?? detectedTailscaleIp,
    tailscaleDnsName: normalizeHostname(options?.tailscaleDnsName) ?? detectedDnsName,
    directBaseUrl,
    wsBaseUrl,
  } satisfies AgentNetworkIdentity
}

const readLocalSnapshot = async (localBaseUrl: string) => {
  const response = await fetch(new URL('/api/bootstrap', localBaseUrl))
  if (!response.ok) {
    throw new Error(`Local bootstrap request failed with ${response.status}`)
  }

  return phaseOneSnapshotSchema.parse(await response.json())
}

const buildAgentSyncPayload = async (
  snapshot: PhaseOneSnapshot,
  options: AgentHubSyncOptions,
): Promise<AgentControlPlaneSync> => {
  const now = new Date().toISOString()
  const discoveredAgent = snapshot.agents[0]
  const agent: AgentNode = {
    ...(discoveredAgent ?? {
      id: options.agentId,
      name: options.agentName,
      host: options.networkIdentity.host,
      tailscale_ip: options.networkIdentity.tailscaleIp,
      tailscale_dns_name: options.networkIdentity.tailscaleDnsName,
      direct_base_url: options.networkIdentity.directBaseUrl,
      ws_base_url: options.networkIdentity.wsBaseUrl,
      status: 'online' as const,
      provider_availability: ['codex'] as const,
      project_count: snapshot.projects.length,
      session_count: snapshot.sessions.length,
      transport: options.transport,
      version: options.version ?? null,
      registered_at: now,
      last_seen_at: now,
    }),
    id: options.agentId,
    name: options.agentName,
    host: options.networkIdentity.host,
    tailscale_ip: options.networkIdentity.tailscaleIp,
    tailscale_dns_name: options.networkIdentity.tailscaleDnsName,
    direct_base_url: options.networkIdentity.directBaseUrl,
    ws_base_url: options.networkIdentity.wsBaseUrl,
    status: 'online',
    project_count: snapshot.projects.length,
    session_count: snapshot.sessions.length,
    transport: options.transport,
    version: options.version ?? discoveredAgent?.version ?? null,
    registered_at: discoveredAgent?.registered_at ?? now,
    last_seen_at: now,
  }

  return {
    agent,
    projects: snapshot.projects.map((project) => ({
      ...project,
      agent_id: options.agentId,
    })),
    sessions: snapshot.sessions.map((session) => ({
      ...session,
      agent_id: options.agentId,
    })),
    active_session_id: snapshot.active_session_id,
    generated_at: snapshot.generated_at,
  }
}

const postHubSync = async (
  pathName: '/api/agents/register' | '/api/agents/heartbeat',
  payload: AgentControlPlaneSync,
  options: AgentHubSyncOptions,
) => {
  const response = await fetch(new URL(pathName, options.hubUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.hubApiKey
        ? { 'x-panda-hub-api-key': options.hubApiKey }
        : {}),
    },
    body: JSON.stringify(payload),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      (json as { error?: string } | null)?.error ??
        `${pathName} failed with ${response.status}`,
    )
  }

  return agentRegistrationResponseSchema.parse(json)
}

export const startAgentHubSync = (options: AgentHubSyncOptions) => {
  let stopped = false
  let heartbeatTimer: NodeJS.Timeout | null = null
  let heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS

  const clearHeartbeatTimer = () => {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const scheduleHeartbeat = () => {
    if (stopped) {
      return
    }

    clearHeartbeatTimer()
    heartbeatTimer = setTimeout(() => {
      void sync('heartbeat')
    }, heartbeatIntervalMs)
  }

  const sync = async (kind: 'register' | 'heartbeat') => {
    try {
      const snapshot = await readLocalSnapshot(options.localBaseUrl)
      const payload = await buildAgentSyncPayload(snapshot, options)
      const response = await postHubSync(
        kind === 'register' ? '/api/agents/register' : '/api/agents/heartbeat',
        payload,
        options,
      )
      heartbeatIntervalMs = response.heartbeat_interval_ms
      if (kind === 'register') {
        options.logger?.info?.(
          `Registered Panda agent ${options.agentId} to hub ${options.hubUrl}`,
        )
      }
    } catch (error) {
      options.logger?.warn?.(
        `Unable to ${kind === 'register' ? 'register' : 'heartbeat'} Panda agent with hub: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      scheduleHeartbeat()
    }
  }

  void sync('register')

  return {
    stop: () => {
      stopped = true
      clearHeartbeatTimer()
    },
  }
}
