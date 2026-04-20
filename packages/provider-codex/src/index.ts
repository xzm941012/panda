import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentNode,
  ProjectRef,
  SessionCapability,
  SessionContextUsage,
  SessionSubagent,
  SessionRef,
  TimelineEntry,
} from '@panda/protocol'
import {
  areMergeableAssistantEntries,
  choosePreferredAssistantEntry,
} from './assistant-entry-dedupe'
import { stripInjectedUserText } from './injected-user-text'
import { parseMessageContent } from './message-content'

type DraftTimelineEntry = Omit<
  TimelineEntry,
  'id' | 'attachments' | 'body_truncated' | 'detail_available' | 'patch_summary' | 'session_ids'
> & {
  attachments?: TimelineEntry['attachments']
  body_truncated?: TimelineEntry['body_truncated']
  detail_available?: TimelineEntry['detail_available']
  patch_summary?: TimelineEntry['patch_summary']
  session_ids?: TimelineEntry['session_ids']
}
export {
  appendSessionIndexUpdate,
  deleteRolloutFile,
  getOrderedWorkspaceRoots,
  getPinnedSessionIds,
  getPinnedWorkspaceRoots,
  getSavedWorkspaceRoots,
  moveRolloutFileFromArchived,
  moveRolloutFileToArchived,
  getWorkspaceRootLabels,
  isWithinWorkspaceRoot,
  normalizeWorkspacePathKey,
  readCodexGlobalState,
  readPandaSessionPrefs,
  readPandaThreadPrefs,
  setSessionPinned,
  setWorkspaceRootLabel,
  setWorkspaceRootOrder,
  setWorkspaceRootPinned,
  setWorkspaceRootVisibility,
  sortByStoredWorkspaceOrder,
  writeCodexGlobalState,
  writePandaSessionPrefs,
  writePandaThreadPrefs,
} from './codex-state'
import {
  getOrderedWorkspaceRoots,
  getPinnedSessionIds,
  getPinnedWorkspaceRoots,
  getSavedWorkspaceRoots,
  getWorkspaceRootLabels,
  readCodexGlobalState,
  readPandaSessionPrefs,
  readPandaThreadPrefs,
  sortByStoredWorkspaceOrder,
} from './codex-state'
export { createCodexRolloutMonitor, type CodexRolloutMonitorEvent } from './rollout-monitor'
export {
  createCodexLiveSessionStream,
  type CodexLiveSessionEvent,
  type CodexLiveSessionStream,
  type CodexSessionPatch,
} from './live-session-stream'
export {
  startPandaSessionService,
  type PandaSessionServiceOptions,
} from './panda-session-service'
export {
  ensurePandaHubApiKey,
  getPandaHubApiKeyFilePath,
  resolvePandaHubApiKey,
  type HubApiKeyLogger,
  type ResolvedPandaHubApiKey,
} from './hub-api-key'
export {
  buildAgentServiceBaseUrl,
  resolveAgentEndpointLabel,
  resolveDefaultAgentId,
  resolveAgentGroupHost,
  resolveAgentNetworkIdentity,
  startAgentHubSync,
  type AgentHubSyncOptions,
  type AgentNetworkIdentity,
} from './agent-hub-sync'
export {
  buildTailscaleHttpsUrl,
  configureTailscaleServe,
  isTailscaleRunning,
  resolveCliOptionValue,
  readTailscaleStatus,
  resolveTailscalePublicationMode,
  resolveTailscaleServeEnabled,
  resolveTailscaleServePort,
  type ConfiguredTailscaleServe,
  type TailscalePublicationMode,
  type TailscaleStatusJson,
} from './tailscale'
export { printTerminalQr } from './terminal-qr'

const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const LIVE_WINDOW_MS = 30 * 60 * 1000
const IDLE_WINDOW_MS = 24 * 60 * 60 * 1000
const FIRST_LINE_READ_LIMIT = 256 * 1024
const TITLE_CANDIDATE_READ_LIMIT = 128 * 1024
const DISCOVERED_TITLE_MAX_LENGTH = 72
const TOOL_OUTPUT_LIMIT = 1400
const COMPLETED_STATE_TTL_MS = 3 * 60 * 1000

type SessionIndexRecord = {
  id: string
  thread_name?: string
  updated_at?: string
}

type SessionMetaPayload = {
  id?: string
  cwd?: string
  timestamp?: string
  forked_from_id?: string
  agent_nickname?: string
  agent_role?: string
  source?:
    | string
    | {
        subagent?: {
          thread_spawn?: {
            parent_thread_id?: string
            depth?: number
            agent_nickname?: string
            agent_role?: string
          }
        }
      }
}

