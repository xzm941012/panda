import type {
  AgentNode,
  HubDirectorySnapshot,
  PhaseOneSnapshot,
  SessionLocation,
} from '@panda/protocol'
import { createClient } from '@panda/sdk'
import { agentDisplayName } from './format'
import { readSelectedAgentConnectionHint } from './session-selection'
import {
  getDefaultAgentUrl,
  readRuntimeHubUrl,
} from './runtime-config'
import { isNativeApp } from './platform'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const readAgentUrl = () => getDefaultAgentUrl()

export const readHubUrl = () => readRuntimeHubUrl()

export type ConnectionMode = 'auto' | 'direct' | 'hub'
export type ResolvedConnectionMode = Exclude<ConnectionMode, 'auto'>
export type ConnectionTargetScope = {
  sessionId?: string | null
  projectId?: string | null
  agentId?: string | null
}

const configuredMode = (
  import.meta.env.VITE_PANDA_CONNECTION_MODE ?? 'auto'
) as ConnectionMode

const clientCache = new Map<string, ReturnType<typeof createClient>>()

const labels: Record<ResolvedConnectionMode, string> = {
  direct: 'Agent 直连',
  hub: 'Hub 聚合',
}

type ConnectionTarget = ReturnType<typeof buildTarget>

const DISCOVERY_TARGET_CACHE_TTL_MS = 10_000
const ROUTED_TARGET_CACHE_TTL_MS = 10_000
const BOOTSTRAP_CACHE_TTL_MS = 10_000
const REACHABILITY_CACHE_TTL_MS = 10_000
const REACHABILITY_LOOPBACK_TIMEOUT_MS = 1_200
const REACHABILITY_REMOTE_TIMEOUT_MS = 5_000

let cachedDiscoveryTarget: ConnectionTarget | null = null
let cachedDiscoveryTargetAt = 0
let discoveryTargetPromise: Promise<ConnectionTarget> | null = null
let cachedHubDirectory: HubDirectorySnapshot | null = null
let cachedHubDirectoryAt = 0
let hubDirectoryPromise: Promise<HubDirectorySnapshot | null> | null = null
let cachedLocalBootstrapSnapshot: PhaseOneSnapshot | null = null
let cachedLocalBootstrapSnapshotAt = 0
let localBootstrapSnapshotPromise: Promise<PhaseOneSnapshot | null> | null = null

const routedTargetCache = new Map<
  string,
  {
    target: ConnectionTarget
    cachedAt: number
  }
>()
const routedTargetPromiseCache = new Map<string, Promise<ConnectionTarget>>()
const reachabilityCache = new Map<
  string,
  {
    reachable: boolean
    checkedAt: number
  }
>()

const getScopeValue = (value: string | null | undefined) => value?.trim() ?? ''

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

const isLoopbackHostname = (value: string | null | undefined) =>
  LOOPBACK_HOSTS.has(normalizeHostname(value))

const normalizeUrlHost = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
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

const isCurrentBrowserOnLoopback = () => {
  if (typeof window === 'undefined') {
    return false
  }

  if (isNativeApp()) {
    return false
  }

  return isLoopbackHostname(window.location.hostname)
}

const getReachabilityTimeoutMs = (baseUrl: string) => {
  const normalized = baseUrl.trim()
  if (!normalized) {
    return REACHABILITY_LOOPBACK_TIMEOUT_MS
  }

  try {
    const parsed = new URL(normalized)
    return isLoopbackHostname(parsed.hostname)
      ? REACHABILITY_LOOPBACK_TIMEOUT_MS
      : REACHABILITY_REMOTE_TIMEOUT_MS
  } catch {
    return REACHABILITY_REMOTE_TIMEOUT_MS
  }
}

const isBackendReachable = async (baseUrl: string) => {
  const normalizedBaseUrl = baseUrl.trim()
  if (!normalizedBaseUrl) {
    return false
  }

  const cached = reachabilityCache.get(normalizedBaseUrl)
  const now = Date.now()
  if (cached && now - cached.checkedAt < REACHABILITY_CACHE_TTL_MS) {
    return cached.reachable
  }

  const controller = new AbortController()
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    getReachabilityTimeoutMs(normalizedBaseUrl),
  )

  try {
    const response = await fetch(`${normalizedBaseUrl}/health`, {
      signal: controller.signal,
    })
    const reachable = response.ok
    reachabilityCache.set(normalizedBaseUrl, {
      reachable,
      checkedAt: Date.now(),
    })
    return reachable
  } catch {
    reachabilityCache.set(normalizedBaseUrl, {
      reachable: false,
      checkedAt: Date.now(),
    })
    return false
  } finally {
    clearTimeout(timeout)
  }
}