type RolloutRecord = {
  sessionId: string
  filePath: string
  cwd: string
  updatedAt: string
  title: string
  archived: boolean
  subagent: SessionSubagent | null
}

type CodexSessionRunState = 'idle' | 'running' | 'completed'
type SessionRunStateFields = {
  run_state: CodexSessionRunState
  run_state_changed_at: string | null
}
type SessionWithRunState = SessionRef & SessionRunStateFields

export interface CodexTimelineDetails {
  entries: TimelineEntry[]
  runState: CodexSessionRunState
  runStateChangedAt: string | null
  contextUsage: SessionContextUsage | null
}

export interface ProviderAdapter {
  discoverProjects(): Promise<ProjectRef[]>
  discoverSessions(): Promise<SessionRef[]>
  getSessionCapabilities(sessionId: string): Promise<SessionCapability | null>
  createManagedSession(prompt: string): Promise<{ sessionId: string; accepted: boolean }>
  sendUserInput(sessionId: string, input: string): Promise<void>
  interruptTurn(sessionId: string): Promise<void>
}

export interface CodexDiscoveryOptions {
  agentId?: string
  agentName?: string
  codexHome?: string
  host?: string
  tailscaleIp?: string | null
  tailscaleDnsName?: string | null
  directBaseUrl?: string | null
  wsBaseUrl?: string | null
  version?: string | null
  registeredAt?: string | null
  lastSeenAt?: string | null
  maxSessions?: number
  transport?: AgentNode['transport']
}

export interface CodexDiscoveryResult {
  agent: AgentNode
  projects: ProjectRef[]
  sessions: SessionRef[]
  activeSessionId: string
  sessionFiles: Record<string, string>
}

const stableId = (prefix: string, value: string) =>
  `${prefix}-${createHash('sha1').update(value).digest('hex').slice(0, 12)}`

const normalizePathKey = (value: string) => {
  const normalized = path.normalize(value.trim())
  return process.platform === 'win32'
    ? normalized.replace(/\//g, '\\').toLowerCase()
    : normalized
}

const basenameFromPath = (targetPath: string) => {
  const normalized = targetPath.replace(/[\\/]+$/, '')
  return path.basename(normalized) || normalized
}

const pickNewestTimestamp = (...candidates: Array<string | undefined | null>) => {
  let newestValue: string | null = null
  let newestTime = Number.NEGATIVE_INFINITY

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue
    }

    const candidateTime = new Date(candidate).getTime()
    if (!Number.isFinite(candidateTime) || candidateTime <= newestTime) {
      continue
    }

    newestTime = candidateTime
    newestValue = candidate
  }

  return newestValue
}

const truncateText = (value: string, length: number) => {
  const trimmed = value.trim()
  if (trimmed.length <= length) {
    return trimmed
  }

  return `${trimmed.slice(0, length - 1).trimEnd()}…`
}

const normalizeConversationRole = (role: string | undefined) => {
  if (role === 'user') {
    return {
      kind: 'user' as const,
      title: 'user',
      accent: 'primary' as const,
    }
  }

  if (role === 'assistant') {
    return {
      kind: 'assistant' as const,
      title: 'assistant',
      accent: 'secondary' as const,
    }
  }

  if (role === 'system') {
    return {
      kind: 'system' as const,
      title: 'system',
      accent: 'muted' as const,
    }
  }

  if (role === 'developer') {
    return {
      kind: 'system' as const,
      title: 'system_prompt',
      accent: 'muted' as const,
    }
  }

  return null
}