const getCachedClient = (baseUrl: string, wsBaseUrl?: string) => {
  const cacheKey = `${baseUrl}::${wsBaseUrl?.trim() ?? ''}`
  const cachedClient = clientCache.get(cacheKey)
  if (cachedClient) {
    return cachedClient
  }

  const nextClient = createClient(baseUrl, {
    wsBaseUrl,
  })
  clientCache.set(cacheKey, nextClient)
  return nextClient
}

export const getHubClient = () => getCachedClient(getRequiredHubUrl())

export const patchCachedHubDirectory = (
  updater: (current: HubDirectorySnapshot | null) => HubDirectorySnapshot | null,
) => {
  const nextDirectory = updater(cachedHubDirectory)
  cachedHubDirectory = nextDirectory
  cachedHubDirectoryAt = nextDirectory ? Date.now() : 0
}

const buildDirectTarget = (
  label: string,
  baseUrl: string,
  wsBaseUrl?: string,
): ConnectionTarget => ({
  mode: 'direct',
  label,
  baseUrl,
  client: getCachedClient(baseUrl, wsBaseUrl),
})

const getRequiredHubUrl = () => {
  const hubUrl = readHubUrl()
  if (!hubUrl) {
    throw new Error('尚未配置 Panda Hub 地址，请先完成应用连接设置。')
  }

  return hubUrl
}

const buildTarget = (mode: ResolvedConnectionMode) => {
  const baseUrl = mode === 'hub' ? getRequiredHubUrl() : readAgentUrl()
  return {
    mode,
    label: labels[mode],
    baseUrl,
    client: getCachedClient(baseUrl),
  }
}

const getAgentDirectBaseUrl = (agent: AgentNode) =>
  normalizeUrlHost(agent.direct_base_url)

const getAgentWsBaseUrl = (agent: AgentNode) =>
  normalizeUrlHost(agent.ws_base_url)

const buildScopedConnectionError = (agent: AgentNode) => {
  const targetAddress =
    getAgentDirectBaseUrl(agent) ||
    agent.tailscale_dns_name ||
    agent.tailscale_ip ||
    agent.host
  return `无法直连节点 ${agentDisplayName(agent)}（${targetAddress}）。请确认当前浏览器已加入 Tailscale 网络，且目标 agent 在线。`
}

const readLocalDirectBootstrapSnapshot = async () => {
  if (!isCurrentBrowserOnLoopback()) {
    return null
  }

  const now = Date.now()
  if (
    cachedLocalBootstrapSnapshot &&
    now - cachedLocalBootstrapSnapshotAt < BOOTSTRAP_CACHE_TTL_MS
  ) {
    return cachedLocalBootstrapSnapshot
  }

  if (localBootstrapSnapshotPromise) {
    return localBootstrapSnapshotPromise
  }

  localBootstrapSnapshotPromise = (async () => {
    const agentUrl = readAgentUrl()
    if (!(await isBackendReachable(agentUrl))) {
      return null
    }

    const snapshot = await getCachedClient(agentUrl).getPhaseOneSnapshot({
      fallbackToMock: false,
    })
    cachedLocalBootstrapSnapshot = snapshot
    cachedLocalBootstrapSnapshotAt = Date.now()
    return snapshot
  })().catch(() => null)

  try {
    return await localBootstrapSnapshotPromise
  } finally {
    localBootstrapSnapshotPromise = null
  }
}

const shouldUseLoopbackDirectTarget = async (agentId: string) => {
  const snapshot = await readLocalDirectBootstrapSnapshot()
  const localAgentId = snapshot?.agents[0]?.id?.trim() ?? ''
  return Boolean(localAgentId && localAgentId === agentId.trim())
}

const buildScopedDirectTarget = async (
  agent: AgentNode,
): Promise<ConnectionTarget> => {
  if (await shouldUseLoopbackDirectTarget(agent.id)) {
    return {
      ...buildTarget('direct'),
      label: `Agent 直连 · ${agentDisplayName(agent)}（本机）`,
    }
  }

  const baseUrl = getAgentDirectBaseUrl(agent)
  const wsBaseUrl = getAgentWsBaseUrl(agent)
  return buildDirectTarget(
    `Agent 直连 · ${agentDisplayName(agent)}`,
    baseUrl,
    wsBaseUrl || undefined,
  )
}

const buildSessionScopedDirectTarget = async (
  location: SessionLocation,
): Promise<ConnectionTarget> => {
  if (await shouldUseLoopbackDirectTarget(location.agent_id)) {
    return {
      ...buildTarget('direct'),
      label: `Agent 直连 · ${location.agent_id}（本机）`,
    }
  }

  const baseUrl = normalizeUrlHost(location.direct_base_url)
  const wsBaseUrl = normalizeUrlHost(location.ws_base_url)
  return buildDirectTarget(
    `Agent 直连 · ${location.agent_id}`,
    baseUrl,
    wsBaseUrl || undefined,
  )
}