const parseSessionContextUsage = (
  info: unknown,
  timestamp: string,
): SessionContextUsage | null => {
  if (!info || typeof info !== 'object') {
    return null
  }

  const usageInfo = info as {
    last_token_usage?: {
      input_tokens?: number
      cached_input_tokens?: number
      output_tokens?: number
      reasoning_output_tokens?: number
      total_tokens?: number
    }
    total_token_usage?: {
      input_tokens?: number
      cached_input_tokens?: number
      output_tokens?: number
      reasoning_output_tokens?: number
      total_tokens?: number
    }
    model_context_window?: number
  }

  const preferredUsage =
    usageInfo.last_token_usage &&
    typeof usageInfo.last_token_usage === 'object'
      ? usageInfo.last_token_usage
      : usageInfo.total_token_usage
  const fallbackUsage = usageInfo.total_token_usage ?? usageInfo.last_token_usage
  const totalTokens =
    preferredUsage?.total_tokens ??
    fallbackUsage?.total_tokens
  const totalContextWindow = usageInfo.model_context_window
  if (
    typeof totalTokens !== 'number' ||
    !Number.isFinite(totalTokens) ||
    typeof totalContextWindow !== 'number' ||
    !Number.isFinite(totalContextWindow) ||
    totalContextWindow <= 0
  ) {
    return null
  }

  const usedTokens = Math.max(0, Math.round(totalTokens))
  const totalWindow = Math.max(usedTokens, Math.round(totalContextWindow))
  const remainingTokens = Math.max(0, totalWindow - usedTokens)

  return {
    used_tokens: usedTokens,
    total_tokens: totalWindow,
    remaining_tokens: remainingTokens,
    percent_used: Math.max(0, Math.min(100, (usedTokens / totalWindow) * 100)),
    cached_input_tokens: Math.max(
      0,
      Math.round(
        preferredUsage?.cached_input_tokens ??
          fallbackUsage?.cached_input_tokens ??
          0,
      ),
    ),
    output_tokens: Math.max(
      0,
      Math.round(
        preferredUsage?.output_tokens ??
          fallbackUsage?.output_tokens ??
          0,
      ),
    ),
    reasoning_output_tokens: Math.max(
      0,
      Math.round(
        preferredUsage?.reasoning_output_tokens ??
          fallbackUsage?.reasoning_output_tokens ??
          0,
      ),
    ),
    updated_at: timestamp,
  }
}

const defaultCodexHome = () => path.join(os.homedir(), '.codex')

const isWithinWorkspaceRoots = (cwd: string, workspaceRoots: string[]) => {
  if (workspaceRoots.length === 0) {
    return true
  }

  const normalizedCwd = normalizePathKey(cwd)
  return workspaceRoots.some((root) => {
    if (normalizedCwd === root) {
      return true
    }

    const separator = process.platform === 'win32' ? '\\' : '/'
    return normalizedCwd.startsWith(`${root}${separator}`)
  })
}

const resolveHostAddress = (providedHost?: string) => {
  if (providedHost) {
    return providedHost
  }

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

const readFirstLine = async (filePath: string) => {
  const handle = await fs.open(filePath, 'r')
  try {
    const chunks: string[] = []
    let bytesReadTotal = 0
    let position = 0

    while (bytesReadTotal < FIRST_LINE_READ_LIMIT) {
      const buffer = Buffer.alloc(8192)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) {
        break
      }

      const text = buffer.toString('utf8', 0, bytesRead)
      const newlineIndex = text.indexOf('\n')

      if (newlineIndex >= 0) {
        chunks.push(text.slice(0, newlineIndex))
        break
      }

      chunks.push(text)
      bytesReadTotal += bytesRead
      position += bytesRead
    }

    return chunks.join('').trim()
  } finally {
    await handle.close()
  }
}

const readInitialChunk = async (filePath: string, limit: number) => {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

const readJsonLines = async (filePath: string) => {
  const content = await fs.readFile(filePath, 'utf8')
  const lines = content.split(/\r?\n/).filter(Boolean)
  const records: Array<{ timestamp?: string; type?: string; payload?: any }> = []

  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      continue
    }
  }

  return records
}

const loadSessionIndex = async (codexHome: string) => {
  const result = new Map<string, SessionIndexRecord>()
  const filePath = path.join(codexHome, 'session_index.jsonl')

  try {
    const content = await fs.readFile(filePath, 'utf8')
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as SessionIndexRecord
        if (parsed?.id) {
          result.set(parsed.id, parsed)
        }
      } catch {
        continue
      }
    }
  } catch {
    return result
  }

  return result
}

const walkRolloutFiles = async (rootPath: string): Promise<string[]> => {
  let entries
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkRolloutFiles(fullPath))
      continue
    }

    if (entry.isFile() && fullPath.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }

  return files
}

const normalizeDiscoveredTitle = (value: string) => {
  const normalized = stripInjectedUserText(value).replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  if (normalized.length <= DISCOVERED_TITLE_MAX_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, DISCOVERED_TITLE_MAX_LENGTH - 1).trimEnd()}…`
}

const extractDiscoveredUserTitleFromMessage = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const message = payload as {
    type?: unknown
    role?: unknown
    content?: unknown
  }
  if (message.type !== 'message' || message.role !== 'user' || !Array.isArray(message.content)) {
    return ''
  }

  return normalizeDiscoveredTitle(parseMessageContent(message.content).text)
}

const readDiscoveredTitleFromRollout = async (filePath: string) => {
  try {
    const content = await readInitialChunk(filePath, TITLE_CANDIDATE_READ_LIMIT)
    const lines = content.split(/\r?\n/)

    for (const line of lines) {
      if (!line.trim()) {
        continue
      }

      try {
        const parsed = JSON.parse(line) as {
          type?: unknown
          payload?: unknown
        }
        if (parsed.type !== 'response_item') {
          continue
        }

        const candidate = extractDiscoveredUserTitleFromMessage(parsed.payload)
        if (candidate) {
          return candidate
        }
      } catch {
        continue
      }
    }
  } catch {
    return ''
  }

  return ''
}

const extractReasoningSummary = (summary: unknown) => {
  if (!Array.isArray(summary)) {
    return ''
  }

  return summary
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return ''
      }

      const candidate = item as { type?: string; text?: string }
      if (candidate.type === 'summary_text' && typeof candidate.text === 'string') {
        return candidate.text.trim()
      }

      return ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

const truncateOutput = (value: string, maxLength: number) => {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) {
    return trimmed
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`
}

const safeJsonPreview = (value: unknown) => {
  if (typeof value === 'string') {
    return truncateOutput(value, TOOL_OUTPUT_LIMIT)
  }

  try {
    return truncateOutput(JSON.stringify(value, null, 2), TOOL_OUTPUT_LIMIT)
  } catch {
    return ''
  }
}

const normalizeRunState = (
  runState: CodexSessionRunState,
  changedAt: string | null,
  lastActivityAt?: string | null,
): SessionRunStateFields => {
  const freshestRunningAt = Math.max(
    changedAt ? new Date(changedAt).getTime() : Number.NaN,
    lastActivityAt ? new Date(lastActivityAt).getTime() : Number.NaN,
  )

  if (
    runState === 'running' &&
    (!Number.isFinite(freshestRunningAt) || Date.now() - freshestRunningAt > ACTIVE_WINDOW_MS)
  ) {
    return {
      run_state: 'idle',
      run_state_changed_at: null,
    }
  }

  if (
    runState === 'completed' &&
    changedAt &&
    Date.now() - new Date(changedAt).getTime() > COMPLETED_STATE_TTL_MS
  ) {
    return {
      run_state: 'idle',
      run_state_changed_at: null,
    }
  }

  return {
    run_state: runState,
    run_state_changed_at: changedAt,
  }
}

const buildSessionCapability = (isLive: boolean, archived: boolean): SessionCapability => ({
  can_stream_live: archived ? false : isLive,
  can_send_input: !archived,
  can_interrupt: !archived,
  can_approve: archived ? false : isLive,
  can_reject: archived ? false : isLive,
  can_show_git: true,
  can_show_terminal: !archived,
})

const deriveSessionHealth = (updatedAt: string, archived: boolean): SessionRef['health'] => {
  if (archived) {
    return 'offline'
  }

  const diff = Date.now() - new Date(updatedAt).getTime()
  if (diff <= ACTIVE_WINDOW_MS) {
    return 'active'
  }

  if (diff <= IDLE_WINDOW_MS) {
    return 'idle'
  }

  return 'offline'
}

const deriveSessionMode = (updatedAt: string, archived: boolean): SessionRef['mode'] =>
  archived
    ? 'history-only'
    : Date.now() - new Date(updatedAt).getTime() <= LIVE_WINDOW_MS
      ? 'attached-live'
      : 'history-only'

const gitInfoCache = new Map<string, { branch: string; worktree: string }>()

const readGitInfo = (cwd: string) => {
  const cacheKey = normalizePathKey(cwd)
  const cached = gitInfoCache.get(cacheKey)
  if (cached) {
    return cached
  }

  try {
    const topLevel = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim()
    const branch = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    ).trim()
    const info = {
      branch: branch || 'unknown',
      worktree:
        normalizePathKey(topLevel) === normalizePathKey(cwd)
          ? 'default'
          : basenameFromPath(cwd),
    }

    gitInfoCache.set(cacheKey, info)
    return info
  } catch {
    const info = {
      branch: 'unknown',
      worktree: 'default',
    }
    gitInfoCache.set(cacheKey, info)
    return info
  }
}

const summarizeTimeline = (entries: TimelineEntry[]) => {
  const candidate = [...entries]
    .reverse()
    .find((entry) => entry.kind === 'assistant' || entry.kind === 'user')

  return candidate ? truncateText(candidate.body, 88) : ''
}