const readScopedAgentConnectionHint = (scope: ConnectionTargetScope) => {
  const scopedAgentId = getScopeValue(scope.agentId)
  if (!scopedAgentId) {
    return null
  }

  const hint = readSelectedAgentConnectionHint(scopedAgentId)
  if (!hint?.directBaseUrl.trim()) {
    return null
  }

  return buildDirectTarget(
    `Agent 直连 · ${hint.displayName?.trim() || hint.name.trim() || scopedAgentId}`,
    normalizeUrlHost(hint.directBaseUrl),
    normalizeUrlHost(hint.wsBaseUrl) || undefined,
  )
}

const tryResolveAgentScopedTarget = async (
  scope: ConnectionTargetScope,
): Promise<ConnectionTarget | null> => {
  const hintedTarget = readScopedAgentConnectionHint(scope)
  if (
    hintedTarget?.baseUrl &&
    ((await isBackendReachable(hintedTarget.baseUrl)) ||
      !isCurrentBrowserOnLoopback())
  ) {
    return hintedTarget
  }

  const directory = await readHubDirectory()
  const scopedAgent = directory ? findAgentByScope(directory, scope) : null
  if (!scopedAgent) {
    return null
  }

  const directTarget = await buildScopedDirectTarget(scopedAgent)
  if (!directTarget.baseUrl) {
    return null
  }

  if (
    (await isBackendReachable(directTarget.baseUrl)) ||
    !isCurrentBrowserOnLoopback()
  ) {
    return directTarget
  }

  return null
}

const findAgentByScope = (
  directory: HubDirectorySnapshot,
  scope: ConnectionTargetScope,
) => {
  const scopedAgentId = getScopeValue(scope.agentId)
  if (scopedAgentId) {
    return directory.agents.find((agent) => agent.id === scopedAgentId) ?? null
  }

  return null
}

const getScopeCacheKey = (scope: ConnectionTargetScope) => {
  const sessionId = getScopeValue(scope.sessionId)
  const projectId = getScopeValue(scope.projectId)
  const agentId = getScopeValue(scope.agentId)
  if (agentId) {
    return `agent:${agentId}`
  }
  if (projectId) {
    return `project:${projectId}`
  }
  if (sessionId) {
    return `session:${sessionId}`
  }

  return ''
}

const readHubDirectory = async () => {
  const now = Date.now()
  if (
    cachedHubDirectory &&
    now - cachedHubDirectoryAt < BOOTSTRAP_CACHE_TTL_MS
  ) {
    return cachedHubDirectory
  }

  if (hubDirectoryPromise) {
    return hubDirectoryPromise
  }

  hubDirectoryPromise = (async () => {
    const hubUrl = readHubUrl()
    if (!hubUrl) {
      return null
    }

    const directory = await getCachedClient(hubUrl).getHubDirectory()
    cachedHubDirectory = directory
    cachedHubDirectoryAt = Date.now()
    return directory
  })().catch(() => null)

  try {
    return await hubDirectoryPromise
  } finally {
    hubDirectoryPromise = null
  }
}

const resolveDiscoveryTarget = async () => {
  if (!isCurrentBrowserOnLoopback()) {
    return buildTarget('hub')
  }

  const now = Date.now()
  if (
    cachedDiscoveryTarget &&
    now - cachedDiscoveryTargetAt < DISCOVERY_TARGET_CACHE_TTL_MS
  ) {
    return cachedDiscoveryTarget
  }

  if (discoveryTargetPromise) {
    return discoveryTargetPromise
  }

  discoveryTargetPromise = (async () => {
    const hubUrl = readHubUrl()
    const nextTarget =
      hubUrl && (await isBackendReachable(hubUrl))
        ? buildTarget('hub')
        : buildTarget('direct')
    cachedDiscoveryTarget = nextTarget
    cachedDiscoveryTargetAt = Date.now()
    return nextTarget
  })()

  try {
    return await discoveryTargetPromise
  } finally {
    discoveryTargetPromise = null
  }
}