const parseSessionSubagent = (payload?: SessionMetaPayload): SessionSubagent | null => {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const threadSpawn =
    payload.source && typeof payload.source === 'object'
      ? payload.source.subagent?.thread_spawn
      : undefined
  const parentSessionId =
    typeof threadSpawn?.parent_thread_id === 'string' &&
    threadSpawn.parent_thread_id.trim()
      ? threadSpawn.parent_thread_id.trim()
      : typeof payload.forked_from_id === 'string' && payload.forked_from_id.trim()
        ? payload.forked_from_id.trim()
        : ''

  if (!parentSessionId) {
    return null
  }

  const nickname =
    typeof threadSpawn?.agent_nickname === 'string' && threadSpawn.agent_nickname.trim()
      ? threadSpawn.agent_nickname.trim()
      : typeof payload.agent_nickname === 'string' && payload.agent_nickname.trim()
        ? payload.agent_nickname.trim()
        : null
  const role =
    typeof threadSpawn?.agent_role === 'string' && threadSpawn.agent_role.trim()
      ? threadSpawn.agent_role.trim()
      : typeof payload.agent_role === 'string' && payload.agent_role.trim()
        ? payload.agent_role.trim()
        : null
  const depth =
    typeof threadSpawn?.depth === 'number' && Number.isFinite(threadSpawn.depth)
      ? Math.max(0, Math.round(threadSpawn.depth))
      : 1
  const rootSessionId =
    typeof payload.forked_from_id === 'string' && payload.forked_from_id.trim()
      ? payload.forked_from_id.trim()
      : parentSessionId

  return {
    parent_session_id: parentSessionId,
    root_session_id: rootSessionId,
    nickname,
    role,
    depth,
  }
}

const readRolloutRecord = async (
  filePath: string,
  sessionIndex: Map<string, SessionIndexRecord>,
  archived: boolean,
): Promise<RolloutRecord | null> => {
  const firstLine = await readFirstLine(filePath)
  if (!firstLine) {
    return null
  }

  try {
    const parsed = JSON.parse(firstLine) as {
      payload?: SessionMetaPayload
    }
    const sessionId = parsed.payload?.id
    const cwd = parsed.payload?.cwd
    if (!sessionId || !cwd) {
      return null
    }

    const stat = await fs.stat(filePath)
    const indexed = sessionIndex.get(sessionId)
    const indexedTitle = indexed?.thread_name?.trim() ?? ''
    const updatedAt =
      pickNewestTimestamp(
        indexed?.updated_at,
        stat.mtime.toISOString(),
        parsed.payload?.timestamp,
      ) ?? stat.mtime.toISOString()
    const discoveredTitle = indexedTitle || await readDiscoveredTitleFromRollout(filePath)

    return {
      sessionId,
      filePath,
      cwd,
      updatedAt,
      archived,
      subagent: parseSessionSubagent(parsed.payload),
      title:
        discoveredTitle ||
        `${basenameFromPath(cwd)} ${new Date(updatedAt).toLocaleString('zh-CN')}`,
    }
  } catch {
    return null
  }
}

export const readCodexTimelineDetails = async (
  sessionId: string,
  options?: { codexHome?: string; sessionFiles?: Record<string, string> },
): Promise<CodexTimelineDetails> => {
  const codexHome = options?.codexHome ?? defaultCodexHome()
  let filePath = options?.sessionFiles?.[sessionId]

  if (!filePath) {
    const sessionIndex = await loadSessionIndex(codexHome)
    const [files, archivedFiles] = await Promise.all([
      walkRolloutFiles(path.join(codexHome, 'sessions')),
      walkRolloutFiles(path.join(codexHome, 'archived_sessions')),
    ])

    for (const [candidate, archived] of [
      ...files.map((candidate) => [candidate, false] as const),
      ...archivedFiles.map((candidate) => [candidate, true] as const),
    ]) {
      const record = await readRolloutRecord(candidate, sessionIndex, archived)
      if (record?.sessionId === sessionId) {
        filePath = candidate
        break
      }
    }
  }

  if (!filePath) {
    return {
      entries: [],
      runState: 'idle',
      runStateChangedAt: null,
      contextUsage: null,
    }
  }

  const records = await readJsonLines(filePath)
  const entries: TimelineEntry[] = []
  let sessionMeta: { timestamp?: string; cwd?: string; originator?: string } | null = null
  let lastRunState: CodexSessionRunState = 'idle'
  let lastRunStateChangedAt: string | null = null
  let lastActivityAt: string | null = null
  let contextUsage: SessionContextUsage | null = null
  const pushEntry = (entry: DraftTimelineEntry) => {
    const previous = entries[entries.length - 1]
    if (areMergeableAssistantEntries(previous, {
      ...entry,
      attachments: entry.attachments ?? [],
    })) {
      entries[entries.length - 1] = choosePreferredAssistantEntry(previous!, entry)
      return
    }

    const nextEntry: TimelineEntry = {
      id: `${sessionId}-${entries.length + 1}`,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      body_truncated: entry.body_truncated ?? false,
      detail_available: entry.detail_available ?? false,
      patch_summary: entry.patch_summary ?? null,
      session_ids: entry.session_ids ?? [],
      timestamp: entry.timestamp,
      accent: entry.accent,
      attachments: entry.attachments ?? [],
    }
    entries.push(nextEntry)
  }

  for (const record of records) {
    if (typeof record.timestamp === 'string' && record.timestamp.trim()) {
      lastActivityAt = record.timestamp
    }

    if (record.type === 'session_meta') {
      sessionMeta = {
        timestamp: record.timestamp ?? record.payload?.timestamp,
        cwd: record.payload?.cwd,
        originator: record.payload?.originator,
      }
      continue
    }

    if (record.type === 'event_msg') {
      const eventType = record.payload?.type as string | undefined
      const eventTimestamp = record.timestamp ?? new Date().toISOString()

      if (eventType === 'task_started') {
        lastRunState = 'running'
        lastRunStateChangedAt = eventTimestamp
        pushEntry({
          kind: 'system',
          title: 'status',
          body: '开始处理请求',
          timestamp: eventTimestamp,
          accent: 'muted',
        })
      }

      if (eventType === 'task_complete') {
        lastRunState = 'completed'
        lastRunStateChangedAt = eventTimestamp
        pushEntry({
          kind: 'system',
          title: 'status',
          body: '处理完成',
          timestamp: eventTimestamp,
          accent: 'muted',
        })
      }

      if (eventType === 'token_count') {
        contextUsage =
          parseSessionContextUsage(record.payload?.info, eventTimestamp) ?? contextUsage
      }

      if (eventType === 'context_compacted') {
        pushEntry({
          kind: 'system',
          title: 'context_compacted',
          body: '正在自动压缩背景信息',
          timestamp: eventTimestamp,
          accent: 'muted',
        })
      }

      if (eventType === 'agent_reasoning') {
        const summary =
          typeof record.payload?.text === 'string' ? record.payload.text.trim() : ''
        if (summary) {
          pushEntry({
            kind: 'thinking',
            title: 'thinking',
            body: summary,
            timestamp: eventTimestamp,
            accent: 'secondary',
          })
        }
      }

      if (eventType === 'agent_message') {
        const message =
          typeof record.payload?.message === 'string'
            ? record.payload.message.trim()
            : ''
        if (message) {
          pushEntry({
            kind: 'assistant',
            title:
              typeof record.payload?.phase === 'string' && record.payload.phase.trim()
                ? record.payload.phase.trim()
                : 'assistant',
            body: message,
            timestamp: eventTimestamp,
            accent: 'secondary',
          })
        }
      }

      continue
    }

    if (record.type !== 'response_item') {
      continue
    }

    const responseType = record.payload?.type as string | undefined
    const timestamp = record.timestamp ?? sessionMeta?.timestamp ?? new Date().toISOString()

    if (responseType === 'message') {
      const role = record.payload?.role as string | undefined
      const normalizedRole = normalizeConversationRole(role)
      if (!normalizedRole) {
        continue
      }

      const messageContent = parseMessageContent(record.payload?.content)
      const displayedText =
        role === 'user'
          ? stripInjectedUserText(messageContent.text)
          : messageContent.text.trim()
      if (!displayedText && messageContent.attachments.length === 0) {
        continue
      }

      pushEntry({
        kind: normalizedRole.kind,
        title: normalizedRole.title,
        body: displayedText,
        timestamp,
        accent: normalizedRole.accent,
        attachments: messageContent.attachments,
      })
      continue
    }

    if (responseType === 'reasoning') {
      const summary = extractReasoningSummary(record.payload?.summary)
      if (!summary) {
        continue
      }

      pushEntry({
        kind: 'thinking',
        title: 'thinking',
        body: summary,
        timestamp,
        accent: 'secondary',
      })
      continue
    }

    if (responseType === 'function_call') {
      const name = (record.payload?.name as string | undefined)?.trim() || 'tool'
      const argumentsPreview = safeJsonPreview(record.payload?.arguments)
      pushEntry({
        kind: 'tool',
        title: name,
        body: argumentsPreview || `调用 ${name}`,
        timestamp,
        accent: 'secondary',
      })
      continue
    }

    if (responseType === 'function_call_output') {
      const output = safeJsonPreview(record.payload?.output)
      if (!output) {
        continue
      }

      pushEntry({
        kind: 'tool',
        title: 'tool-output',
        body: output,
        timestamp,
        accent: 'muted',
      })
    }

    if (responseType === 'custom_tool_call') {
      const name = (record.payload?.name as string | undefined)?.trim() || 'tool'
      const input =
        typeof record.payload?.input === 'string'
          ? record.payload.input.trim()
          : safeJsonPreview(record.payload?.input)

      pushEntry({
        kind: 'tool',
        title: name,
        body: input || name,
        timestamp,
        accent: 'secondary',
      })
      continue
    }

    if (responseType === 'custom_tool_call_output') {
      const output =
        typeof record.payload?.output === 'string'
          ? record.payload.output.trim()
          : safeJsonPreview(record.payload?.output)
      if (!output) {
        continue
      }

      pushEntry({
        kind: 'tool',
        title: 'tool-output',
        body: output,
        timestamp,
        accent: 'muted',
      })
    }
  }

  if (entries.length > 0) {
    const normalizedState = normalizeRunState(
      lastRunState,
      lastRunStateChangedAt,
      lastActivityAt,
    )
    return {
      entries,
      runState: normalizedState.run_state,
      runStateChangedAt: normalizedState.run_state_changed_at,
      contextUsage,
    }
  }

  if (!sessionMeta) {
    const normalizedState = normalizeRunState(
      lastRunState,
      lastRunStateChangedAt,
      lastActivityAt,
    )
    return {
      entries: [],
      runState: normalizedState.run_state,
      runStateChangedAt: normalizedState.run_state_changed_at,
      contextUsage,
    }
  }

  const normalizedState = normalizeRunState(
    lastRunState,
    lastRunStateChangedAt,
    lastActivityAt,
  )
  return {
    entries: [
      {
        id: `${sessionId}-meta`,
        kind: 'system' as const,
        title: 'session',
        body: [sessionMeta.originator, sessionMeta.cwd].filter(Boolean).join(' · '),
        body_truncated: false,
        detail_available: false,
        patch_summary: null,
        session_ids: [],
        timestamp: sessionMeta.timestamp ?? new Date().toISOString(),
        accent: 'muted' as const,
        attachments: [],
      },
    ],
    runState: normalizedState.run_state,
    runStateChangedAt: normalizedState.run_state_changed_at,
    contextUsage,
  }
}