const resolveScopedAutoTarget = async (
  scope: ConnectionTargetScope,
): Promise<ConnectionTarget> => {
  const scopeCacheKey = getScopeCacheKey(scope)
  const now = Date.now()
  const cachedTarget = scopeCacheKey ? routedTargetCache.get(scopeCacheKey) : null
  if (cachedTarget && now - cachedTarget.cachedAt < ROUTED_TARGET_CACHE_TTL_MS) {
    return cachedTarget.target
  }

  const cachedPromise = scopeCacheKey
    ? routedTargetPromiseCache.get(scopeCacheKey)
    : null
  if (cachedPromise) {
    return cachedPromise
  }

  const targetPromise = (async () => {
    const scopedSessionId = getScopeValue(scope.sessionId)
    const scopedAgentId = getScopeValue(scope.agentId)
    const hintedTarget = readScopedAgentConnectionHint(scope)
    const hubUrl = readHubUrl()

    if (!hubUrl && !hintedTarget && !scopedAgentId) {
      throw new Error('尚未配置 Panda Hub 地址，请先完成应用连接设置。')
    }

    const hubClient = hubUrl ? getCachedClient(hubUrl) : null

    if (scopedAgentId) {
      const directAgentTarget = await tryResolveAgentScopedTarget(scope)
      if (directAgentTarget) {
        return directAgentTarget
      }
    }

    if (scopedSessionId) {
      const location = hubClient
        ? await hubClient.getSessionLocation(scopedSessionId).catch(() => null)
        : null
      if (!location) {
        const fallbackTarget = scopedAgentId
          ? await tryResolveAgentScopedTarget(scope)
          : null
        if (fallbackTarget) {
          return fallbackTarget
        }
        throw new Error('Hub 未返回目标会话位置，无法建立直连。')
      }
      const directTarget = await buildSessionScopedDirectTarget(location)
      if (!directTarget.baseUrl) {
        throw new Error(
          `无法直连节点 ${location.agent_id}（${location.direct_base_url || location.ws_base_url || 'unknown'}）。请确认当前浏览器已加入 Tailscale 网络，且目标 agent 在线。`,
        )
      }

      if (
        (await isBackendReachable(directTarget.baseUrl)) ||
        !isCurrentBrowserOnLoopback()
      ) {
        return directTarget
      }

      throw new Error(
        `无法直连节点 ${location.agent_id}（${location.direct_base_url || location.ws_base_url || 'unknown'}）。请确认当前浏览器已加入 Tailscale 网络，且目标 agent 在线。`,
      )
    }

    if (getScopeValue(scope.projectId) && !getScopeValue(scope.agentId)) {
      throw new Error('Project-scoped connection resolution now requires agentId.')
    }

    const directory = await readHubDirectory()
    const scopedAgent = directory ? findAgentByScope(directory, scope) : null
    if (!scopedAgent) {
      throw new Error('Hub 未返回目标节点信息，无法建立直连。')
    }

    const directTarget = await buildScopedDirectTarget(scopedAgent)
    if (!directTarget.baseUrl) {
      throw new Error(buildScopedConnectionError(scopedAgent))
    }

    if (
      (await isBackendReachable(directTarget.baseUrl)) ||
      !isCurrentBrowserOnLoopback()
    ) {
      return directTarget
    }

    throw new Error(buildScopedConnectionError(scopedAgent))
  })()

  if (scopeCacheKey) {
    routedTargetPromiseCache.set(scopeCacheKey, targetPromise)
  }

  try {
    const resolvedTarget = await targetPromise
    if (scopeCacheKey) {
      routedTargetCache.set(scopeCacheKey, {
        target: resolvedTarget,
        cachedAt: Date.now(),
      })
    }
    return resolvedTarget
  } finally {
    if (scopeCacheKey) {
      routedTargetPromiseCache.delete(scopeCacheKey)
    }
  }
}

export const resolveConnectionTarget = async (
  scope?: ConnectionTargetScope,
) => {
  if (configuredMode === 'direct') {
    return buildTarget('direct')
  }

  if (configuredMode === 'hub') {
    return buildTarget('hub')
  }

  const hasScope = Boolean(
    getScopeValue(scope?.sessionId) ||
      getScopeValue(scope?.projectId) ||
      getScopeValue(scope?.agentId),
  )

  if (!hasScope) {
    return resolveDiscoveryTarget()
  }

  return resolveScopedAutoTarget(scope ?? {})
}

export const getConfiguredConnectionMode = () => configuredMode

export const resetConnectionTargetCaches = () => {
  cachedDiscoveryTarget = null
  cachedDiscoveryTargetAt = 0
  discoveryTargetPromise = null
  cachedHubDirectory = null
  cachedHubDirectoryAt = 0
  hubDirectoryPromise = null
  cachedLocalBootstrapSnapshot = null
  cachedLocalBootstrapSnapshotAt = 0
  localBootstrapSnapshotPromise = null
  routedTargetCache.clear()
  routedTargetPromiseCache.clear()
  reachabilityCache.clear()
}