export const readCodexTimeline = async (
  sessionId: string,
  options?: { codexHome?: string; sessionFiles?: Record<string, string> },
) => {
  return (await readCodexTimelineDetails(sessionId, options)).entries
}

export const discoverLocalCodexData = async (
  options: CodexDiscoveryOptions = {},
): Promise<CodexDiscoveryResult> => {
  const codexHome = options.codexHome ?? defaultCodexHome()
  const sessionIndex = await loadSessionIndex(codexHome)
  const [globalState, pandaThreadPrefs, pandaSessionPrefs] = await Promise.all([
    readCodexGlobalState(codexHome),
    readPandaThreadPrefs(codexHome),
    readPandaSessionPrefs(codexHome),
  ])
  const savedWorkspaceRoots = getSavedWorkspaceRoots(globalState).map(normalizePathKey)
  const workspaceRootLabels = getWorkspaceRootLabels(globalState)
  const pinnedWorkspaceRoots = new Set(
    getPinnedWorkspaceRoots(pandaThreadPrefs).map(normalizePathKey),
  )
  const orderedWorkspaceRoots = getOrderedWorkspaceRoots(pandaThreadPrefs)
  const pinnedSessionIds = new Set(getPinnedSessionIds(pandaSessionPrefs))
  const rolloutRoot = path.join(codexHome, 'sessions')
  const archivedRolloutRoot = path.join(codexHome, 'archived_sessions')
  const [rolloutFiles, archivedRolloutFiles] = await Promise.all([
    walkRolloutFiles(rolloutRoot),
    walkRolloutFiles(archivedRolloutRoot),
  ])
  const records = (
    await Promise.all(
      [
        ...rolloutFiles.map((filePath) => readRolloutRecord(filePath, sessionIndex, false)),
        ...archivedRolloutFiles.map((filePath) => readRolloutRecord(filePath, sessionIndex, true)),
      ],
    )
  )
    .filter((record): record is RolloutRecord => Boolean(record))
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))

  const maxSessions = options.maxSessions ?? records.length
  const limitedRecords = records.slice(0, maxSessions)
  const projectMap = new Map<string, ProjectRef>()
  const sessionFiles: Record<string, string> = {}
  const sessions: SessionWithRunState[] = []

  for (const record of limitedRecords) {
    const shouldShowRecord =
      record.archived || isWithinWorkspaceRoots(record.cwd, savedWorkspaceRoots)

    if (!shouldShowRecord) {
      continue
    }

    sessionFiles[record.sessionId] = record.filePath

    const projectKey = normalizePathKey(record.cwd)
    if (!projectMap.has(projectKey)) {
      const gitInfo = readGitInfo(record.cwd)
      projectMap.set(projectKey, {
        id: stableId('project', projectKey),
        agent_id:
          options.agentId ??
          stableId('agent', options.agentName ?? os.hostname()),
        name: basenameFromPath(record.cwd),
        display_name: workspaceRootLabels[projectKey] ?? null,
        pinned: pinnedWorkspaceRoots.has(projectKey),
        path: record.cwd,
        branch: gitInfo.branch,
        worktree: gitInfo.worktree,
        runtime_profiles: [],
        preview_url: null,
      })
    }
  }

  for (const record of limitedRecords) {
    const project = projectMap.get(normalizePathKey(record.cwd))
    if (!project) {
      continue
    }

    const mode = deriveSessionMode(record.updatedAt, record.archived)
    const timelineDetails = await readCodexTimelineDetails(record.sessionId, {
      codexHome,
      sessionFiles,
    })

    sessions.push({
      id: record.sessionId,
      agent_id: project.agent_id,
      project_id: project.id,
      provider: 'codex',
      archived: record.archived,
      title: record.title,
      mode,
      health: deriveSessionHealth(record.updatedAt, record.archived),
      branch: project.branch,
      worktree: project.worktree,
      summary: summarizeTimeline(timelineDetails.entries),
      latest_assistant_message:
        timelineDetails.entries
          .filter((entry) => entry.kind === 'assistant')
          .at(-1)?.body ?? null,
      last_event_at: record.updatedAt,
      pinned: pinnedSessionIds.has(record.sessionId),
      run_state: record.archived ? 'idle' : timelineDetails.runState,
      run_state_changed_at: record.archived ? null : timelineDetails.runStateChangedAt,
      context_usage: timelineDetails.contextUsage,
      subagent: record.subagent,
      capability: buildSessionCapability(mode === 'attached-live', record.archived),
    })
  }

  const agentId =
    options.agentId ??
    stableId('agent', options.agentName ?? os.hostname())
  const host = resolveHostAddress(options.host)
  const directBaseUrl =
    options.directBaseUrl?.trim() ||
    `http://${host}:4242`
  const wsBaseUrl =
    options.wsBaseUrl?.trim() ||
    directBaseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws'
  const agent: AgentNode = {
    id: agentId,
    name: options.agentName ?? os.hostname(),
    display_name: null,
    host,
    tailscale_ip: options.tailscaleIp ?? (host.startsWith('100.') ? host : null),
    tailscale_dns_name: options.tailscaleDnsName ?? null,
    direct_base_url: directBaseUrl,
    ws_base_url: wsBaseUrl,
    status: 'online',
    provider_availability: ['codex'],
    project_count: projectMap.size,
    session_count: sessions.length,
    transport: options.transport ?? 'direct-agent',
    version: options.version ?? null,
    registered_at: options.registeredAt ?? null,
    last_seen_at: options.lastSeenAt ?? null,
  }

  return {
    agent,
    projects: sortByStoredWorkspaceOrder(
      [...projectMap.values()],
      orderedWorkspaceRoots,
    ),
    sessions: sessions as SessionRef[],
    activeSessionId:
      sessions.find((session) => !session.archived)?.id ??
      sessions[0]?.id ??
      '',
    sessionFiles,
  }
}

export class CodexAdapter implements ProviderAdapter {
  constructor(
    private readonly options: CodexDiscoveryOptions = {},
  ) {}

  async discoverProjects() {
    return (await discoverLocalCodexData(this.options)).projects
  }

  async discoverSessions() {
    return (await discoverLocalCodexData(this.options)).sessions
  }

  async getSessionCapabilities(sessionId: string) {
    const sessions = await this.discoverSessions()
    return sessions.find((session) => session.id === sessionId)?.capability ?? null
  }

  async createManagedSession(_prompt: string) {
    return {
      sessionId: stableId('managed', `${Date.now()}`),
      accepted: true,
    }
  }

  async sendUserInput(_sessionId: string, _input: string) {
    return
  }

  async interruptTurn(_sessionId: string) {
    return
  }
}
