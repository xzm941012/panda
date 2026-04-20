import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  ChangeFile,
  ChangeSet,
  ProjectSkill,
  SessionInteractionRequest,
  SessionInputAttachment,
  SessionContextUsage,
  SessionPlanSnapshot,
  TimelineEntry,
} from '@panda/protocol'
import {
  areMergeableAssistantEntries,
  choosePreferredAssistantEntry,
} from './assistant-entry-dedupe'
import { stripInjectedUserText } from './injected-user-text'
import {
  buildAppServerMessageInput,
  parseMessageContent,
} from './message-content'

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

const WATCH_DEBOUNCE_MS = 160
const FALLBACK_SCAN_INTERVAL_MS = 2500
const TOOL_OUTPUT_LIMIT = 1400
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const COMPLETED_STATE_TTL_MS = 3 * 60 * 1000
const LATEST_ASSISTANT_MESSAGE_MAX_LENGTH = 280
const APP_SERVER_INITIALIZE_TIMEOUT_MS = 8000
const APP_SERVER_REQUEST_TIMEOUT_MS = 12000
const APP_SERVER_RUNTIME_DIAGNOSTIC_WINDOW_MS = 2 * 60 * 1000
const APP_SERVER_RUNTIME_DIAGNOSTIC_DEDUPE_MS = 4000
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g

const createDiagnosticHash = (value: string) =>
  createHash('sha1').update(value).digest('hex').slice(0, 16)

const listCodexCommandCandidates = () => {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const result = spawnSync(locator, ['codex'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      return []
    }
    return result.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

type CodexSessionRunState = 'idle' | 'running' | 'completed'
type ChangeSetSource = 'app-server' | 'rollout-fallback'
type ChangeSetStatus = 'running' | 'completed'

export type CodexSessionPatch = {
  run_state?: CodexSessionRunState
  run_state_changed_at?: string | null
  summary?: string
  latest_assistant_message?: string | null
  last_event_at?: string
  context_usage?: SessionContextUsage | null
}

export type CodexLiveSessionEvent = {
  sessionId: string
  filePath: string
  entries: TimelineEntry[]
  interactionRequests: SessionInteractionRequest[]
  interactionReset?: boolean
  resolvedInteractionIds: string[]
  planSnapshot: SessionPlanSnapshot | null
  planReset?: boolean
  changeSets: ChangeSet[]
  sessionPatch: CodexSessionPatch
  source: 'rollout' | 'app-server'
  discoveredAtRuntime?: boolean
}

type RolloutTracker = {
  sessionId: string
  filePath: string
  offset: number
  partialLine: string
  entrySeq: number
  patchSeq: number
  hydrated: boolean
  entries: TimelineEntry[]
  runState: CodexSessionRunState
  runStateChangedAt: string | null
  summary: string
  latestAssistantMessage: string | null
  lastEventAt: string
  contextUsage: SessionContextUsage | null
  turnSeq: number
  currentTurnId: string | null
  lastThreadStatusType: string | null
  lastThreadStatusReason: string | null
  lastRuntimeDiagnosticHash: string | null
  lastRuntimeDiagnosticText: string | null
  lastRuntimeDiagnosticAt: number
  planSnapshot: SessionPlanSnapshot | null
  interactionRequests: Map<string, PendingInteractionRequest>
}

type ChangeSetTracker = {
  id: string
  sessionId: string
  turnId: string
  source: ChangeSetSource
  status: ChangeSetStatus
  startedAt: string
  completedAt: string | null
  updatedAt: string
  aggregatedDiff: string
  files: Map<string, ChangeFile>
  fileOrder: string[]
  itemPaths: Map<string, string[]>
}

type AppServerMode = 'off' | 'spawn'

type AppServerConnection = {
  send: (message: string) => void
  shutdown: () => void
}

type LiveSessionLogger = {
  info: (payload: Record<string, unknown>, message: string) => void
  warn: (payload: Record<string, unknown>, message: string) => void
  error: (payload: Record<string, unknown>, message: string) => void
  debug?: (payload: Record<string, unknown>, message: string) => void
}

type AppServerNotification = {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  completed?: boolean
}

type AppServerResponse = {
  id?: string | number
  result?: unknown
  error?: {
    message?: string
  }
}

type PendingAppServerRequest = {
  method: string
  startedAt: number
  paramsSummary: Record<string, unknown>
  timeout: ReturnType<typeof setTimeout>
  resolve: (value: any) => void
  reject: (error: Error) => void
}

type PendingInteractionRequest = {
  requestId: string
  rawRequestId: string | number
  method:
    | 'item/tool/requestUserInput'
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'item/permissions/requestApproval'
    | 'mcpServer/elicitation/request'
  status: SessionInteractionRequest['status']
  request: SessionInteractionRequest
  responseKind:
    | 'user_input'
    | 'command_execution_approval'
    | 'file_change_approval'
    | 'permissions_approval'
    | 'mcp_elicitation'
  rawResponseOptions?: Array<{
    id: string
    value: unknown
  }>
}

type AppServerSkillMetadata = {
  name?: unknown
  description?: unknown
  shortDescription?: unknown
  path?: unknown
  scope?: unknown
  enabled?: unknown
}

type AppServerSkillsListEntry = {
  cwd?: unknown
  skills?: unknown
  errors?: unknown
}

type OneShotPromptInput = {
  cwd: string
  prompt: string
  model?: string | null
  reasoningEffort?: string | null
  timeoutMs?: number | null
}

export type CodexAvailableModel = {
  id: string
  label: string
  description: string
  isDefault: boolean
  defaultReasoningEffort: string | null
  supportedReasoningEfforts: string[]
}

export type CodexMcpServer = {
  name: string
  toolCount: number
  resourceCount: number
  authStatus: string | null
}

export type CodexCliConfig = {
  model: string | null
  modelProvider: string | null
  reasoningEffort: string | null
  approvalPolicy: string | null
  sandboxMode: string | null
  serviceTier: string | null
  profile: string | null
  baseUrl: string | null
  providerBaseUrl: string | null
  providerBaseUrls: Array<{
    provider: string
    baseUrl: string
  }>
}

const YOLO_APPROVAL_POLICY = 'never'
const YOLO_SANDBOX_POLICY = 'danger-full-access'

const resolveExecutionOverrides = (yoloMode?: boolean) =>
  yoloMode
    ? {
        approvalPolicy: YOLO_APPROVAL_POLICY,
        sandboxMode: YOLO_SANDBOX_POLICY,
        sandboxPolicy: {
          type: 'dangerFullAccess',
        },
      }
    : {
        approvalPolicy: null,
        sandboxMode: null,
        sandboxPolicy: null,
      }

const APP_SERVER_TRACKER_PREFIX = 'app-server:'
const APP_SERVER_DIAGNOSTIC_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
  'config/read',
])

const defaultCodexHome = () => path.join(os.homedir(), '.codex')

const resolveCodexEnvironmentHome = () =>
  process.env.CODEX_HOME?.trim() ||
  process.env.PANDA_CODEX_HOME?.trim() ||
  defaultCodexHome()

const truncateText = (value: string, length: number) => {
  const trimmed = value.trim()
  if (trimmed.length <= length) {
    return trimmed
  }

  return `${trimmed.slice(0, length - 1).trimEnd()}…`
}

const normalizeAssistantPreviewText = (
  value: string,
  maxLength = LATEST_ASSISTANT_MESSAGE_MAX_LENGTH,
) => {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }

  return truncateText(normalized, maxLength)
}

const stripAnsiText = (value: string) => value.replace(ANSI_ESCAPE_PATTERN, '')

const normalizeAppServerRuntimeDiagnostic = (value: string) => {
  const normalized = stripAnsiText(value).replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }

  const reconnectMatch = normalized.match(/Reconnecting\.\.\.\s+\d+\/\d+/i)
  if (reconnectMatch?.[0]) {
    return reconnectMatch[0]
  }

  const unexpectedStatusMatch = normalized.match(/unexpected status\b.*$/i)
  if (unexpectedStatusMatch?.[0]) {
    return truncateText(unexpectedStatusMatch[0], 320)
  }

  if (/Invalid API key|Unauthorized/i.test(normalized)) {
    return truncateText(normalized, 320)
  }

  return null
}

const readStringFromRecord = (
  record: Record<string, unknown>,
  field: string,
) => {
  const candidate = record[field]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

const summarizeAppServerInput = (value: unknown) => {
  if (!Array.isArray(value)) {
    return {
      itemCount: 0,
      textItemCount: 0,
      imageItemCount: 0,
      fileItemCount: 0,
      textCharacters: 0,
      inputFingerprint: createDiagnosticHash('[]'),
      textSummaries: [],
      nonTextItems: [],
    }
  }

  let textItemCount = 0
  let imageItemCount = 0
  let fileItemCount = 0
  let textCharacters = 0
  const textSummaries: Array<{
    index: number
    length: number
    hash: string
    preview: string
  }> = []
  const nonTextItems: Array<{
    index: number
    kind: 'image' | 'file' | 'unknown'
    fileName: string | null
  }> = []
  const fingerprintSource: Array<Record<string, unknown>> = []

  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const candidate = item as {
      type?: unknown
      text?: unknown
      imageUrl?: unknown
      fileId?: unknown
      fileName?: unknown
    }
    if (typeof candidate.text === 'string' && candidate.text.trim()) {
      const trimmedText = candidate.text.trim()
      textItemCount += 1
      textCharacters += trimmedText.length
      if (textSummaries.length < 3) {
        textSummaries.push({
          index,
          length: trimmedText.length,
          hash: createDiagnosticHash(trimmedText),
          preview:
            trimmedText.length > 120
              ? `${trimmedText.slice(0, 119).trimEnd()}…`
              : trimmedText,
        })
      }
      fingerprintSource.push({
        index,
        kind: 'text',
        textHash: createDiagnosticHash(trimmedText),
      })
    }
    if (
      candidate.type === 'image' ||
      typeof candidate.imageUrl === 'string'
    ) {
      imageItemCount += 1
      nonTextItems.push({
        index,
        kind: 'image',
        fileName: null,
      })
      fingerprintSource.push({
        index,
        kind: 'image',
      })
      continue
    }
    if (
      candidate.type === 'file' ||
      typeof candidate.fileId === 'string' ||
      typeof candidate.fileName === 'string'
    ) {
      fileItemCount += 1
      const fileName =
        typeof candidate.fileName === 'string' && candidate.fileName.trim()
          ? candidate.fileName.trim()
          : null
      nonTextItems.push({
        index,
        kind: 'file',
        fileName,
      })
      fingerprintSource.push({
        index,
        kind: 'file',
        fileName,
      })
    }
  }

  return {
    itemCount: value.length,
    textItemCount,
    imageItemCount,
    fileItemCount,
    textCharacters,
    inputFingerprint: createDiagnosticHash(JSON.stringify(fingerprintSource)),
    textSummaries,
    nonTextItems,
  }
}

const summarizeAppServerParams = (
  method: string,
  params: Record<string, unknown>,
) => {
  if (method === 'thread/start') {
    return {
      cwd: typeof params.cwd === 'string' ? params.cwd : null,
      model: typeof params.model === 'string' ? params.model : null,
      serviceTier: typeof params.serviceTier === 'string' ? params.serviceTier : null,
      ephemeral: params.ephemeral === true,
      persistExtendedHistory: params.persistExtendedHistory === true,
    }
  }

  if (method === 'thread/resume') {
    return {
      threadId: typeof params.threadId === 'string' ? params.threadId : null,
      persistExtendedHistory: params.persistExtendedHistory === true,
    }
  }

  if (method === 'turn/start') {
    return {
      threadId: typeof params.threadId === 'string' ? params.threadId : null,
      model: typeof params.model === 'string' ? params.model : null,
      effort: typeof params.effort === 'string' ? params.effort : null,
      serviceTier: typeof params.serviceTier === 'string' ? params.serviceTier : null,
      ...summarizeAppServerInput(params.input),
    }
  }

  if (method === 'turn/interrupt') {
    return {
      threadId: typeof params.threadId === 'string' ? params.threadId : null,
      turnId: typeof params.turnId === 'string' ? params.turnId : null,
    }
  }

  if (method === 'config/read') {
    return {
      cwd: typeof params.cwd === 'string' ? params.cwd : null,
      includeLayers: params.includeLayers === true,
    }
  }

  return {}
}

const normalizeSkillScope = (value: unknown): ProjectSkill['scope'] => {
  if (value === 'user' || value === 'repo' || value === 'system' || value === 'admin') {
    return value
  }

  return 'system'
}

const normalizeSkillDescription = (skill: AppServerSkillMetadata) => {
  if (typeof skill.description === 'string' && skill.description.trim()) {
    return skill.description.trim()
  }

  if (typeof skill.shortDescription === 'string' && skill.shortDescription.trim()) {
    return skill.shortDescription.trim()
  }

  return ''
}

const parseProjectSkillsResponse = (value: unknown): ProjectSkill[] => {
  const rawEntries = Array.isArray((value as { data?: unknown } | null)?.data)
    ? ((value as { data: unknown[] }).data as unknown[])
    : []
  const dedupedSkills = new Map<string, ProjectSkill>()

  for (const rawEntry of rawEntries) {
    const entry = rawEntry as AppServerSkillsListEntry
    const rawSkills = Array.isArray(entry?.skills) ? entry.skills : []

    for (const rawSkill of rawSkills) {
      const skill = rawSkill as AppServerSkillMetadata
      if (typeof skill?.name !== 'string' || !skill.name.trim()) {
        continue
      }

      if (typeof skill.path !== 'string' || !skill.path.trim()) {
        continue
      }

      const normalizedSkill: ProjectSkill = {
        name: skill.name.trim(),
        description: normalizeSkillDescription(skill),
        path: skill.path.trim(),
        scope: normalizeSkillScope(skill.scope),
        enabled: skill.enabled !== false,
      }
      const dedupeKey = `${normalizedSkill.scope}:${normalizedSkill.path}:${normalizedSkill.name}`
      dedupedSkills.set(dedupeKey, normalizedSkill)
    }
  }

  return [...dedupedSkills.values()]
}

const parseModelListResponse = (value: unknown): CodexAvailableModel[] => {
  const rawEntries = Array.isArray((value as { data?: unknown } | null)?.data)
    ? ((value as { data: unknown[] }).data as unknown[])
    : []

  return rawEntries
    .map((rawEntry) => {
      if (!rawEntry || typeof rawEntry !== 'object') {
        return null
      }

      const entry = rawEntry as {
        id?: unknown
        model?: unknown
        displayName?: unknown
        description?: unknown
        isDefault?: unknown
        defaultReasoningEffort?: unknown
        supportedReasoningEfforts?: unknown
      }
      const id =
        typeof entry.id === 'string' && entry.id.trim()
          ? entry.id.trim()
          : typeof entry.model === 'string' && entry.model.trim()
            ? entry.model.trim()
            : ''

      if (!id) {
        return null
      }

      const label =
        typeof entry.displayName === 'string' && entry.displayName.trim()
          ? entry.displayName.trim()
          : id

      const supportedReasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts
            .map((item) => {
              if (!item || typeof item !== 'object') {
                return null
              }

              const candidate = item as { value?: unknown }
              return typeof candidate.value === 'string' && candidate.value.trim()
                ? candidate.value.trim()
                : null
            })
            .filter((item): item is string => Boolean(item))
        : []

      return {
        id,
        label,
        description:
          typeof entry.description === 'string' ? entry.description.trim() : '',
        isDefault: entry.isDefault === true,
        defaultReasoningEffort:
          typeof entry.defaultReasoningEffort === 'string' &&
            entry.defaultReasoningEffort.trim()
            ? entry.defaultReasoningEffort.trim()
            : null,
        supportedReasoningEfforts,
      } satisfies CodexAvailableModel
    })
    .filter((entry): entry is CodexAvailableModel => Boolean(entry))
}

const parseMcpServerStatusResponse = (value: unknown): CodexMcpServer[] => {
  const rawEntries = Array.isArray((value as { data?: unknown } | null)?.data)
    ? ((value as { data: unknown[] }).data as unknown[])
    : []

  return rawEntries
    .map((rawEntry) => {
      if (!rawEntry || typeof rawEntry !== 'object') {
        return null
      }

      const entry = rawEntry as {
        name?: unknown
        tools?: unknown
        resources?: unknown
        authStatus?: unknown
      }

      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        return null
      }

      const toolCount =
        entry.tools && typeof entry.tools === 'object'
          ? Object.keys(entry.tools as Record<string, unknown>).length
          : 0
      const resourceCount = Array.isArray(entry.resources) ? entry.resources.length : 0
      const authStatus =
        entry.authStatus && typeof entry.authStatus === 'object'
          ? Object.keys(entry.authStatus as Record<string, unknown>)
              .find((key) => Boolean(key)) ?? null
          : null

      return {
        name: entry.name.trim(),
        toolCount,
        resourceCount,
        authStatus,
      } satisfies CodexMcpServer
    })
    .filter((entry): entry is CodexMcpServer => Boolean(entry))
}

const parseConfigReadResponse = (value: unknown): CodexCliConfig => {
  const config =
    value && typeof value === 'object' && 'config' in value && value.config &&
      typeof value.config === 'object'
      ? (value.config as Record<string, unknown>)
      : {}
  const providers =
    config.providers && typeof config.providers === 'object'
      ? (config.providers as Record<string, unknown>)
      : {}
  const providerBaseUrls = Object.entries(providers)
    .map(([provider, providerConfig]) => {
      if (!providerConfig || typeof providerConfig !== 'object') {
        return null
      }
      const baseUrl = readStringFromRecord(
        providerConfig as Record<string, unknown>,
        'base_url',
      )
      if (!baseUrl) {
        return null
      }
      return {
        provider,
        baseUrl,
      }
    })
    .filter(
      (
        entry,
      ): entry is {
        provider: string
        baseUrl: string
      } => Boolean(entry),
    )
  const modelProvider = readStringFromRecord(config, 'model_provider')
  const providerBaseUrl =
    providerBaseUrls.find((entry) => entry.provider === modelProvider)?.baseUrl ?? null

  return {
    model: readStringFromRecord(config, 'model'),
    modelProvider,
    reasoningEffort: readStringFromRecord(config, 'model_reasoning_effort'),
    approvalPolicy: readStringFromRecord(config, 'approval_policy'),
    sandboxMode: readStringFromRecord(config, 'sandbox_mode'),
    serviceTier: readStringFromRecord(config, 'service_tier'),
    profile: readStringFromRecord(config, 'profile'),
    baseUrl: readStringFromRecord(config, 'base_url'),
    providerBaseUrl,
    providerBaseUrls,
  }
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

const toTimestamp = (value: string | null | undefined) => {
  if (!value) {
    return Number.NaN
  }

  return new Date(value).getTime()
}

const markTrackerActivity = (tracker: RolloutTracker, timestamp: string) => {
  const nextTimestamp = toTimestamp(timestamp)
  const currentTimestamp = toTimestamp(tracker.lastEventAt)
  if (!Number.isFinite(nextTimestamp)) {
    return
  }

  if (!Number.isFinite(currentTimestamp) || nextTimestamp > currentTimestamp) {
    tracker.lastEventAt = timestamp
  }
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
      cached_input_tokens?: number
      output_tokens?: number
      reasoning_output_tokens?: number
      total_tokens?: number
    }
    total_token_usage?: {
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
  const usedTokens =
    preferredUsage?.total_tokens ??
    fallbackUsage?.total_tokens
  const totalWindow = usageInfo.model_context_window
  if (
    typeof usedTokens !== 'number' ||
    !Number.isFinite(usedTokens) ||
    typeof totalWindow !== 'number' ||
    !Number.isFinite(totalWindow) ||
    totalWindow <= 0
  ) {
    return null
  }

  const normalizedUsedTokens = Math.max(0, Math.round(usedTokens))
  const normalizedTotalWindow = Math.max(
    normalizedUsedTokens,
    Math.round(totalWindow),
  )

  return {
    used_tokens: normalizedUsedTokens,
    total_tokens: normalizedTotalWindow,
    remaining_tokens: Math.max(0, normalizedTotalWindow - normalizedUsedTokens),
    percent_used: Math.max(
      0,
      Math.min(100, (normalizedUsedTokens / normalizedTotalWindow) * 100),
    ),
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

const safeJsonPreview = (value: unknown) => {
  if (typeof value === 'string') {
    return truncateText(value, TOOL_OUTPUT_LIMIT)
  }

  try {
    return truncateText(JSON.stringify(value, null, 2), TOOL_OUTPUT_LIMIT)
  } catch {
    return ''
  }
}

const syncPlanSnapshotActivity = (tracker: RolloutTracker, timestamp: string) => {
  if (!tracker.planSnapshot) {
    return
  }

  tracker.planSnapshot = {
    ...tracker.planSnapshot,
    updated_at:
      +new Date(timestamp) > +new Date(tracker.planSnapshot.updated_at)
        ? timestamp
        : tracker.planSnapshot.updated_at,
    turn_id: tracker.currentTurnId,
    is_active: tracker.runState === 'running',
  }
}

const clearTrackerPlanSnapshot = (tracker: RolloutTracker) => {
  if (!tracker.planSnapshot) {
    return false
  }

  tracker.planSnapshot = null
  return true
}

type ParsedPlanStepStatus = 'pending' | 'in_progress' | 'completed'

type ParsedPlanPayload = {
  explanation: string | null
  steps: Array<{
    id: string
    step: string
    status: ParsedPlanStepStatus
  }>
}

const normalizePlanStepStatus = (value: unknown): ParsedPlanStepStatus | null => {
  if (value === 'pending' || value === 'in_progress' || value === 'completed') {
    return value
  }

  return null
}

const parsePlanArguments = (value: unknown): ParsedPlanPayload | null => {
  let parsedValue = value

  if (typeof parsedValue === 'string') {
    const trimmed = parsedValue.trim()
    if (!trimmed) {
      return null
    }

    try {
      parsedValue = JSON.parse(trimmed)
    } catch {
      return null
    }
  }

  if (!parsedValue || typeof parsedValue !== 'object') {
    return null
  }

  const candidate = parsedValue as {
    explanation?: unknown
    plan?: unknown
  }

  if (!Array.isArray(candidate.plan)) {
    return null
  }

  const steps = candidate.plan
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const planItem = item as { step?: unknown; status?: unknown }
      if (typeof planItem.step !== 'string') {
        return null
      }

      const step = planItem.step.trim()
      const status = normalizePlanStepStatus(planItem.status)
      if (!step || !status) {
        return null
      }

      return {
        id: `${index}:${step}`,
        step,
        status,
      }
    })
    .filter((item): item is ParsedPlanPayload['steps'][number] => Boolean(item))

  if (steps.length === 0) {
    return null
  }

  return {
    explanation:
      typeof candidate.explanation === 'string' && candidate.explanation.trim()
        ? candidate.explanation.trim()
        : null,
    steps,
  }
}

const summarizeFromEntries = (entries: TimelineEntry[], fallback: string) => {
  const candidate = [...entries]
    .reverse()
    .find((entry) => entry.kind === 'assistant' || entry.kind === 'user')

  return candidate ? truncateText(candidate.body, 88) : fallback
}

const normalizeRunState = (
  runState: CodexSessionRunState,
  changedAt: string | null,
  lastEventAt?: string | null,
) => {
  const freshestRunningAt = Math.max(toTimestamp(changedAt), toTimestamp(lastEventAt))

  if (
    runState === 'running' &&
    (!Number.isFinite(freshestRunningAt) || Date.now() - freshestRunningAt > ACTIVE_WINDOW_MS)
  ) {
    return {
      runState: 'idle' as const,
      runStateChangedAt: null,
    }
  }

  if (
    runState === 'completed' &&
    changedAt &&
    Date.now() - new Date(changedAt).getTime() > COMPLETED_STATE_TTL_MS
  ) {
    return {
      runState: 'idle' as const,
      runStateChangedAt: null,
    }
  }

  return {
    runState,
    runStateChangedAt: changedAt,
  }
}

const normalizeDiffText = (value: string) =>
  value.replace(/\r\n/g, '\n').trim()

const countContentLines = (value: string) => {
  const text = value.replace(/\r\n/g, '\n')
  if (!text) {
    return 0
  }

  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.length
}

const countUnifiedDiffChanges = (value: string) => {
  let additions = 0
  let deletions = 0

  for (const line of value.split('\n')) {
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('@@') ||
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('\\ No newline at end of file')
    ) {
      continue
    }

    if (line.startsWith('+')) {
      additions += 1
      continue
    }

    if (line.startsWith('-')) {
      deletions += 1
    }
  }

  return {
    additions,
    deletions,
  }
}

const getDiffCounts = (kind: ChangeFile['kind'], diff: string) => {
  const normalized = normalizeDiffText(diff)
  if (!normalized) {
    return {
      additions: 0,
      deletions: 0,
    }
  }

  const unifiedCounts = countUnifiedDiffChanges(normalized)
  if (unifiedCounts.additions > 0 || unifiedCounts.deletions > 0) {
    return unifiedCounts
  }

  if (kind === 'add') {
    return {
      additions: countContentLines(normalized),
      deletions: 0,
    }
  }

  if (kind === 'delete') {
    return {
      additions: 0,
      deletions: countContentLines(normalized),
    }
  }

  return {
    additions: 0,
    deletions: 0,
  }
}

const resolveDiffPath = (block: string) => {
  const plusMatch = /^\+\+\+ b\/(.+)$/m.exec(block)
  if (plusMatch?.[1]) {
    return plusMatch[1]
  }

  const genericPlusMatch = /^\+\+\+ (?!b\/)(.+)$/m.exec(block)
  if (genericPlusMatch?.[1] && genericPlusMatch[1] !== '/dev/null') {
    return genericPlusMatch[1]
  }

  const diffGitMatch = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block)
  if (diffGitMatch?.[2]) {
    return diffGitMatch[2]
  }

  const minusMatch = /^--- a\/(.+)$/m.exec(block)
  if (minusMatch?.[1]) {
    return minusMatch[1]
  }

  const genericMinusMatch = /^--- (?!a\/)(.+)$/m.exec(block)
  if (genericMinusMatch?.[1] && genericMinusMatch[1] !== '/dev/null') {
    return genericMinusMatch[1]
  }

  return ''
}

const splitUnifiedDiffByFile = (value: string) => {
  const normalized = normalizeDiffText(value)
  if (!normalized) {
    return []
  }

  const lines = normalized.split('\n')
  const blocks: string[] = []
  let current: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const nextLine = lines[index + 1] ?? ''
    const startsNewGenericFileBlock =
      line.startsWith('--- ') &&
      nextLine.startsWith('+++ ') &&
      current.length > 0 &&
      current.some((candidate) => candidate.startsWith('@@') || candidate.startsWith('+++ ') || candidate.startsWith('diff --git '))

    if (line.startsWith('diff --git ') && current.length > 0) {
      blocks.push(current.join('\n'))
      current = [line]
      continue
    }

    if (startsNewGenericFileBlock) {
      blocks.push(current.join('\n'))
      current = [line]
      continue
    }

    current.push(line)
  }

  if (current.length > 0) {
    blocks.push(current.join('\n'))
  }

  return blocks.map((block) => ({
    path: resolveDiffPath(block),
    diff: block,
  }))
}

const getChangeFileStoreKey = (input: Pick<ChangeFile, 'path' | 'item_id'>) => {
  const normalizedPath = input.path.replace(/\\/g, '/')
  return input.item_id ? `${input.item_id}:${normalizedPath}` : normalizedPath
}

export const parseApplyPatchChangeFiles = (input: string): ChangeFile[] => {
  const lines = input.split(/\r?\n/)
  const files: ChangeFile[] = []
  let currentFile: ChangeFile | null = null
  let diffLines: string[] = []

  const flushCurrent = () => {
    if (!currentFile) {
      return
    }

    files.push({
      ...currentFile,
      diff: diffLines.join('\n').trim(),
    })
    currentFile = null
    diffLines = []
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')

    if (line.startsWith('*** Add File: ')) {
      flushCurrent()
      currentFile = {
        path: line.slice('*** Add File: '.length).trim(),
        kind: 'add',
        move_path: null,
        additions: 0,
        deletions: 0,
        diff: '',
        item_id: null,
      }
      continue
    }

    if (line.startsWith('*** Update File: ')) {
      flushCurrent()
      currentFile = {
        path: line.slice('*** Update File: '.length).trim(),
        kind: 'update',
        move_path: null,
        additions: 0,
        deletions: 0,
        diff: '',
        item_id: null,
      }
      continue
    }

    if (line.startsWith('*** Delete File: ')) {
      flushCurrent()
      currentFile = {
        path: line.slice('*** Delete File: '.length).trim(),
        kind: 'delete',
        move_path: null,
        additions: 0,
        deletions: 0,
        diff: '',
        item_id: null,
      }
      continue
    }

    if (!currentFile) {
      continue
    }

    if (line.startsWith('*** Move to: ')) {
      currentFile.move_path = line.slice('*** Move to: '.length).trim()
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
      line.startsWith('@@') ||
      line.startsWith('+') ||
      line.startsWith('-') ||
      line.startsWith(' ')
    ) {
      diffLines.push(line)
    }
  }

  flushCurrent()
  return files
}

const readFirstLine = async (filePath: string) => {
  const handle = await fsp.open(filePath, 'r')
  try {
    const chunks: string[] = []
    let bytesReadTotal = 0
    let position = 0

    while (bytesReadTotal < 256 * 1024) {
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

const readFileSlice = async (filePath: string, start: number, endExclusive: number) => {
  const length = Math.max(0, endExclusive - start)
  if (length === 0) {
    return ''
  }

  const handle = await fsp.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

const walkRolloutFiles = async (rootPath: string): Promise<string[]> => {
  let entries
  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true })
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

const readSessionIdFromRollout = async (filePath: string) => {
  try {
    const firstLine = await readFirstLine(filePath)
    if (!firstLine) {
      return null
    }

    const parsed = JSON.parse(firstLine) as {
      payload?: { id?: string }
    }

    return parsed.payload?.id?.trim() || null
  } catch {
    return null
  }
}

const readFullRollout = async (filePath: string) => {
  try {
    return await fsp.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

const parseRolloutRecords = (content: string) =>
  content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { timestamp?: string; type?: string; payload?: any }
      } catch {
        return null
      }
    })
    .filter((record): record is { timestamp?: string; type?: string; payload?: any } => Boolean(record))

const createTracker = (sessionId: string, filePath: string, offset = 0): RolloutTracker => ({
  sessionId,
  filePath,
  offset,
  partialLine: '',
  entrySeq: 0,
  patchSeq: 0,
  hydrated: false,
  entries: [],
  runState: 'idle',
  runStateChangedAt: null,
  summary: '',
  latestAssistantMessage: null,
  lastEventAt: new Date(0).toISOString(),
  contextUsage: null,
  turnSeq: 0,
  currentTurnId: null,
  lastThreadStatusType: null,
  lastThreadStatusReason: null,
  lastRuntimeDiagnosticHash: null,
  lastRuntimeDiagnosticText: null,
  lastRuntimeDiagnosticAt: 0,
  planSnapshot: null,
  interactionRequests: new Map(),
})

const normalizeInteractionRequestId = (value: unknown) =>
  typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : ''

const sortInteractionRequests = (requests: SessionInteractionRequest[]) =>
  [...requests].sort((left, right) => {
    const updatedDelta =
      +new Date(right.updated_at) - +new Date(left.updated_at)
    if (updatedDelta !== 0) {
      return updatedDelta
    }

    return left.id.localeCompare(right.id)
  })

const listTrackerInteractionRequests = (tracker: RolloutTracker) =>
  sortInteractionRequests(
    [...tracker.interactionRequests.values()].map((entry) => entry.request),
  )

const setTrackerInteractionRequest = (
  tracker: RolloutTracker,
  request: PendingInteractionRequest,
) => {
  tracker.interactionRequests.set(request.requestId, request)
}

const updateTrackerInteractionRequestStatus = (
  tracker: RolloutTracker,
  requestId: string,
  status: SessionInteractionRequest['status'],
  timestamp: string,
) => {
  const existing = tracker.interactionRequests.get(requestId)
  if (!existing || existing.request.status === status) {
    return existing?.request ?? null
  }

  const nextRequest = {
    ...existing,
    request: {
      ...existing.request,
      status,
      updated_at: timestamp,
    },
  }
  tracker.interactionRequests.set(requestId, nextRequest)
  return nextRequest.request
}

const resolveTrackerInteractionRequest = (
  tracker: RolloutTracker,
  requestId: string,
) => tracker.interactionRequests.delete(requestId)

const normalizeDisplayText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const parseInteractionOption = (
  value: unknown,
  fallbackIndex: number,
): {
  option: SessionInteractionRequest['options'][number]
  rawValue: unknown
} | null => {
  if (typeof value === 'string' && value.trim()) {
    return {
      option: {
        id: value.trim(),
        label: value.trim(),
        description: null,
        emphasis:
          /deny|reject|cancel|decline|block/i.test(value)
            ? 'danger'
            : /approve|accept|allow|continue/i.test(value)
              ? 'primary'
              : 'default',
      },
      rawValue: value.trim(),
    }
  }

  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Record<string, unknown>
  const explicitId =
    normalizeDisplayText(candidate.id) ??
    normalizeDisplayText(candidate.value) ??
    normalizeDisplayText(candidate.key) ??
    normalizeDisplayText(candidate.kind)
  const label =
    normalizeDisplayText(candidate.label) ??
    normalizeDisplayText(candidate.title) ??
    normalizeDisplayText(candidate.name) ??
    explicitId
  if (!label) {
    return null
  }

  const id = explicitId ?? `option-${fallbackIndex}`
  const description =
    normalizeDisplayText(candidate.description) ??
    normalizeDisplayText(candidate.hint) ??
    normalizeDisplayText(candidate.subtitle)
  const emphasis =
    /deny|reject|cancel|decline|block/i.test(id) || /deny|reject|cancel/i.test(label)
      ? 'danger'
      : /approve|accept|allow|continue/i.test(id) || /approve|accept|allow|continue/i.test(label)
        ? 'primary'
        : 'default'

  return {
    option: {
      id,
      label,
      description,
      emphasis,
    },
    rawValue: value,
  }
}

const parseInteractionOptions = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [] as Array<{
      option: SessionInteractionRequest['options'][number]
      rawValue: unknown
    }>
  }

  return value
    .map((item, index) => parseInteractionOption(item, index))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
}

const getInteractionItemId = (params: Record<string, unknown> | undefined) =>
  normalizeDisplayText(params?.itemId) ??
  normalizeDisplayText(params?.item_id) ??
  normalizeDisplayText(params?.targetItemId)

const getInteractionTurnId = (params: Record<string, unknown> | undefined) =>
  normalizeDisplayText(params?.turnId) ??
  normalizeDisplayText(params?.turn_id)

const getInteractionTimestamp = () => new Date().toISOString()

const buildUserInputInteraction = (
  sessionId: string,
  requestId: string,
  rawRequestId: string | number,
  params: Record<string, unknown>,
  completed: boolean,
  timestamp: string,
): PendingInteractionRequest | null => {
  if (!Array.isArray(params.questions) || params.questions.length === 0) {
    return null
  }

  const questions = params.questions
    .map((question, index) => {
      if (!question || typeof question !== 'object') {
        return null
      }

      const candidate = question as Record<string, unknown>
      const id = normalizeDisplayText(candidate.id) ?? `question-${index + 1}`
      const questionText = normalizeDisplayText(candidate.question)
      if (!questionText) {
        return null
      }

      const options = parseInteractionOptions(candidate.options)
      return {
        id,
        header: normalizeDisplayText(candidate.header),
        question: questionText,
        options: options.map((item) => item.option),
        allow_other: candidate.isOther === true,
        is_secret: candidate.isSecret === true,
        rawResponseOptions: options.map((item) => ({
          id: item.option.id,
          value: item.option.label,
        })),
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  if (questions.length === 0) {
    return null
  }

  return {
    requestId,
    rawRequestId,
    method: 'item/tool/requestUserInput',
    status: completed ? 'resolved' : 'pending',
    responseKind: 'user_input',
    rawResponseOptions: questions.flatMap((question) => question.rawResponseOptions),
    request: {
      id: requestId,
      session_id: sessionId,
      turn_id: getInteractionTurnId(params),
      item_id: getInteractionItemId(params),
      kind: 'user_input',
      status: completed ? 'resolved' : 'pending',
      title: '等待你的确认',
      description:
        questions.length === 1
          ? questions[0]?.question ?? null
          : `有 ${questions.length} 个确认问题待回复`,
      created_at: timestamp,
      updated_at: timestamp,
      options: [],
      questions: questions.map(({ rawResponseOptions: _rawResponseOptions, ...question }) => question),
      allow_freeform: questions.some((question) => question.allow_other),
      freeform_placeholder: '输入自定义回复',
      submit_label: '发送回复',
    },
  }
}

const buildCommandExecutionInteraction = (
  sessionId: string,
  requestId: string,
  rawRequestId: string | number,
  params: Record<string, unknown>,
  completed: boolean,
  timestamp: string,
): PendingInteractionRequest => {
  const options = parseInteractionOptions(params.availableDecisions)
  const command =
    Array.isArray(params.command)
      ? params.command
          .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
          .join(' ')
      : normalizeDisplayText(params.command)
  const cwd = normalizeDisplayText(params.cwd)
  const descriptionParts = [
    command ? `命令：${command}` : null,
    cwd ? `目录：${cwd}` : null,
  ].filter((part): part is string => Boolean(part))

  return {
    requestId,
    rawRequestId,
    method: 'item/commandExecution/requestApproval',
    status: completed ? 'resolved' : 'pending',
    responseKind: 'command_execution_approval',
    rawResponseOptions: options.map((item) => ({
      id: item.option.id,
      value: item.rawValue,
    })),
    request: {
      id: requestId,
      session_id: sessionId,
      turn_id: getInteractionTurnId(params),
      item_id: getInteractionItemId(params),
      kind: 'command_execution_approval',
      status: completed ? 'resolved' : 'pending',
      title: '命令执行需要确认',
      description: descriptionParts.join(' · ') || '这条命令需要你的确认后才能继续执行',
      created_at: timestamp,
      updated_at: timestamp,
      options: options.map((item) => item.option),
      questions: [],
      allow_freeform: false,
      freeform_placeholder: null,
      submit_label: null,
    },
  }
}

const buildFileChangeInteraction = (
  sessionId: string,
  requestId: string,
  rawRequestId: string | number,
  params: Record<string, unknown>,
  completed: boolean,
  timestamp: string,
): PendingInteractionRequest => {
  const rawOptions = [
    {
      id: 'approved',
      value: 'approved',
      option: {
        id: 'approved',
        label: '允许修改',
        description: '批准这次文件修改请求并继续执行',
        emphasis: 'primary' as const,
      },
    },
    {
      id: 'denied',
      value: 'denied',
      option: {
        id: 'denied',
        label: '拒绝修改',
        description: '拒绝这次文件修改请求',
        emphasis: 'danger' as const,
      },
    },
  ]

  return {
    requestId,
    rawRequestId,
    method: 'item/fileChange/requestApproval',
    status: completed ? 'resolved' : 'pending',
    responseKind: 'file_change_approval',
    rawResponseOptions: rawOptions.map(({ id, value }) => ({ id, value })),
    request: {
      id: requestId,
      session_id: sessionId,
      turn_id: getInteractionTurnId(params),
      item_id: getInteractionItemId(params),
      kind: 'file_change_approval',
      status: completed ? 'resolved' : 'pending',
      title: '文件修改需要确认',
      description:
        normalizeDisplayText(params.reason) ??
        normalizeDisplayText(params.grantRoot) ??
        '这次补丁写入需要你的确认',
      created_at: timestamp,
      updated_at: timestamp,
      options: rawOptions.map((item) => item.option),
      questions: [],
      allow_freeform: false,
      freeform_placeholder: null,
      submit_label: null,
    },
  }
}

const buildPermissionsInteraction = (
  sessionId: string,
  requestId: string,
  rawRequestId: string | number,
  params: Record<string, unknown>,
  completed: boolean,
  timestamp: string,
): PendingInteractionRequest => {
  const permissionOptions = Array.isArray(params.permissions)
    ? params.permissions
        .map((item, index) => parseInteractionOption(item, index))
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : []

  return {
    requestId,
    rawRequestId,
    method: 'item/permissions/requestApproval',
    status: completed ? 'resolved' : 'pending',
    responseKind: 'permissions_approval',
    rawResponseOptions: permissionOptions.map((item) => ({
      id: item.option.id,
      value: item.option.id,
    })),
    request: {
      id: requestId,
      session_id: sessionId,
      turn_id: getInteractionTurnId(params),
      item_id: getInteractionItemId(params),
      kind: 'permissions_approval',
      status: completed ? 'resolved' : 'pending',
      title: '权限请求需要确认',
      description: '该操作需要额外权限后才能继续',
      created_at: timestamp,
      updated_at: timestamp,
      options: permissionOptions.map((item) => item.option),
      questions: [],
      allow_freeform: false,
      freeform_placeholder: null,
      submit_label: null,
    },
  }
}

const buildMcpElicitationInteraction = (
  sessionId: string,
  requestId: string,
  rawRequestId: string | number,
  params: Record<string, unknown>,
  completed: boolean,
  timestamp: string,
): PendingInteractionRequest => {
  const rawSchema =
    params.requestedSchema && typeof params.requestedSchema === 'object'
      ? params.requestedSchema as Record<string, unknown>
      : null
  const enumOptions =
    parseInteractionOptions(
      rawSchema?.oneOf ??
        rawSchema?.enum ??
        rawSchema?.options,
    )

  return {
    requestId,
    rawRequestId,
    method: 'mcpServer/elicitation/request',
    status: completed ? 'resolved' : 'pending',
    responseKind: 'mcp_elicitation',
    rawResponseOptions: enumOptions.map((item) => ({
      id: item.option.id,
      value: item.option.label,
    })),
    request: {
      id: requestId,
      session_id: sessionId,
      turn_id: getInteractionTurnId(params),
      item_id: null,
      kind: 'mcp_elicitation',
      status: completed ? 'resolved' : 'pending',
      title: normalizeDisplayText(params.serverName) ?? 'MCP 需要你的输入',
      description: normalizeDisplayText(params.message) ?? '需要补充输入后才能继续执行',
      created_at: timestamp,
      updated_at: timestamp,
      options: enumOptions.map((item) => item.option),
      questions: [],
      allow_freeform: enumOptions.length === 0,
      freeform_placeholder: '输入回复内容',
      submit_label: '继续',
    },
  }
}

const parseInteractionRequest = (
  message: AppServerNotification,
  sessionId: string,
) => {
  const requestId = normalizeInteractionRequestId(message.id)
  if (!requestId) {
    return null
  }

  const params = message.params && typeof message.params === 'object'
    ? message.params
    : {}
  const timestamp = getInteractionTimestamp()
  const completed = message.completed === true

  switch (message.method) {
    case 'item/tool/requestUserInput':
      return buildUserInputInteraction(
        sessionId,
        requestId,
        message.id!,
        params,
        completed,
        timestamp,
      )
    case 'item/commandExecution/requestApproval':
      return buildCommandExecutionInteraction(
        sessionId,
        requestId,
        message.id!,
        params,
        completed,
        timestamp,
      )
    case 'item/fileChange/requestApproval':
      return buildFileChangeInteraction(
        sessionId,
        requestId,
        message.id!,
        params,
        completed,
        timestamp,
      )
    case 'item/permissions/requestApproval':
      return buildPermissionsInteraction(
        sessionId,
        requestId,
        message.id!,
        params,
        completed,
        timestamp,
      )
    case 'mcpServer/elicitation/request':
      return buildMcpElicitationInteraction(
        sessionId,
        requestId,
        message.id!,
        params,
        completed,
        timestamp,
      )
    default:
      return null
  }
}

const pushEntry = (
  tracker: RolloutTracker,
  entries: TimelineEntry[],
  input: DraftTimelineEntry,
) => {
  const batchPreviousIndex = entries.length - 1
  const batchPrevious = batchPreviousIndex >= 0 ? entries[batchPreviousIndex] : undefined
  const trackerPreviousIndex =
    batchPrevious === undefined ? tracker.entries.length - 1 : -1
  const trackerPrevious =
    trackerPreviousIndex >= 0 ? tracker.entries[trackerPreviousIndex] : undefined
  const previous = batchPrevious ?? trackerPrevious

  if (areMergeableAssistantEntries(previous, {
    ...input,
    attachments: input.attachments ?? [],
  })) {
    const preferred = choosePreferredAssistantEntry(previous!, {
      ...input,
      attachments: input.attachments ?? previous?.attachments ?? [],
    })

    if (batchPrevious !== undefined) {
      entries[batchPreviousIndex] = preferred
    } else if (trackerPreviousIndex >= 0) {
      tracker.entries[trackerPreviousIndex] = preferred
    }

    tracker.lastEventAt = preferred.timestamp
    tracker.summary = truncateText(preferred.body, 88)
    tracker.latestAssistantMessage = normalizeAssistantPreviewText(preferred.body)
    return
  }

  const entry = {
    ...input,
    id: `${tracker.sessionId}-${++tracker.entrySeq}`,
    attachments: input.attachments ?? [],
    body_truncated: input.body_truncated ?? false,
    detail_available: input.detail_available ?? false,
    patch_summary: input.patch_summary ?? null,
    session_ids: input.session_ids ?? [],
  }
  entries.push(entry)
  tracker.lastEventAt = entry.timestamp

  if (entry.kind === 'assistant' || entry.kind === 'user') {
    tracker.summary = truncateText(entry.body, 88)
  }

  if (entry.kind === 'assistant') {
    tracker.latestAssistantMessage = normalizeAssistantPreviewText(entry.body)
  }
}

const consumeRolloutRecord = (
  tracker: RolloutTracker,
  record: { timestamp?: string; type?: string; payload?: any },
) => {
  const entries: TimelineEntry[] = []

  if (record.type === 'event_msg') {
    const eventType = record.payload?.type as string | undefined
    const eventTimestamp = record.timestamp ?? new Date().toISOString()
    markTrackerActivity(tracker, eventTimestamp)

    if (eventType === 'task_started') {
      tracker.runState = 'running'
      tracker.runStateChangedAt = eventTimestamp
      clearTrackerPlanSnapshot(tracker)
      pushEntry(tracker, entries, {
        kind: 'system',
        title: 'status',
        body: '开始处理请求',
        timestamp: eventTimestamp,
        accent: 'muted',
      })
    }

    if (eventType === 'task_complete') {
      tracker.runState = 'completed'
      tracker.runStateChangedAt = eventTimestamp
      clearTrackerPlanSnapshot(tracker)
      pushEntry(tracker, entries, {
        kind: 'system',
        title: 'status',
        body: '处理完成',
        timestamp: eventTimestamp,
        accent: 'muted',
      })
    }

    if (eventType === 'token_count') {
      tracker.contextUsage =
        parseSessionContextUsage(record.payload?.info, eventTimestamp) ??
        tracker.contextUsage
    }

    if (eventType === 'context_compacted') {
      pushEntry(tracker, entries, {
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
        pushEntry(tracker, entries, {
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
        pushEntry(tracker, entries, {
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

    return entries
  }

  if (record.type !== 'response_item') {
    return entries
  }

  const responseType = record.payload?.type as string | undefined
  const timestamp = record.timestamp ?? new Date().toISOString()
  markTrackerActivity(tracker, timestamp)

  if (responseType === 'message') {
    const role = record.payload?.role as string | undefined
    const normalizedRole = normalizeConversationRole(role)
    if (!normalizedRole) {
      return entries
    }

    const messageContent = parseMessageContent(record.payload?.content)
    const displayedText =
      role === 'user'
        ? stripInjectedUserText(messageContent.text)
        : messageContent.text.trim()
    if (!displayedText && messageContent.attachments.length === 0) {
      return entries
    }

    pushEntry(tracker, entries, {
      kind: normalizedRole.kind,
      title: normalizedRole.title,
      body: displayedText,
      timestamp,
      accent: normalizedRole.accent,
      attachments: messageContent.attachments,
    })
    return entries
  }

  if (responseType === 'reasoning') {
    const summary = extractReasoningSummary(record.payload?.summary)
    if (!summary) {
      return entries
    }

    pushEntry(tracker, entries, {
      kind: 'thinking',
      title: 'thinking',
      body: summary,
      timestamp,
      accent: 'secondary',
    })
    return entries
  }

  if (responseType === 'function_call') {
    const name = (record.payload?.name as string | undefined)?.trim() || 'tool'
    if (name === 'update_plan') {
      return entries
    }
    const argumentsPreview = safeJsonPreview(record.payload?.arguments)
    pushEntry(tracker, entries, {
      kind: 'tool',
      title: name,
      body: argumentsPreview || `调用 ${name}`,
      timestamp,
      accent: 'secondary',
    })
    return entries
  }

  if (responseType === 'function_call_output') {
    const output = safeJsonPreview(record.payload?.output)
    if (!output) {
      return entries
    }

    pushEntry(tracker, entries, {
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

    pushEntry(tracker, entries, {
      kind: 'tool',
      title: name,
      body: input || name,
      timestamp,
      accent: 'secondary',
    })
    return entries
  }

  if (responseType === 'custom_tool_call_output') {
    const output =
      typeof record.payload?.output === 'string'
        ? record.payload.output.trim()
        : safeJsonPreview(record.payload?.output)

    if (!output) {
      return entries
    }

    pushEntry(tracker, entries, {
      kind: 'tool',
      title: 'tool-output',
      body: output,
      timestamp,
      accent: 'muted',
    })
  }

  return entries
}

const normalizeTrackerPatch = (tracker: RolloutTracker): CodexSessionPatch => {
  const normalized = normalizeRunState(
    tracker.runState,
    tracker.runStateChangedAt,
    tracker.lastEventAt,
  )
  tracker.runState = normalized.runState
  tracker.runStateChangedAt = normalized.runStateChangedAt

  return {
    run_state: normalized.runState,
    run_state_changed_at: normalized.runStateChangedAt,
    summary: tracker.summary || undefined,
    latest_assistant_message:
      normalized.runState === 'running' ? null : tracker.latestAssistantMessage,
    last_event_at:
      tracker.lastEventAt !== new Date(0).toISOString()
        ? tracker.lastEventAt
        : undefined,
    context_usage: tracker.contextUsage,
  }
}

const mergeHydratedTrackerWithLiveState = (
  hydratedTracker: RolloutTracker,
  liveTracker: RolloutTracker,
) => {
  const hydratedRunStateAt = toTimestamp(hydratedTracker.runStateChangedAt)
  const liveRunStateAt = toTimestamp(liveTracker.runStateChangedAt)
  const shouldPreferLiveTrackedState =
    (liveTracker.runState === 'running' || liveTracker.runState === 'completed') &&
    Number.isFinite(liveRunStateAt) &&
    (
      !Number.isFinite(hydratedRunStateAt) ||
      liveRunStateAt >= hydratedRunStateAt
    )

  if (shouldPreferLiveTrackedState) {
    hydratedTracker.runState = liveTracker.runState
    hydratedTracker.runStateChangedAt = liveTracker.runStateChangedAt
    hydratedTracker.currentTurnId = liveTracker.currentTurnId
    hydratedTracker.turnSeq = Math.max(hydratedTracker.turnSeq, liveTracker.turnSeq)
    if (
      liveTracker.planSnapshot &&
      (
        !hydratedTracker.planSnapshot ||
        toTimestamp(liveTracker.planSnapshot.updated_at) >=
          toTimestamp(hydratedTracker.planSnapshot.updated_at)
      )
    ) {
      hydratedTracker.planSnapshot = liveTracker.planSnapshot
    }
  }

  if (!hydratedTracker.contextUsage && liveTracker.contextUsage) {
    hydratedTracker.contextUsage = liveTracker.contextUsage
  }

  if (!hydratedTracker.summary && liveTracker.summary) {
    hydratedTracker.summary = liveTracker.summary
  }

  if (!hydratedTracker.latestAssistantMessage && liveTracker.latestAssistantMessage) {
    hydratedTracker.latestAssistantMessage = liveTracker.latestAssistantMessage
  }

  const hydratedLastEventAt = toTimestamp(hydratedTracker.lastEventAt)
  const liveLastEventAt = toTimestamp(liveTracker.lastEventAt)
  if (Number.isFinite(liveLastEventAt) && (!Number.isFinite(hydratedLastEventAt) || liveLastEventAt > hydratedLastEventAt)) {
    hydratedTracker.lastEventAt = liveTracker.lastEventAt
  }

  if (liveTracker.interactionRequests.size > 0) {
    hydratedTracker.interactionRequests = new Map(liveTracker.interactionRequests)
  }
}

const mergeTrackerEntries = (
  hydratedEntries: TimelineEntry[],
  liveEntries: TimelineEntry[],
) => {
  if (liveEntries.length === 0) {
    return hydratedEntries
  }

  const seen = new Set<string>()
  return [...hydratedEntries, ...liveEntries]
    .filter((entry) => {
      if (seen.has(entry.id)) {
        return false
      }

      seen.add(entry.id)
      return true
    })
    .sort((left, right) => toTimestamp(left.timestamp) - toTimestamp(right.timestamp))
}

export type CodexLiveSessionStream = {
  start: () => Promise<void>
  stop: () => Promise<void>
  hydrateSession: (
    sessionId: string,
    filePath?: string | null,
    options?: {
      includeChangeSets?: boolean
    },
  ) => Promise<{
    entries: TimelineEntry[]
    interactionRequests: SessionInteractionRequest[]
    planSnapshot: SessionPlanSnapshot | null
    changeSets: ChangeSet[]
    sessionPatch: CodexSessionPatch
  } | null>
  ensureSessionTracker: (
    sessionId: string,
    filePath?: string | null,
  ) => Promise<boolean>
  resumeSession: (sessionId: string) => Promise<void>
  startThread: (input: {
    cwd: string
    title?: string | null
    prompt?: string | null
    attachments?: SessionInputAttachment[]
    model?: string | null
    reasoningEffort?: string | null
    serviceTier?: 'fast' | 'flex' | null
    yoloMode?: boolean
  }) => Promise<{
    sessionId: string
    turnId: string | null
  }>
  sendUserInput: (input: {
    sessionId: string
    prompt: string
    attachments?: SessionInputAttachment[]
    model?: string | null
    reasoningEffort?: string | null
    serviceTier?: 'fast' | 'flex' | null
    yoloMode?: boolean
  }) => Promise<{
    turnId: string | null
  }>
  runOneShotPrompt: (input: {
    cwd: string
    prompt: string
    model?: string | null
    reasoningEffort?: string | null
    timeoutMs?: number | null
  }) => Promise<string>
  listSkills: (input: {
    cwd: string
    forceReload?: boolean
  }) => Promise<ProjectSkill[]>
  listModels: () => Promise<CodexAvailableModel[]>
  listMcpServers: () => Promise<CodexMcpServer[]>
  readConfig: (input?: {
    cwd?: string | null
  }) => Promise<CodexCliConfig>
  compactThread: (sessionId: string) => Promise<void>
  respondToInteraction: (input: {
    sessionId: string
    requestId: string
    optionId?: string | null
    text?: string | null
    answers?: Record<string, string> | null
  }) => Promise<void>
  interruptTurn: (sessionId: string) => Promise<void>
  setThreadName: (sessionId: string, title: string) => Promise<void>
  peekSessionPatch: (sessionId: string) => CodexSessionPatch | null
  resumeSessionWithAppServer: (
    sessionId: string,
  ) => Promise<{
    sessionPatch: CodexSessionPatch
    interactionRequests: SessionInteractionRequest[]
    planSnapshot: SessionPlanSnapshot | null
  } | null>
}

export const createCodexLiveSessionStream = (options?: {
  codexHome?: string
  appServerMode?: AppServerMode
  onEvent?: (event: CodexLiveSessionEvent) => void
  onSkillsChanged?: () => void
  logger?: LiveSessionLogger
}) : CodexLiveSessionStream => {
  const codexHome = options?.codexHome ?? defaultCodexHome()
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ]
  const trackersBySessionId = new Map<string, RolloutTracker>()
  const trackersByFilePath = new Map<string, RolloutTracker>()
  const changeSetsBySessionId = new Map<string, Map<string, ChangeSetTracker>>()
  const pending = new Map<string, NodeJS.Timeout>()
  const watchers: fs.FSWatcher[] = []
  let pollTimer: NodeJS.Timeout | null = null
  let stopped = false
  let appServerConnection: AppServerConnection | null = null
  let appServerInitialized = false
  let appServerStdoutBuffer = ''
  let nextRequestId = 1
  const appServerQueue: Array<{
    requestId: string
    message: string
  }> = []
  let appServerInitializeRequestId = ''
  let appServerInitializeTimer: ReturnType<typeof setTimeout> | null = null
  let appServerInitializationError: Error | null = null
  let appServerStderrBuffer = ''
  const pendingAppServerRequests = new Map<string, PendingAppServerRequest>()
  const planSnapshotsBySessionId = new Map<string, SessionPlanSnapshot | null>()
  const lastAppServerRequestBySessionId = new Map<string, Record<string, unknown>>()

  const logDiagnostic = (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    payload: Record<string, unknown>,
  ) => {
    const logger = options?.logger
    if (!logger) {
      return
    }

    const method =
      level === 'debug'
        ? logger.debug
        : logger[level]
    method?.call(logger, payload, message)
  }

  const upsertTracker = (tracker: RolloutTracker) => {
    const existing = trackersBySessionId.get(tracker.sessionId)
    if (existing && existing !== tracker && existing.filePath !== tracker.filePath) {
      trackersByFilePath.delete(existing.filePath)
    }
    trackersBySessionId.set(tracker.sessionId, tracker)
    trackersByFilePath.set(tracker.filePath, tracker)
    planSnapshotsBySessionId.set(tracker.sessionId, tracker.planSnapshot)
  }

  const ensureSyntheticTracker = (sessionId: string) => {
    const existing = trackersBySessionId.get(sessionId)
    if (existing) {
      return existing
    }

    const tracker = createTracker(sessionId, `${APP_SERVER_TRACKER_PREFIX}${sessionId}`, 0)
    upsertTracker(tracker)
    return tracker
  }

  const getRecentAppServerRequestAt = (sessionId: string) => {
    const request = lastAppServerRequestBySessionId.get(sessionId)
    return typeof request?.startedAt === 'number' ? request.startedAt : 0
  }

  const getTrackerRecentActivityAt = (tracker: RolloutTracker) =>
    Math.max(
      toTimestamp(tracker.runStateChangedAt),
      toTimestamp(tracker.lastEventAt),
      getRecentAppServerRequestAt(tracker.sessionId),
    )

  const listRuntimeDiagnosticTargetTrackers = () => {
    const allTrackers = [...trackersBySessionId.values()]
    const runningTrackers = allTrackers
      .filter((tracker) => tracker.runState === 'running' || Boolean(tracker.currentTurnId))
      .sort((left, right) => getTrackerRecentActivityAt(right) - getTrackerRecentActivityAt(left))

    if (runningTrackers.length > 0) {
      return runningTrackers
    }

    const now = Date.now()
    return allTrackers
      .filter((tracker) => {
        const recentRequestAt = getRecentAppServerRequestAt(tracker.sessionId)
        return recentRequestAt > 0 && now - recentRequestAt <= APP_SERVER_RUNTIME_DIAGNOSTIC_WINDOW_MS
      })
      .sort((left, right) => getTrackerRecentActivityAt(right) - getTrackerRecentActivityAt(left))
  }

  const emitRuntimeDiagnosticEntry = (tracker: RolloutTracker, body: string) => {
    const now = Date.now()
    const diagnosticSignature = createDiagnosticHash(
      `${tracker.currentTurnId ?? tracker.runStateChangedAt ?? tracker.sessionId}:${body}`,
    )

    if (
      tracker.lastRuntimeDiagnosticHash === diagnosticSignature &&
      now - tracker.lastRuntimeDiagnosticAt <= APP_SERVER_RUNTIME_DIAGNOSTIC_DEDUPE_MS
    ) {
      return
    }

    tracker.lastRuntimeDiagnosticHash = diagnosticSignature
    tracker.lastRuntimeDiagnosticText = body
    tracker.lastRuntimeDiagnosticAt = now

    const entries: TimelineEntry[] = []
    pushEntry(tracker, entries, {
      kind: 'system',
      title: 'runtime-status',
      body,
      timestamp: new Date(now).toISOString(),
      accent: body.startsWith('Reconnecting...') ? 'secondary' : 'muted',
    })

    if (entries.length === 0) {
      return
    }

    if (tracker.hydrated) {
      tracker.entries.push(...entries)
    }

    emitTrackerUpdate(tracker, entries, tracker.planSnapshot, false, [], 'app-server')
  }

  const broadcastRuntimeDiagnostic = (body: string) => {
    for (const tracker of listRuntimeDiagnosticTargetTrackers()) {
      emitRuntimeDiagnosticEntry(tracker, body)
    }
  }

  const findTrackerByInteractionRequestId = (requestId: string) => {
    for (const tracker of trackersBySessionId.values()) {
      if (tracker.interactionRequests.has(requestId)) {
        return tracker
      }
    }

    return null
  }

  const findTrackerByTurnId = (turnId: string) => {
    for (const tracker of trackersBySessionId.values()) {
      if (tracker.currentTurnId === turnId) {
        return tracker
      }
    }

    return null
  }

  const attachTrackerToFilePath = (
    tracker: RolloutTracker,
    filePath: string,
    offset?: number,
  ) => {
    if (tracker.filePath !== filePath) {
      trackersByFilePath.delete(tracker.filePath)
      tracker.filePath = filePath
    }

    if (typeof offset === 'number' && Number.isFinite(offset)) {
      tracker.offset = Math.max(0, offset)
    }

    upsertTracker(tracker)
  }

  const extractThreadStatusType = (status: unknown) => {
    if (typeof status === 'string') {
      return status
    }

    if (
      status &&
      typeof status === 'object' &&
      typeof (status as { type?: unknown }).type === 'string'
    ) {
      return (status as { type: string }).type
    }

    return ''
  }

const extractThreadActiveFlags = (status: unknown) => {
    if (!status || typeof status !== 'object') {
      return []
    }

    return Array.isArray((status as { activeFlags?: unknown }).activeFlags)
      ? (status as { activeFlags: unknown[] }).activeFlags.filter(
          (item): item is string => typeof item === 'string',
        )
      : []
  }

  const extractThreadStatusReason = (status: unknown) => {
    if (!status || typeof status !== 'object') {
      return ''
    }

    const candidate = status as {
      message?: unknown
      reason?: unknown
      error?: unknown
    }

    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      return candidate.message.trim()
    }

    if (typeof candidate.reason === 'string' && candidate.reason.trim()) {
      return candidate.reason.trim()
    }

    if (
      candidate.error &&
      typeof candidate.error === 'object' &&
      typeof (candidate.error as { message?: unknown }).message === 'string'
    ) {
      return ((candidate.error as { message: string }).message ?? '').trim()
    }

    return ''
  }

  const formatOneShotPromptFailure = (reason?: string | null) =>
    reason?.trim()
      ? `Codex 草拟命令失败：${reason.trim()}`
      : 'Codex 草拟命令失败，Codex 会话异常中断。'

  const getThreadTurns = (thread: unknown) => {
    if (!thread || typeof thread !== 'object') {
      return []
    }

    return Array.isArray((thread as { turns?: unknown }).turns)
      ? (thread as { turns: unknown[] }).turns
      : []
  }

  const extractActiveTurnId = (thread: unknown) => {
    const turns = getThreadTurns(thread)

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]
      if (!turn || typeof turn !== 'object') {
        continue
      }

      const turnId =
        typeof (turn as { id?: unknown }).id === 'string'
          ? (turn as { id: string }).id
          : ''
      const turnStatus =
        typeof (turn as { status?: unknown }).status === 'string'
          ? (turn as { status: string }).status
          : ''

      if (turnId && turnStatus === 'inProgress') {
        return turnId
      }
    }

    return null
  }

  const extractMostRecentTurnId = (thread: unknown) => {
    const turns = getThreadTurns(thread)

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]
      if (!turn || typeof turn !== 'object') {
        continue
      }

      const turnId =
        typeof (turn as { id?: unknown }).id === 'string'
          ? (turn as { id: string }).id
          : ''
      if (turnId) {
        return turnId
      }
    }

    return null
  }

  const extractInterruptibleTurnId = (thread: unknown) => {
    const activeTurnId = extractActiveTurnId(thread)
    if (activeTurnId) {
      return activeTurnId
    }

    const status = thread && typeof thread === 'object'
      ? (thread as { status?: unknown }).status
      : null
    const statusType = extractThreadStatusType(status)
    if (statusType !== 'active' && statusType !== 'inProgress') {
      return null
    }

    return extractMostRecentTurnId(thread)
  }

  const applyThreadPayloadToTracker = (
    tracker: RolloutTracker,
    thread: unknown,
    timestamp: string,
  ) => {
    const status = thread && typeof thread === 'object'
      ? (thread as { status?: unknown }).status
      : null
    const statusType = extractThreadStatusType(status)
    const activeFlags = new Set(extractThreadActiveFlags(status))
    const activeTurnId = extractInterruptibleTurnId(thread)

    if (activeTurnId) {
      tracker.currentTurnId = activeTurnId
    } else if (statusType === 'idle' || statusType === 'notLoaded' || statusType === 'systemError') {
      tracker.currentTurnId = null
    }

    if (
      (statusType === 'active' || statusType === 'inProgress') &&
      !activeFlags.has('waitingOnUserInput')
    ) {
      tracker.runState = 'running'
      tracker.runStateChangedAt = timestamp
      syncTrackerPlanActivity(tracker, timestamp)
      return
    }

    const shouldPreserveRunningTurn =
      tracker.runState === 'running' &&
      (
        Boolean(tracker.currentTurnId) ||
        (
          Number.isFinite(toTimestamp(tracker.lastEventAt)) &&
          Date.now() - toTimestamp(tracker.lastEventAt) <= ACTIVE_WINDOW_MS
        )
      ) &&
      (
        statusType === 'idle' ||
        statusType === 'notLoaded' ||
        activeFlags.has('waitingOnUserInput')
      )

    // App-server can briefly report an idle/waiting thread between model steps
    // while the same turn is still active. Only a real turn terminal signal
    // should end the run-state in that case.
    if (shouldPreserveRunningTurn) {
      syncTrackerPlanActivity(tracker, timestamp)
      return
    }

    if (
      statusType === 'idle' ||
      statusType === 'notLoaded' ||
      statusType === 'systemError' ||
      activeFlags.has('waitingOnUserInput')
    ) {
      if (
        tracker.runState === 'completed' &&
        tracker.runStateChangedAt &&
        Date.now() - new Date(tracker.runStateChangedAt).getTime() <= COMPLETED_STATE_TTL_MS
      ) {
        return
      }

      tracker.runState = 'idle'
      tracker.runStateChangedAt = null
    }
  }

  const updateTrackerPlanSnapshot = (
    tracker: RolloutTracker,
    input: ParsedPlanPayload,
    source: 'rollout' | 'app-server',
    timestamp: string,
  ) => {
    const turnId = tracker.currentTurnId
    const nextSnapshot: SessionPlanSnapshot = {
      session_id: tracker.sessionId,
      turn_id: turnId,
      source,
      updated_at: timestamp,
      explanation: input.explanation,
      steps: input.steps,
      completed_count: input.steps.filter((step) => step.status === 'completed').length,
      total_count: input.steps.length,
      is_active: tracker.runState === 'running',
    }

    const previousSnapshot = tracker.planSnapshot
    const previousSignature = previousSnapshot ? JSON.stringify(previousSnapshot) : ''
    const nextSignature = JSON.stringify(nextSnapshot)
    if (previousSignature === nextSignature) {
      tracker.planSnapshot = nextSnapshot
      planSnapshotsBySessionId.set(tracker.sessionId, nextSnapshot)
      return false
    }

    tracker.planSnapshot = nextSnapshot
    planSnapshotsBySessionId.set(tracker.sessionId, nextSnapshot)
    return true
  }

  const syncTrackerPlanActivity = (tracker: RolloutTracker, timestamp: string) => {
    syncPlanSnapshotActivity(tracker, timestamp)
    planSnapshotsBySessionId.set(tracker.sessionId, tracker.planSnapshot)
  }

  const getSessionChangeSetStore = (sessionId: string) => {
    let store = changeSetsBySessionId.get(sessionId)
    if (!store) {
      store = new Map<string, ChangeSetTracker>()
      changeSetsBySessionId.set(sessionId, store)
    }
    return store
  }

  const serializeChangeSet = (tracker: ChangeSetTracker): ChangeSet => ({
    id: tracker.id,
    session_id: tracker.sessionId,
    turn_id: tracker.turnId,
    source: tracker.source,
    status: tracker.status,
    started_at: tracker.startedAt,
    completed_at: tracker.completedAt,
    updated_at: tracker.updatedAt,
    aggregated_diff: tracker.aggregatedDiff,
    files: tracker.fileOrder
      .map((filePath) => tracker.files.get(filePath))
      .filter((file): file is ChangeFile => Boolean(file)),
  })

  const listSerializedChangeSets = (sessionId: string) => {
    const store = changeSetsBySessionId.get(sessionId)
    if (!store) {
      return []
    }

    return [...store.values()]
      .sort((a, b) => {
        const startDiff = +new Date(a.startedAt) - +new Date(b.startedAt)
        if (startDiff !== 0) {
          return startDiff
        }

        return +new Date(a.updatedAt) - +new Date(b.updatedAt)
      })
      .map(serializeChangeSet)
  }

  const ensureChangeSetTracker = (
    sessionId: string,
    turnId: string,
    source: ChangeSetSource,
    startedAt: string,
  ) => {
    const store = getSessionChangeSetStore(sessionId)
    const existing = store.get(turnId)
    if (existing) {
      if (source === 'app-server' && existing.source !== 'app-server') {
        existing.source = 'app-server'
      }
      if (+new Date(startedAt) < +new Date(existing.startedAt)) {
        existing.startedAt = startedAt
      }
      existing.updatedAt = startedAt
      return existing
    }

    const tracker: ChangeSetTracker = {
      id: `${sessionId}:${turnId}`,
      sessionId,
      turnId,
      source,
      status: 'running',
      startedAt,
      completedAt: null,
      updatedAt: startedAt,
      aggregatedDiff: '',
      files: new Map<string, ChangeFile>(),
      fileOrder: [],
      itemPaths: new Map<string, string[]>(),
    }
    store.set(turnId, tracker)
    return tracker
  }

  const removeRolloutFallbackChangeSets = (sessionId: string) => {
    const store = getSessionChangeSetStore(sessionId)
    for (const [turnId, tracker] of store) {
      if (tracker.source === 'rollout-fallback') {
        store.delete(turnId)
      }
    }
  }

  const renameChangeSetTracker = (
    sessionId: string,
    fromTurnId: string,
    toTurnId: string,
    nextSource: ChangeSetSource,
  ) => {
    if (fromTurnId === toTurnId) {
      return getSessionChangeSetStore(sessionId).get(fromTurnId) ?? null
    }

    const store = getSessionChangeSetStore(sessionId)
    const existing = store.get(fromTurnId)
    if (!existing) {
      return null
    }

    store.delete(fromTurnId)
    existing.turnId = toTurnId
    existing.id = `${sessionId}:${toTurnId}`
    existing.source = nextSource
    store.set(toTurnId, existing)
    return existing
  }

  const upsertChangeFile = (
    changeSetTracker: ChangeSetTracker,
    nextFile: ChangeFile,
    options?: { overrideDiff?: boolean },
  ) => {
    const normalizedPath = nextFile.path.replace(/\\/g, '/')
    const storeKey = getChangeFileStoreKey({
      path: normalizedPath,
      item_id: nextFile.item_id,
    })
    const existing = changeSetTracker.files.get(storeKey)
    if (!existing) {
      changeSetTracker.files.set(storeKey, {
        ...nextFile,
        path: normalizedPath,
      })
      changeSetTracker.fileOrder.push(storeKey)
      return
    }

    existing.kind = nextFile.kind
    existing.move_path = nextFile.move_path
    existing.item_id = nextFile.item_id
    existing.additions = nextFile.additions
    existing.deletions = nextFile.deletions
    if (options?.overrideDiff ?? true) {
      existing.diff = nextFile.diff
    } else if (nextFile.diff) {
      existing.diff = `${existing.diff}\n${nextFile.diff}`.trim()
    }
  }

  const getLatestChangeFileByPath = (changeSetTracker: ChangeSetTracker, filePath: string) => {
    const normalizedPath = filePath.replace(/\\/g, '/')
    for (let index = changeSetTracker.fileOrder.length - 1; index >= 0; index -= 1) {
      const storeKey = changeSetTracker.fileOrder[index]
      if (!storeKey) {
        continue
      }

      const candidate = changeSetTracker.files.get(storeKey)
      if (candidate?.path === normalizedPath) {
        return candidate
      }
    }

    return null
  }

  const applyUnifiedDiffToChangeSet = (changeSetTracker: ChangeSetTracker, unifiedDiff: string) => {
    changeSetTracker.aggregatedDiff = normalizeDiffText(unifiedDiff)
    if (!changeSetTracker.aggregatedDiff) {
      return
    }

    for (const diffBlock of splitUnifiedDiffByFile(changeSetTracker.aggregatedDiff)) {
      if (!diffBlock.path) {
        continue
      }

      const existing = getLatestChangeFileByPath(changeSetTracker, diffBlock.path)
      const kind = existing?.kind ?? 'update'
      const counts = getDiffCounts(kind, diffBlock.diff)
      upsertChangeFile(changeSetTracker, {
        path: diffBlock.path,
        kind,
        move_path: existing?.move_path ?? null,
        additions:
          existing && existing.additions > counts.additions ? existing.additions : counts.additions,
        deletions:
          existing && existing.deletions > counts.deletions ? existing.deletions : counts.deletions,
        diff: diffBlock.diff,
        item_id: existing?.item_id ?? null,
      })
    }
  }

  const setChangeSetFiles = (
    changeSetTracker: ChangeSetTracker,
    files: ChangeFile[],
    options?: { overrideDiff?: boolean },
  ) => {
    for (const nextFile of files) {
      upsertChangeFile(changeSetTracker, nextFile, options)
    }
  }

  const serializeUpdatedChangeSets = (sessionId: string, turnIds: Iterable<string>) => {
    const store = changeSetsBySessionId.get(sessionId)
    if (!store) {
      return []
    }

    const uniqueTurnIds = [...new Set([...turnIds].filter(Boolean))]
    return uniqueTurnIds
      .map((turnId) => store.get(turnId))
      .filter((tracker): tracker is ChangeSetTracker => Boolean(tracker))
      .map(serializeChangeSet)
  }

const parseAppServerPlanSnapshot = (
  tracker: RolloutTracker,
  item: Record<string, unknown>,
  timestamp: string,
) => {
    const itemType = typeof item.type === 'string' ? item.type : ''
    const itemName =
      typeof item.name === 'string'
        ? item.name
        : typeof item.title === 'string'
          ? item.title
          : ''

    if (
      itemName !== 'update_plan' ||
      (itemType !== 'functionCall' &&
        itemType !== 'function_call' &&
        itemType !== 'toolCall' &&
        itemType !== 'tool_call')
    ) {
      return null
    }

    const parsedPlan = parsePlanArguments(
      item.arguments ??
        item.input ??
        item.payload ??
        item.args,
    )
    if (!parsedPlan) {
      return null
    }

  return updateTrackerPlanSnapshot(tracker, parsedPlan, 'app-server', timestamp)
      ? tracker.planSnapshot
      : null
  }

  const buildAppServerItemEntries = (
    tracker: RolloutTracker,
    item: Record<string, unknown>,
    timestamp: string,
  ) => {
    const entries: TimelineEntry[] = []
    const itemType =
      typeof item.type === 'string'
        ? item.type.trim()
        : ''
    const explicitRole =
      typeof item.role === 'string'
        ? item.role.trim()
        : ''
    const normalizedRole =
      normalizeConversationRole(explicitRole || undefined) ??
      (itemType === 'agentMessage'
        ? normalizeConversationRole('assistant')
        : itemType === 'userMessage'
          ? normalizeConversationRole('user')
          : null)
    if (!normalizedRole) {
      return entries
    }

    // Panda already renders optimistic user input locally, and the rollout log
    // later emits the authoritative user message again. Treating app-server
    // userMessage items as a second timeline source causes sticky duplicates.
    if (itemType === 'userMessage') {
      return entries
    }

    const content =
      Array.isArray(item.content)
        ? item.content
        : Array.isArray(item.contents)
          ? item.contents
          : Array.isArray(item.output)
            ? item.output
            : Array.isArray(item.items)
              ? item.items
              : itemType === 'agentMessage' &&
                  typeof item.text === 'string' &&
                  item.text.trim()
                ? [{
                    type: 'output_text',
                    text: item.text,
                  }]
                : itemType === 'userMessage' &&
                    typeof item.text === 'string' &&
                    item.text.trim()
                ? [{
                    type: 'input_text',
                    text: item.text,
                  }]
                : typeof item.text === 'string' && item.text.trim()
                  ? [{
                      type: normalizedRole.kind === 'assistant' ? 'output_text' : 'input_text',
                      text: item.text,
                    }]
                  : typeof item.output_text === 'string' && item.output_text.trim()
                  ? [{
                      type: 'output_text',
                      text: item.output_text,
                    }]
                  : []
    const messageContent = parseMessageContent(content)
    const displayedText =
      normalizedRole.kind === 'user'
        ? stripInjectedUserText(messageContent.text)
        : messageContent.text.trim()
    if (!displayedText && messageContent.attachments.length === 0) {
      return entries
    }

    pushEntry(tracker, entries, {
      kind: normalizedRole.kind,
      title: normalizedRole.title,
      body: displayedText,
      timestamp,
      accent: normalizedRole.accent,
      attachments: messageContent.attachments,
    })
    return entries
  }

  const resolveFilePathForSession = async (sessionId: string) => {
    const existing = trackersBySessionId.get(sessionId)
    if (existing) {
      return existing.filePath
    }

    for (const rootPath of roots) {
      const files = await walkRolloutFiles(rootPath)
      for (const filePath of files) {
        const candidateSessionId = await readSessionIdFromRollout(filePath)
        if (candidateSessionId === sessionId) {
          return filePath
        }
      }
    }

    return null
  }

  const ensureTracker = async (sessionId: string, filePath?: string | null) => {
    const existing = trackersBySessionId.get(sessionId)
    const shouldResolveExistingSyntheticPath =
      existing?.filePath.startsWith(APP_SERVER_TRACKER_PREFIX) ?? false
    const resolvedFilePath =
      filePath ??
      (shouldResolveExistingSyntheticPath ? await resolveFilePathForSession(sessionId) : null) ??
      (!existing?.filePath.startsWith(APP_SERVER_TRACKER_PREFIX) ? existing?.filePath : null)

    if (existing) {
      if (resolvedFilePath && existing.filePath !== resolvedFilePath) {
        const stat = await fsp.stat(resolvedFilePath).catch(() => null)
        attachTrackerToFilePath(existing, resolvedFilePath, stat?.size ?? existing.offset)
      }
      return existing
    }

    if (!resolvedFilePath) {
      return null
    }

    const stat = await fsp.stat(resolvedFilePath).catch(() => null)
    const tracker = createTracker(sessionId, resolvedFilePath, stat?.size ?? 0)
    upsertTracker(tracker)
    return tracker
  }

  const consumeRolloutChangeSetRecord = (
    tracker: RolloutTracker,
    record: { timestamp?: string; type?: string; payload?: any },
  ) => {
    const updatedTurnIds: string[] = []

  if (record.type === 'event_msg') {
    const eventType = record.payload?.type as string | undefined
    const eventTimestamp = record.timestamp ?? new Date().toISOString()
    markTrackerActivity(tracker, eventTimestamp)

    if (eventType === 'task_started') {
        tracker.currentTurnId = `rollout-turn-${++tracker.turnSeq}`
        const changeSetTracker = ensureChangeSetTracker(
          tracker.sessionId,
          tracker.currentTurnId,
          'rollout-fallback',
          eventTimestamp,
        )
        changeSetTracker.status = 'running'
        changeSetTracker.updatedAt = eventTimestamp
        updatedTurnIds.push(changeSetTracker.turnId)
      }

      if (eventType === 'task_complete' && tracker.currentTurnId) {
        const changeSetTracker = ensureChangeSetTracker(
          tracker.sessionId,
          tracker.currentTurnId,
          'rollout-fallback',
          tracker.runStateChangedAt ?? eventTimestamp,
        )
        changeSetTracker.status = 'completed'
        changeSetTracker.completedAt = eventTimestamp
        changeSetTracker.updatedAt = eventTimestamp
        updatedTurnIds.push(changeSetTracker.turnId)
        tracker.currentTurnId = null
      }

      return updatedTurnIds
    }

    if (record.type !== 'response_item' || !tracker.currentTurnId) {
      return updatedTurnIds
    }

  const responseType = record.payload?.type as string | undefined
  const timestamp = record.timestamp ?? new Date().toISOString()
  markTrackerActivity(tracker, timestamp)

    if (
      (responseType === 'custom_tool_call' || responseType === 'function_call') &&
      typeof record.payload?.name === 'string' &&
      record.payload.name.trim() === 'apply_patch'
    ) {
      const changeSetTracker = ensureChangeSetTracker(
        tracker.sessionId,
        tracker.currentTurnId,
        'rollout-fallback',
        tracker.runStateChangedAt ?? timestamp,
      )
      const patchInput =
        typeof record.payload?.input === 'string'
          ? record.payload.input
          : typeof record.payload?.arguments === 'string'
            ? record.payload.arguments
            : ''
      const files = parseApplyPatchChangeFiles(patchInput)
      if (files.length > 0) {
        const patchBatchId = `rollout-apply-patch-${++tracker.patchSeq}`
        setChangeSetFiles(
          changeSetTracker,
          files.map((file, index) => ({
            ...file,
            item_id: `${patchBatchId}:${index}`,
          })),
          { overrideDiff: false },
        )
        changeSetTracker.aggregatedDiff = changeSetTracker.fileOrder
          .map((filePath) => changeSetTracker.files.get(filePath)?.diff ?? '')
          .filter(Boolean)
          .join('\n\n')
        changeSetTracker.updatedAt = timestamp
        updatedTurnIds.push(changeSetTracker.turnId)
      }
    }

    return updatedTurnIds
  }

  const consumeRolloutPlanRecord = (
    tracker: RolloutTracker,
    record: { timestamp?: string; type?: string; payload?: any },
  ) => {
    if (record.type !== 'response_item') {
      return false
    }

    const responseType = record.payload?.type as string | undefined
    if (responseType !== 'function_call') {
      return false
    }

    const name = (record.payload?.name as string | undefined)?.trim()
    if (name !== 'update_plan') {
      return false
    }

    const parsedPlan = parsePlanArguments(record.payload?.arguments)
    if (!parsedPlan) {
      return false
    }

    const timestamp = record.timestamp ?? new Date().toISOString()
    return updateTrackerPlanSnapshot(tracker, parsedPlan, 'rollout', timestamp)
  }

  const emitTrackerUpdate = (
    tracker: RolloutTracker,
    entries: TimelineEntry[],
    planSnapshot: SessionPlanSnapshot | null,
    planReset: boolean,
    changeSets: ChangeSet[],
    source: 'rollout' | 'app-server',
    interactionRequests: SessionInteractionRequest[] = [],
    interactionReset = false,
    resolvedInteractionIds: string[] = [],
    discoveredAtRuntime = false,
  ) => {
    if (
      entries.length === 0 &&
      interactionRequests.length === 0 &&
      resolvedInteractionIds.length === 0 &&
      source === 'rollout'
    ) {
      options?.onEvent?.({
        sessionId: tracker.sessionId,
        filePath: tracker.filePath,
        entries: [],
        interactionRequests,
        interactionReset,
        resolvedInteractionIds,
        planSnapshot,
        planReset,
        changeSets,
        sessionPatch: normalizeTrackerPatch(tracker),
        source,
        discoveredAtRuntime,
      })
      return
    }

    options?.onEvent?.({
      sessionId: tracker.sessionId,
      filePath: tracker.filePath,
      entries,
      interactionRequests,
      interactionReset,
      resolvedInteractionIds,
      planSnapshot,
      planReset,
      changeSets,
      sessionPatch: normalizeTrackerPatch(tracker),
      source,
      discoveredAtRuntime,
    })
  }

  const processChunk = async (tracker: RolloutTracker, chunk: string, discoveredAtRuntime = false) => {
    if (!chunk) {
      return
    }

    const combined = `${tracker.partialLine}${chunk}`
    const lines = combined.split('\n')
    tracker.partialLine = lines.pop() || ''

    const deltaEntries: TimelineEntry[] = []
    let nextPlanSnapshot: SessionPlanSnapshot | null = null
    let planReset = false
    const changedTurnIds: string[] = []
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) {
        continue
      }

      try {
        const parsed = JSON.parse(line) as { timestamp?: string; type?: string; payload?: any }
        const previousPlanSignature = tracker.planSnapshot
          ? JSON.stringify(tracker.planSnapshot)
          : ''
        const nextEntries = consumeRolloutRecord(tracker, parsed)
        consumeRolloutPlanRecord(tracker, parsed)
        changedTurnIds.push(...consumeRolloutChangeSetRecord(tracker, parsed))
        const nextPlanSignature = tracker.planSnapshot
          ? JSON.stringify(tracker.planSnapshot)
          : ''
        if (previousPlanSignature !== nextPlanSignature) {
          nextPlanSnapshot = tracker.planSnapshot
          if (!tracker.planSnapshot && previousPlanSignature) {
            planReset = true
          }
        }
        if (tracker.hydrated && nextEntries.length > 0) {
          tracker.entries.push(...nextEntries)
        }
        deltaEntries.push(...nextEntries)
      } catch {
        continue
      }
    }

    emitTrackerUpdate(
      tracker,
      deltaEntries,
      nextPlanSnapshot,
      planReset,
      serializeUpdatedChangeSets(tracker.sessionId, changedTurnIds),
      'rollout',
      [],
      false,
      [],
      discoveredAtRuntime,
    )
  }

  const tailTracker = async (tracker: RolloutTracker, discoveredAtRuntime = false) => {
    const stat = await fsp.stat(tracker.filePath).catch(() => null)
    if (!stat?.isFile()) {
      trackersBySessionId.delete(tracker.sessionId)
      trackersByFilePath.delete(tracker.filePath)
      return
    }

    if (stat.size < tracker.offset) {
      tracker.offset = 0
      tracker.partialLine = ''
      tracker.entries = []
      tracker.entrySeq = 0
      tracker.hydrated = false
      tracker.turnSeq = 0
      tracker.currentTurnId = null
      removeRolloutFallbackChangeSets(tracker.sessionId)
    }

    if (stat.size === tracker.offset) {
      return
    }

    const chunk = await readFileSlice(tracker.filePath, tracker.offset, stat.size)
    tracker.offset = stat.size
    await processChunk(tracker, chunk, discoveredAtRuntime)
  }

  const scheduleTail = (filePath: string) => {
    const existing = pending.get(filePath)
    if (existing) {
      clearTimeout(existing)
    }

    pending.set(
      filePath,
      setTimeout(async () => {
        pending.delete(filePath)

        let tracker = trackersByFilePath.get(filePath)
        let discoveredAtRuntime = false
        if (!tracker) {
          const sessionId = await readSessionIdFromRollout(filePath)
          if (!sessionId) {
            return
          }

          const stat = await fsp.stat(filePath).catch(() => null)
          tracker = trackersBySessionId.get(sessionId) ?? createTracker(sessionId, filePath, 0)
          attachTrackerToFilePath(tracker, filePath, stat?.isFile() ? 0 : tracker.offset)
          discoveredAtRuntime = true
        }

        await tailTracker(tracker, discoveredAtRuntime)
      }, WATCH_DEBOUNCE_MS),
    )
  }

  const seedExistingFiles = async () => {
    const files = (
      await Promise.all(roots.map((rootPath) => walkRolloutFiles(rootPath)))
    ).flat()

    await Promise.all(
      files.map(async (filePath) => {
        const sessionId = await readSessionIdFromRollout(filePath)
        if (!sessionId) {
          return
        }

        const stat = await fsp.stat(filePath).catch(() => null)
        const tracker =
          trackersBySessionId.get(sessionId) ?? createTracker(sessionId, filePath, stat?.size ?? 0)
        attachTrackerToFilePath(tracker, filePath, stat?.size ?? tracker.offset)
      }),
    )
  }

  const startPolling = () => {
    if (pollTimer) {
      return
    }

    pollTimer = setInterval(async () => {
      const files = (
        await Promise.all(roots.map((rootPath) => walkRolloutFiles(rootPath)))
      ).flat()

      for (const filePath of files) {
        const tracker = trackersByFilePath.get(filePath)
        if (!tracker) {
          scheduleTail(filePath)
          continue
        }

        const stat = await fsp.stat(filePath).catch(() => null)
        if (!stat?.isFile()) {
          continue
        }

        if (stat.size !== tracker.offset) {
          scheduleTail(filePath)
        }
      }
    }, FALLBACK_SCAN_INTERVAL_MS)
  }

  const bindWatchers = async () => {
    for (const rootPath of roots) {
      try {
        await fsp.mkdir(rootPath, { recursive: true })
      } catch {
        continue
      }

      try {
        const watcher = fs.watch(rootPath, { recursive: true }, (_eventType, filename) => {
          if (stopped || !filename) {
            return
          }

          const fullPath = path.join(rootPath, filename.toString())
          if (fullPath.endsWith('.jsonl')) {
            scheduleTail(fullPath)
          }
        })

        watcher.on('error', () => {
          startPolling()
        })

        watchers.push(watcher)
      } catch {
        startPolling()
      }
    }
  }

  const normalizeAppServerFileChanges = (item: Record<string, unknown>) => {
    const rawChanges = Array.isArray(item.changes) ? item.changes : []
    return rawChanges
      .map((change) => {
        if (!change || typeof change !== 'object') {
          return null
        }

        const candidate = change as {
          path?: unknown
          diff?: unknown
          kind?: { type?: unknown; move_path?: unknown }
        }
        if (typeof candidate.path !== 'string') {
          return null
        }

        const kindType =
          candidate.kind?.type === 'add' || candidate.kind?.type === 'delete'
            ? candidate.kind.type
            : 'update'
        const diff = typeof candidate.diff === 'string' ? candidate.diff : ''
        const counts = getDiffCounts(kindType, diff)

        return {
          path: candidate.path,
          kind: kindType,
          move_path:
            candidate.kind?.type === 'update' && typeof candidate.kind?.move_path === 'string'
              ? candidate.kind.move_path
              : null,
          additions: counts.additions,
          deletions: counts.deletions,
          diff,
          item_id: typeof item.id === 'string' ? item.id : null,
        } satisfies ChangeFile
      })
      .filter((change): change is ChangeFile => Boolean(change))
  }

  const flushAppServerQueue = () => {
    if (!appServerConnection || !appServerInitialized || appServerQueue.length === 0) {
      return
    }

    for (const item of appServerQueue.splice(0, appServerQueue.length)) {
      appServerConnection.send(item.message)
    }
  }

  const clearAppServerInitializeTimer = () => {
    if (appServerInitializeTimer) {
      clearTimeout(appServerInitializeTimer)
      appServerInitializeTimer = null
    }
  }

  const rejectPendingAppServerRequests = (error: Error) => {
    for (const [requestId, pendingRequest] of pendingAppServerRequests.entries()) {
      clearTimeout(pendingRequest.timeout)
      pendingAppServerRequests.delete(requestId)
      pendingRequest.reject(error)
    }
  }

  const failAppServerInitialization = (error: Error) => {
    appServerInitializationError = error
    clearAppServerInitializeTimer()
    appServerQueue.length = 0
    rejectPendingAppServerRequests(error)
    logDiagnostic('error', 'Codex app-server initialization failed.', {
      error: error.message,
    })
  }

  const enqueueAppServerMessage = (requestId: string, message: string) => {
    if (!appServerConnection) {
      throw new Error('Codex app-server is unavailable right now.')
    }

    if (appServerInitializationError) {
      throw appServerInitializationError
    }

    if (!appServerInitialized) {
      appServerQueue.push({
        requestId,
        message,
      })
      return
    }

    appServerConnection.send(message)
  }

  const sendAppServerRequest = async <TResult>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<TResult> => {
    const requestId = `panda-${method.replace(/[^\w]+/g, '-')}-${nextRequestId++}`
    const paramsSummary = summarizeAppServerParams(method, params)
    const requestSessionId =
      typeof params.threadId === 'string' && params.threadId.trim()
        ? params.threadId.trim()
        : null
    if (
      requestSessionId &&
      (method === 'thread/start' || method === 'thread/resume' || method === 'turn/start')
    ) {
      lastAppServerRequestBySessionId.set(requestSessionId, {
        startedAt: Date.now(),
        requestId,
        method,
        ...paramsSummary,
      })
    }

    if (APP_SERVER_DIAGNOSTIC_METHODS.has(method)) {
      logDiagnostic('info', 'Dispatching Codex app-server request.', {
        requestId,
        method,
        ...paramsSummary,
      })
    }

    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingAppServerRequests.delete(requestId)
        const queuedIndex = appServerQueue.findIndex((item) => item.requestId === requestId)
        if (queuedIndex >= 0) {
          appServerQueue.splice(queuedIndex, 1)
        }
        logDiagnostic('warn', 'Codex app-server request timed out.', {
          requestId,
          method,
          ...paramsSummary,
          timeoutMs: APP_SERVER_REQUEST_TIMEOUT_MS,
        })
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, APP_SERVER_REQUEST_TIMEOUT_MS)

      pendingAppServerRequests.set(requestId, {
        method,
        startedAt: Date.now(),
        paramsSummary,
        timeout,
        resolve,
        reject,
      })

      try {
        enqueueAppServerMessage(
          requestId,
          JSON.stringify({
            id: requestId,
            method,
            params,
          }),
        )
      } catch (error) {
        clearTimeout(timeout)
        pendingAppServerRequests.delete(requestId)
        reject(
          error instanceof Error
            ? error
            : new Error(`Failed to call Codex app-server method ${method}.`),
        )
      }
    })
  }

  const sendAppServerResponse = (
    rawRequestId: string | number,
    result: Record<string, unknown>,
  ) => {
    const normalizedRequestId = normalizeInteractionRequestId(rawRequestId)
    if (!normalizedRequestId) {
      throw new Error('Codex app-server response is missing a request id.')
    }

    enqueueAppServerMessage(
      normalizedRequestId,
      JSON.stringify({
        id: rawRequestId,
        result,
      }),
    )
  }

  const buildInteractionResponsePayload = (
    interaction: PendingInteractionRequest,
    input: {
      optionId?: string | null
      text?: string | null
      answers?: Record<string, string> | null
    },
  ) => {
    switch (interaction.responseKind) {
      case 'user_input': {
        const providedAnswers = Object.fromEntries(
          Object.entries(input.answers ?? {}).filter(
            ([questionId, value]) => questionId.trim() && value.trim(),
          ),
        )
        if (Object.keys(providedAnswers).length > 0) {
          return {
            answers: Object.fromEntries(
              Object.entries(providedAnswers).map(([questionId, value]) => [
                questionId,
                {
                  answers: [value],
                },
              ]),
            ),
          }
        }

        const firstQuestion = interaction.request.questions[0]
        if (!firstQuestion) {
          throw new Error('当前确认请求缺少可回复的问题。')
        }

        const selectedOption = firstQuestion.options.find(
          (option) => option.id === input.optionId,
        )
        const answerText = selectedOption?.label ?? input.text?.trim() ?? ''
        if (!answerText) {
          throw new Error('请先选择一个选项，或输入回复内容。')
        }

        return {
          answers: {
            [firstQuestion.id]: {
              answers: [answerText],
            },
          },
        }
      }
      case 'command_execution_approval': {
        const selectedDecision = interaction.rawResponseOptions?.find(
          (option) => option.id === input.optionId,
        )
        if (!selectedDecision) {
          throw new Error('当前命令确认缺少可用决策。')
        }

        return {
          decision: selectedDecision.value,
        }
      }
      case 'file_change_approval': {
        const decision = input.optionId?.trim()
        if (!decision) {
          throw new Error('请先选择是否允许这次文件修改。')
        }

        return {
          decision,
        }
      }
      case 'permissions_approval': {
        const scope = input.optionId?.trim()
        if (!scope) {
          throw new Error('请先选择一个权限范围。')
        }

        return {
          scope,
        }
      }
      case 'mcp_elicitation': {
        const content =
          interaction.rawResponseOptions?.find((option) => option.id === input.optionId)?.value ??
          input.text?.trim() ??
          ''
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('请先选择一个选项，或输入继续所需的内容。')
        }

        return {
          action: 'accept',
          content,
          _meta: {},
        }
      }
      default:
        throw new Error('当前确认请求暂不支持在 Panda 中回复。')
    }
  }

  const spawnAppServerChild = (): ChildProcessWithoutNullStreams | null => {
    try {
      const appServerArgs = ['app-server', '--enable', 'default_mode_request_user_input']
      const childEnv = {
        ...process.env,
        CODEX_HOME: resolveCodexEnvironmentHome(),
      }

      if (process.platform === 'win32') {
        return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'codex', ...appServerArgs], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: childEnv,
        })
      }

      return spawn('codex', appServerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      })
    } catch {
      return null
    }
  }

  const setupAppServer = () => {
    if ((options?.appServerMode ?? 'spawn') === 'off') {
      return
    }

    const codexCandidates = listCodexCommandCandidates()
    logDiagnostic('info', 'Starting Codex app-server bridge.', {
      platform: process.platform,
      execPath: process.execPath,
      codexHome: resolveCodexEnvironmentHome(),
      codexCommandFound: codexCandidates.length > 0,
      codexCommandCandidates: codexCandidates,
      bridgeExecutable:
        process.platform === 'win32'
          ? `${process.env.ComSpec || 'cmd.exe'} /d /c codex`
          : 'codex',
    })
    const appServerChild = spawnAppServerChild()
    if (!appServerChild) {
      logDiagnostic('error', 'Failed to spawn Codex app-server bridge process.', {
        platform: process.platform,
      })
      return
    }
    logDiagnostic('info', 'Spawned Codex app-server bridge process.', {
      pid: appServerChild.pid ?? null,
      platform: process.platform,
    })

    appServerConnection = {
      send(message) {
        if (!appServerChild.stdin.writable || appServerChild.stdin.destroyed || appServerChild.stdin.writableEnded) {
          return
        }

        appServerChild.stdin.write(message.endsWith('\n') ? message : `${message}\n`)
      },
      shutdown() {
        if (appServerChild.killed || appServerChild.exitCode !== null) {
          return
        }

        if (process.platform === 'win32' && appServerChild.pid) {
          const killer = spawn('taskkill', ['/pid', String(appServerChild.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          })
          killer.on('error', () => {
            appServerChild.kill()
          })
          return
        }

        appServerChild.kill('SIGTERM')
      },
    }

    const markAppServerInitialized = () => {
      if (appServerInitialized) {
        return
      }

      appServerInitialized = true
      appServerInitializationError = null
      clearAppServerInitializeTimer()
      appServerConnection?.send(
        JSON.stringify({
          method: 'initialized',
          params: {},
        }),
      )
      logDiagnostic('info', 'Codex app-server bridge initialized.', {
        pid: appServerChild.pid ?? null,
      })
      flushAppServerQueue()
    }

    const handleAppServerResponse = (message: AppServerResponse) => {
      if (message.id == null) {
        return
      }

      const requestId = String(message.id)
      if (requestId === appServerInitializeRequestId) {
        if (message.result != null) {
          markAppServerInitialized()
          return
        }

        const errorMessage = typeof message.error?.message === 'string'
          ? message.error.message.toLowerCase()
          : ''

        if (errorMessage.includes('already initialized')) {
          markAppServerInitialized()
          return
        }

        failAppServerInitialization(
          new Error(
            message.error?.message
              ? `Codex app-server initialize failed: ${message.error.message}`
              : 'Codex app-server initialize failed.',
          ),
        )
        return
      }

      const pendingRequest = pendingAppServerRequests.get(requestId)
      if (!pendingRequest) {
        return
      }

      pendingAppServerRequests.delete(requestId)
      clearTimeout(pendingRequest.timeout)

      if (message.error?.message) {
        logDiagnostic('warn', 'Codex app-server request failed.', {
          requestId,
          method: pendingRequest.method,
          durationMs: Date.now() - pendingRequest.startedAt,
          ...pendingRequest.paramsSummary,
          error: message.error.message,
        })
        pendingRequest.reject(
          new Error(`${pendingRequest.method} failed: ${message.error.message}`),
        )
        return
      }

      if (APP_SERVER_DIAGNOSTIC_METHODS.has(pendingRequest.method)) {
        logDiagnostic('debug', 'Codex app-server request succeeded.', {
          requestId,
          method: pendingRequest.method,
          durationMs: Date.now() - pendingRequest.startedAt,
          ...pendingRequest.paramsSummary,
        })
      }
      pendingRequest.resolve(message.result)
    }

    const handleNotification = (message: AppServerNotification) => {
      const method = typeof message.method === 'string' ? message.method : ''
      if (method === 'skills/changed') {
        options?.onSkillsChanged?.()
        return
      }

      if (method === 'serverRequest/resolved') {
        const resolvedRequestId = normalizeInteractionRequestId(
          message.params?.requestId,
        )
        if (!resolvedRequestId) {
          return
        }

        const tracker = findTrackerByInteractionRequestId(resolvedRequestId)
        if (!tracker) {
          return
        }

        if (!resolveTrackerInteractionRequest(tracker, resolvedRequestId)) {
          return
        }

        emitTrackerUpdate(
          tracker,
          [],
          null,
          false,
          [],
          'app-server',
          [],
          false,
          [resolvedRequestId],
        )
        return
      }

      const params = message.params
      const turnIdFromParams =
        typeof params?.turnId === 'string'
          ? params.turnId
          : typeof params?.turn_id === 'string'
            ? params.turn_id
            : typeof params?.turn === 'object' &&
                params.turn &&
                typeof (params.turn as { id?: unknown }).id === 'string'
              ? (params.turn as { id: string }).id
              : ''
      const sessionId =
        typeof params?.threadId === 'string'
          ? params.threadId
          : typeof params?.thread_id === 'string'
            ? params.thread_id
            : typeof params?.turn === 'object' &&
                params.turn &&
                typeof (params.turn as { threadId?: unknown }).threadId === 'string'
              ? (params.turn as { threadId: string }).threadId
              : turnIdFromParams
                ? findTrackerByTurnId(turnIdFromParams)?.sessionId ?? ''
              : ''

      if (!sessionId) {
        return
      }

      const tracker =
        trackersBySessionId.get(sessionId) ??
        (method.startsWith('thread/') || method.startsWith('turn/')
          ? ensureSyntheticTracker(sessionId)
          : null)
      if (!tracker) {
        return
      }

      const interactionRequest = parseInteractionRequest(message, sessionId)
      if (interactionRequest) {
        setTrackerInteractionRequest(tracker, interactionRequest)
        emitTrackerUpdate(
          tracker,
          [],
          null,
          false,
          [],
          'app-server',
          [interactionRequest.request],
        )
        return
      }

      const now = new Date().toISOString()
      const resolveTurnId = () => {
        if (typeof params?.turnId === 'string' && params.turnId) {
          return params.turnId
        }

        if (
          typeof params?.turn === 'object' &&
          params.turn &&
          typeof (params.turn as { id?: unknown }).id === 'string'
        ) {
          return (params.turn as { id: string }).id
        }

        return ''
      }

      const emitChangeSetTurnIds = new Set<string>()

      if (method === 'thread/started' && params?.thread) {
        applyThreadPayloadToTracker(tracker, params.thread, now)
        emitTrackerUpdate(tracker, [], tracker.planSnapshot, false, [], 'app-server')
        return
      }

      if (method === 'turn/started') {
        tracker.runState = 'running'
        tracker.runStateChangedAt = now
        tracker.lastThreadStatusType = null
        tracker.lastThreadStatusReason = null
        clearTrackerPlanSnapshot(tracker)
        const turnId = resolveTurnId()
        if (turnId) {
          let changeSetTracker =
            tracker.currentTurnId &&
            tracker.currentTurnId.startsWith('rollout-turn-') &&
            getSessionChangeSetStore(sessionId).get(tracker.currentTurnId)?.status === 'running'
              ? renameChangeSetTracker(sessionId, tracker.currentTurnId, turnId, 'app-server')
              : null
          if (!changeSetTracker) {
            changeSetTracker = ensureChangeSetTracker(sessionId, turnId, 'app-server', now)
          }
          changeSetTracker.status = 'running'
          changeSetTracker.updatedAt = now
          tracker.currentTurnId = turnId
          emitChangeSetTurnIds.add(turnId)
        }
        emitTrackerUpdate(
          tracker,
          [],
          tracker.planSnapshot,
          false,
          serializeUpdatedChangeSets(sessionId, emitChangeSetTurnIds),
          'app-server',
        )
        return
      }

      if (method === 'turn/completed') {
        tracker.runState = 'completed'
        tracker.runStateChangedAt = now
        const didResetPlan = clearTrackerPlanSnapshot(tracker)
        const turnId = resolveTurnId() || tracker.currentTurnId
        if (turnId) {
          const changeSetTracker = ensureChangeSetTracker(
            sessionId,
            turnId,
            'app-server',
            tracker.runStateChangedAt ?? now,
          )
          changeSetTracker.status = 'completed'
          changeSetTracker.completedAt = now
          changeSetTracker.updatedAt = now
          tracker.currentTurnId = null
          emitChangeSetTurnIds.add(turnId)
        }
        emitTrackerUpdate(
          tracker,
          [],
          tracker.planSnapshot,
          didResetPlan,
          serializeUpdatedChangeSets(sessionId, emitChangeSetTurnIds),
          'app-server',
        )
        return
      }

      if (method === 'turn/diff/updated') {
        const turnId = resolveTurnId() || tracker.currentTurnId
        if (!turnId) {
          return
        }

        const changeSetTracker = ensureChangeSetTracker(
          sessionId,
          turnId,
          'app-server',
          tracker.runStateChangedAt ?? now,
        )
        if (typeof params?.diff === 'string') {
          applyUnifiedDiffToChangeSet(changeSetTracker, params.diff)
        }
        changeSetTracker.updatedAt = now
        emitTrackerUpdate(
          tracker,
          [],
          null,
          false,
          serializeUpdatedChangeSets(sessionId, [turnId]),
          'app-server',
        )
        return
      }

      if (
        (method === 'item/started' || method === 'item/completed') &&
        typeof params?.item === 'object' &&
        params.item
      ) {
        const item = params.item as Record<string, unknown>
        const nextPlanSnapshot = parseAppServerPlanSnapshot(tracker, item, now)
        if (nextPlanSnapshot) {
          emitTrackerUpdate(
            tracker,
            [],
            nextPlanSnapshot,
            false,
            [],
            'app-server',
          )
          return
        }
        if (method === 'item/completed') {
          const itemEntries = buildAppServerItemEntries(tracker, item, now)
          if (itemEntries.length > 0) {
            tracker.entries.push(...itemEntries)
            emitTrackerUpdate(
              tracker,
              itemEntries,
              null,
              false,
              [],
              'app-server',
            )
            return
          }
        }
        if (item.type === 'fileChange') {
          const turnId = resolveTurnId() || tracker.currentTurnId
          if (!turnId) {
            return
          }

          const changeSetTracker = ensureChangeSetTracker(
            sessionId,
            turnId,
            'app-server',
            tracker.runStateChangedAt ?? now,
          )
          const files = normalizeAppServerFileChanges(item)
          if (files.length > 0) {
            setChangeSetFiles(changeSetTracker, files)
          }
          if (typeof item.id === 'string' && files.length > 0) {
            changeSetTracker.itemPaths.set(
              item.id,
              files.map((file) =>
                getChangeFileStoreKey({
                  path: file.path,
                  item_id: file.item_id,
                }),
              ),
            )
          }
          if (method === 'item/completed') {
            changeSetTracker.updatedAt = now
          } else {
            changeSetTracker.updatedAt = now
          }
          emitTrackerUpdate(
            tracker,
            [],
            null,
            false,
            serializeUpdatedChangeSets(sessionId, [turnId]),
            'app-server',
          )
          return
        }
      }

      if (method === 'item/fileChange/outputDelta') {
        const turnId = resolveTurnId() || tracker.currentTurnId
        if (!turnId || typeof params?.itemId !== 'string' || typeof params?.delta !== 'string') {
          return
        }

        const changeSetTracker = ensureChangeSetTracker(
          sessionId,
          turnId,
          'app-server',
          tracker.runStateChangedAt ?? now,
        )
        const filePaths = changeSetTracker.itemPaths.get(params.itemId) ?? []
        if (filePaths.length === 1) {
          const filePath = filePaths[0]!
          const existing = changeSetTracker.files.get(filePath)
          if (existing) {
            existing.diff = `${existing.diff}${params.delta}`.trim()
            const counts = getDiffCounts(existing.kind, existing.diff)
            existing.additions = counts.additions
            existing.deletions = counts.deletions
            changeSetTracker.updatedAt = now
            emitTrackerUpdate(
              tracker,
              [],
              null,
              false,
              serializeUpdatedChangeSets(sessionId, [turnId]),
              'app-server',
            )
          }
        }
        return
      }

      if (method !== 'thread/status/changed') {
        return
      }

      const previousRunState = tracker.runState
      const previousTurnId = tracker.currentTurnId
      const nextStatusType = extractThreadStatusType(params?.status)
      const nextStatusReason = extractThreadStatusReason(params?.status)
      const shouldSuppressSystemErrorEntry =
        nextStatusType === 'systemError' &&
        Boolean(nextStatusReason) &&
        Boolean(tracker.lastRuntimeDiagnosticText) &&
        Date.now() - tracker.lastRuntimeDiagnosticAt <= APP_SERVER_RUNTIME_DIAGNOSTIC_WINDOW_MS &&
        (
          nextStatusReason.includes(tracker.lastRuntimeDiagnosticText ?? '') ||
          (tracker.lastRuntimeDiagnosticText ?? '').includes(nextStatusReason)
        )
      tracker.lastThreadStatusType = nextStatusType || null
      tracker.lastThreadStatusReason = nextStatusReason || null
      applyThreadPayloadToTracker(
        tracker,
        {
          status: params?.status,
          turns: previousTurnId
            ? [{ id: previousTurnId, status: previousRunState === 'running' ? 'inProgress' : 'completed' }]
            : [],
        },
        now,
      )
      const didResetPlan =
        previousRunState === 'running' &&
        tracker.runState === 'idle' &&
        clearTrackerPlanSnapshot(tracker)

      const statusEntries: TimelineEntry[] =
        nextStatusType === 'systemError' && !shouldSuppressSystemErrorEntry
          ? [{
              id: `${tracker.sessionId}-${++tracker.entrySeq}`,
              kind: 'system',
              title: 'status',
              body: nextStatusReason
                ? `上一次请求异常中断：${nextStatusReason}`
                : '上一次请求异常中断',
              body_truncated: false,
              detail_available: false,
              patch_summary: null,
              session_ids: [],
              timestamp: now,
              accent: 'muted',
              attachments: [],
            }]
          : []

      if (nextStatusType === 'systemError') {
        logDiagnostic('warn', 'Codex session entered systemError state.', {
          sessionId,
          previousRunState,
          previousTurnId,
          reason: nextStatusReason || null,
          lastAppServerRequest:
            lastAppServerRequestBySessionId.get(sessionId) ?? null,
        })
      }

      if (statusEntries.length > 0 && tracker.hydrated) {
        tracker.entries.push(...statusEntries)
      }

      emitTrackerUpdate(
        tracker,
        statusEntries,
        tracker.planSnapshot,
        didResetPlan,
        [],
        'app-server',
      )
    }

    const handleAppServerMessage = (rawMessage: string) => {
      let parsed: AppServerNotification | AppServerResponse
      try {
        parsed = JSON.parse(rawMessage) as AppServerNotification | AppServerResponse
      } catch {
        return
      }

      if ('method' in parsed && typeof parsed.method === 'string') {
        handleNotification(parsed)
        return
      }

      handleAppServerResponse(parsed as AppServerResponse)
    }

    appServerChild.stdout.on('data', (chunk) => {
      appServerStdoutBuffer += chunk.toString('utf8')
      const lines = appServerStdoutBuffer.split('\n')
      appServerStdoutBuffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) {
          handleAppServerMessage(trimmed)
        }
      }
    })

    appServerChild.on('error', (error) => {
      logDiagnostic('error', 'Codex app-server bridge process emitted an error.', {
        pid: appServerChild.pid ?? null,
        error: error.message,
      })
    })

    appServerChild.stderr.on('data', (chunk) => {
      appServerStderrBuffer += chunk.toString('utf8')
      const lines = appServerStderrBuffer.split('\n')
      appServerStderrBuffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }
        logDiagnostic('warn', 'Codex app-server stderr output.', {
          pid: appServerChild.pid ?? null,
          line: truncateText(trimmed, 800),
        })

        const runtimeDiagnostic = normalizeAppServerRuntimeDiagnostic(trimmed)
        if (runtimeDiagnostic) {
          broadcastRuntimeDiagnostic(runtimeDiagnostic)
        }
      }
    })

    appServerChild.on('close', (code, signal) => {
      clearAppServerInitializeTimer()
      for (const pendingRequest of pendingAppServerRequests.values()) {
        clearTimeout(pendingRequest.timeout)
        pendingRequest.reject(new Error('Codex app-server disconnected.'))
      }
      pendingAppServerRequests.clear()
      const trailingStderr = appServerStderrBuffer.trim()
      logDiagnostic('error', 'Codex app-server bridge process closed.', {
        pid: appServerChild.pid ?? null,
        code: code ?? null,
        signal: signal ?? null,
        trailingStderr: trailingStderr ? truncateText(trailingStderr, 800) : null,
      })
      appServerConnection = null
      appServerInitialized = false
      appServerInitializationError = null
      appServerStdoutBuffer = ''
      appServerStderrBuffer = ''
      appServerQueue.length = 0
      appServerInitializeRequestId = ''
    })

    appServerInitializationError = null
    appServerInitializeRequestId = `panda-init-${nextRequestId++}`
    appServerInitializeTimer = setTimeout(() => {
      failAppServerInitialization(new Error('Codex app-server initialize timed out.'))
    }, APP_SERVER_INITIALIZE_TIMEOUT_MS)
    logDiagnostic('info', 'Sending Codex app-server initialize request.', {
      requestId: appServerInitializeRequestId,
      timeoutMs: APP_SERVER_INITIALIZE_TIMEOUT_MS,
      pid: appServerChild.pid ?? null,
    })
    appServerConnection.send(
      JSON.stringify({
        id: appServerInitializeRequestId,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'panda',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        },
      }),
    )
  }

  const waitForOneShotPrompt = async (
    sessionId: string,
    turnId: string | null,
    entryCountBeforeTurn: number,
    timeoutMs = 60_000,
  ) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const tracker = trackersBySessionId.get(sessionId)
      if (tracker) {
        const nextEntries = tracker.entries.slice(entryCountBeforeTurn)
        const hasNewEntries = nextEntries.length > 0
        const hasAssistantEntry = nextEntries.some((entry) => entry.kind === 'assistant')
        const turnSettled =
          !turnId || tracker.currentTurnId === null || tracker.currentTurnId !== turnId
        const turnCompleted =
          tracker.runState === 'completed' &&
          turnSettled
        if (turnCompleted && (hasAssistantEntry || hasNewEntries)) {
          return tracker
        }
        if (turnSettled && tracker.lastThreadStatusType === 'systemError') {
          throw new Error(formatOneShotPromptFailure(tracker.lastThreadStatusReason))
        }
        if (turnSettled && tracker.runState === 'idle') {
          if (hasAssistantEntry || hasNewEntries) {
            return tracker
          }
          throw new Error('Codex 未返回可用的草拟结果，请稍后再试。')
        }
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 120)
      })
    }

    throw new Error('Codex 草拟命令超时，请稍后再试。')
  }

  return {
    start: async () => {
      await seedExistingFiles()
      await bindWatchers()
      startPolling()
      setupAppServer()
    },
    stop: async () => {
      stopped = true
      for (const timer of pending.values()) {
        clearTimeout(timer)
      }
      pending.clear()
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      for (const watcher of watchers) {
        watcher.close()
      }
      watchers.length = 0
      appServerConnection?.shutdown()
    },
    hydrateSession: async (
      sessionId: string,
      filePath?: string | null,
      options?: {
        includeChangeSets?: boolean
      },
    ) => {
      const tracker = await ensureTracker(sessionId, filePath)
      if (!tracker) {
        return null
      }

      const includeChangeSets = options?.includeChangeSets !== false
      const content = await readFullRollout(tracker.filePath)
      const records = parseRolloutRecords(content)
      if (includeChangeSets) {
        removeRolloutFallbackChangeSets(sessionId)
      }
      const hydratedTracker = createTracker(tracker.sessionId, tracker.filePath, tracker.offset)
      for (const record of records) {
        const nextEntries = consumeRolloutRecord(hydratedTracker, record)
        consumeRolloutPlanRecord(hydratedTracker, record)
        if (includeChangeSets) {
          consumeRolloutChangeSetRecord(hydratedTracker, record)
        }
        hydratedTracker.entries.push(...nextEntries)
      }

      const stat = await fsp.stat(tracker.filePath).catch(() => null)
      hydratedTracker.offset = stat?.size ?? tracker.offset
      hydratedTracker.entries = mergeTrackerEntries(
        hydratedTracker.entries,
        tracker.entries,
      )
      hydratedTracker.entrySeq = hydratedTracker.entries.length
      hydratedTracker.hydrated = true
      hydratedTracker.summary = summarizeFromEntries(hydratedTracker.entries, hydratedTracker.summary)
      hydratedTracker.lastEventAt =
        hydratedTracker.entries.at(-1)?.timestamp ?? hydratedTracker.lastEventAt
      mergeHydratedTrackerWithLiveState(hydratedTracker, tracker)
      upsertTracker(hydratedTracker)

      return {
        entries: hydratedTracker.entries,
        interactionRequests: listTrackerInteractionRequests(hydratedTracker),
        planSnapshot: hydratedTracker.planSnapshot,
        changeSets: includeChangeSets ? listSerializedChangeSets(sessionId) : [],
        sessionPatch: normalizeTrackerPatch(hydratedTracker),
      }
    },
    ensureSessionTracker: async (sessionId: string, filePath?: string | null) => {
      const tracker =
        (await ensureTracker(sessionId, filePath)) ?? ensureSyntheticTracker(sessionId)
      return Boolean(tracker)
    },
    resumeSession: async (sessionId: string) => {
      ensureSyntheticTracker(sessionId)

      const result = await sendAppServerRequest<{ thread?: unknown }>('thread/resume', {
        threadId: sessionId,
        history: null,
        path: null,
        model: null,
        modelProvider: null,
        cwd: null,
        approvalPolicy: null,
        sandbox: null,
        config: null,
        baseInstructions: null,
        developerInstructions: null,
        persistExtendedHistory: true,
      })

      const tracker = ensureSyntheticTracker(sessionId)
      applyThreadPayloadToTracker(tracker, result?.thread, new Date().toISOString())
      upsertTracker(tracker)
    },
    startThread: async (input) => {
      const executionOverrides = resolveExecutionOverrides(input.yoloMode)
      const result = await sendAppServerRequest<{ thread?: unknown }>('thread/start', {
        cwd: input.cwd,
        approvalPolicy: executionOverrides.approvalPolicy,
        baseInstructions: null,
        config: null,
        developerInstructions: null,
        serviceTier: input.serviceTier ?? null,
        ephemeral: false,
        sandbox: executionOverrides.sandboxMode,
        serviceName: null,
        model: input.model?.trim() || null,
        modelProvider: null,
        personality: null,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      })

      const thread =
        result?.thread && typeof result.thread === 'object' ? result.thread : null
      const sessionId =
        thread && typeof (thread as { id?: unknown }).id === 'string'
          ? (thread as { id: string }).id
          : ''

      if (!sessionId) {
        throw new Error('Codex app-server did not return a new thread id.')
      }

      const tracker = ensureSyntheticTracker(sessionId)
      applyThreadPayloadToTracker(tracker, thread, new Date().toISOString())
      upsertTracker(tracker)

      if (input.title?.trim()) {
        await sendAppServerRequest('thread/name/set', {
          threadId: sessionId,
          name: input.title.trim(),
        })
      }

      let turnId: string | null = null
      const turnInput = buildAppServerMessageInput(input.prompt ?? '', input.attachments)
      if (turnInput.length === 0 && (input.attachments?.length ?? 0) > 0) {
        throw new Error('当前 Codex 会话只支持文本和图片附件；普通文件需要配合文字说明，且仅会保留在 Panda 中显示。')
      }

      if (turnInput.length > 0) {
        const turnResult = await sendAppServerRequest<{ turn?: unknown }>('turn/start', {
          threadId: sessionId,
          input: turnInput,
          cwd: null,
          approvalPolicy: executionOverrides.approvalPolicy,
          effort: input.reasoningEffort?.trim() || null,
          model: input.model?.trim() || null,
          outputSchema: null,
          personality: null,
          sandboxPolicy: executionOverrides.sandboxPolicy,
          serviceTier: input.serviceTier ?? null,
          summary: null,
        })

        if (turnResult?.turn && typeof turnResult.turn === 'object') {
          const turn =
            turnResult.turn as {
              id?: unknown
              status?: unknown
            }
          if (typeof turn.id === 'string') {
            turnId = turn.id
            tracker.currentTurnId = turn.id
          }
          if (turn.status === 'inProgress') {
            tracker.runState = 'running'
            tracker.runStateChangedAt = new Date().toISOString()
          }
          upsertTracker(tracker)
        }
      }

      return {
        sessionId,
        turnId,
      }
    },
    sendUserInput: async ({
      sessionId,
      prompt,
      attachments,
      model,
      reasoningEffort,
      serviceTier,
      yoloMode,
    }) => {
      const tracker = ensureSyntheticTracker(sessionId)
      const turnInput = buildAppServerMessageInput(prompt, attachments)
      const executionOverrides = resolveExecutionOverrides(yoloMode)
      if (turnInput.length === 0 && (attachments?.length ?? 0) > 0) {
        throw new Error('当前 Codex 会话只支持文本和图片附件；普通文件需要配合文字说明，且仅会保留在 Panda 中显示。')
      }

      const result = await sendAppServerRequest<{ turn?: unknown }>('turn/start', {
        threadId: sessionId,
        input: turnInput,
        cwd: null,
        approvalPolicy: executionOverrides.approvalPolicy,
        effort: reasoningEffort?.trim() || null,
        model: model?.trim() || null,
        outputSchema: null,
        personality: null,
        sandboxPolicy: executionOverrides.sandboxPolicy,
        serviceTier: serviceTier ?? null,
        summary: null,
      })

      let turnId: string | null = null
      if (result?.turn && typeof result.turn === 'object') {
        const turn =
          result.turn as {
            id?: unknown
            status?: unknown
          }
        if (typeof turn.id === 'string') {
          turnId = turn.id
          tracker.currentTurnId = turn.id
        }
        if (turn.status === 'inProgress') {
          tracker.runState = 'running'
          tracker.runStateChangedAt = new Date().toISOString()
        }
        upsertTracker(tracker)
      }

      return {
        turnId,
      }
    },
    runOneShotPrompt: async ({
      cwd,
      prompt,
      model,
      reasoningEffort,
      timeoutMs,
    }: OneShotPromptInput) => {
      const normalizedCwd = cwd.trim()
      const normalizedPrompt = prompt.trim()
      if (!normalizedCwd) {
        throw new Error('缺少项目路径，无法请求 Codex 生成命令。')
      }
      if (!normalizedPrompt) {
        throw new Error('缺少命令生成提示。')
      }

      const threadResult = await sendAppServerRequest<{ thread?: unknown }>('thread/start', {
        cwd: normalizedCwd,
        approvalPolicy: null,
        baseInstructions: null,
        config: null,
        developerInstructions: null,
        serviceTier: null,
        ephemeral: true,
        sandbox: null,
        serviceName: null,
        model: model?.trim() || null,
        modelProvider: null,
        personality: null,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      })
      const thread =
        threadResult?.thread && typeof threadResult.thread === 'object'
          ? threadResult.thread
          : null
      const sessionId =
        thread && typeof (thread as { id?: unknown }).id === 'string'
          ? (thread as { id: string }).id
          : ''
      if (!sessionId) {
        throw new Error('Codex 未返回临时线程 ID。')
      }

      const tracker = ensureSyntheticTracker(sessionId)
      applyThreadPayloadToTracker(tracker, thread, new Date().toISOString())
      upsertTracker(tracker)
      const entryCountBeforeTurn = tracker.entries.length
      const turnInput = buildAppServerMessageInput(normalizedPrompt, [])
      const turnResult = await sendAppServerRequest<{ turn?: unknown }>('turn/start', {
        threadId: sessionId,
        input: turnInput,
        cwd: null,
        approvalPolicy: null,
        effort: reasoningEffort?.trim() || null,
        model: model?.trim() || null,
        outputSchema: null,
        personality: null,
        sandboxPolicy: null,
        serviceTier: null,
        summary: null,
      })
      const turn =
        turnResult?.turn && typeof turnResult.turn === 'object'
          ? turnResult.turn as {
              id?: unknown
              status?: unknown
            }
          : null
      const turnId = typeof turn?.id === 'string' ? turn.id : null
      if (turnId) {
        tracker.currentTurnId = turnId
      }
      if (turn?.status === 'inProgress') {
        tracker.runState = 'running'
        tracker.runStateChangedAt = new Date().toISOString()
      }
      upsertTracker(tracker)
      const completedTracker = await waitForOneShotPrompt(
        sessionId,
        turnId,
        entryCountBeforeTurn,
        timeoutMs ?? 60_000,
      )
      const output = completedTracker.entries
        .slice(entryCountBeforeTurn)
        .filter((entry) => entry.kind === 'assistant')
        .map((entry) => entry.body.trim())
        .filter(Boolean)
        .at(-1)
      if (!output) {
        trackersBySessionId.delete(sessionId)
        throw new Error(
          completedTracker.lastThreadStatusType === 'systemError'
            ? formatOneShotPromptFailure(completedTracker.lastThreadStatusReason)
            : 'Codex 未返回可用的草拟结果，请稍后再试。',
        )
      }
      trackersBySessionId.delete(sessionId)
      return output.trim()
    },
    listSkills: async ({ cwd, forceReload = false }) => {
      const normalizedCwd = cwd.trim()
      if (!normalizedCwd) {
        return []
      }

      const result = await sendAppServerRequest<{
        data?: unknown
      }>('skills/list', {
        cwds: [normalizedCwd],
        forceReload,
      })

      return parseProjectSkillsResponse(result)
    },
    listModels: async () => {
      const result = await sendAppServerRequest<{
        data?: unknown
      }>('model/list', {
        cursor: null,
        limit: 100,
        includeHidden: false,
      })

      return parseModelListResponse(result)
    },
    listMcpServers: async () => {
      const result = await sendAppServerRequest<{
        data?: unknown
      }>('mcpServerStatus/list', {
        cursor: null,
        limit: 100,
      })

      return parseMcpServerStatusResponse(result)
    },
    readConfig: async (input) => {
      const normalizedCwd = input?.cwd?.trim() ?? ''
      const result = await sendAppServerRequest('config/read', {
        includeLayers: false,
        cwd: normalizedCwd || null,
      })

      return parseConfigReadResponse(result)
    },
    compactThread: async (sessionId: string) => {
      await sendAppServerRequest('thread/compact/start', {
        threadId: sessionId,
      })
    },
    respondToInteraction: async ({
      sessionId,
      requestId,
      optionId,
      text,
      answers,
    }) => {
      const tracker =
        trackersBySessionId.get(sessionId) ??
        (await ensureTracker(sessionId, null)) ??
        ensureSyntheticTracker(sessionId)
      const interactionRequest = tracker.interactionRequests.get(requestId)
      if (!interactionRequest) {
        throw new Error('当前确认请求已失效，请等待 Panda 同步最新状态。')
      }

      const responsePayload = buildInteractionResponsePayload(interactionRequest, {
        optionId,
        text,
        answers,
      })
      sendAppServerResponse(interactionRequest.rawRequestId, responsePayload)
      const updatedRequest = updateTrackerInteractionRequestStatus(
        tracker,
        requestId,
        'submitting',
        new Date().toISOString(),
      )
      if (updatedRequest) {
        emitTrackerUpdate(
          tracker,
          [],
          null,
          false,
          [],
          'app-server',
          [updatedRequest],
        )
      }
    },
    interruptTurn: async (sessionId: string) => {
      let tracker = trackersBySessionId.get(sessionId)
      let turnId = tracker?.currentTurnId
      if (!turnId || turnId.startsWith('rollout-turn-')) {
        const result = await sendAppServerRequest<{ thread?: unknown }>('thread/resume', {
          threadId: sessionId,
          history: null,
          path: null,
          model: null,
          modelProvider: null,
          cwd: null,
          approvalPolicy: null,
          sandbox: null,
          config: null,
          baseInstructions: null,
          developerInstructions: null,
          persistExtendedHistory: true,
        })
        tracker = ensureSyntheticTracker(sessionId)
        applyThreadPayloadToTracker(tracker, result?.thread, new Date().toISOString())
        upsertTracker(tracker)
        turnId = tracker.currentTurnId
      }

      if (!turnId || turnId.startsWith('rollout-turn-')) {
        throw new Error('当前没有可中断的活动会话轮次。')
      }

      await sendAppServerRequest('turn/interrupt', {
        threadId: sessionId,
        turnId,
      })

      const interruptedAt = new Date().toISOString()
      tracker = trackersBySessionId.get(sessionId) ?? tracker ?? ensureSyntheticTracker(sessionId)
      tracker.currentTurnId = null
      tracker.runState = 'completed'
      tracker.runStateChangedAt = interruptedAt
      clearTrackerPlanSnapshot(tracker)
      upsertTracker(tracker)
    },
    setThreadName: async (sessionId: string, title: string) => {
      await sendAppServerRequest('thread/name/set', {
        threadId: sessionId,
        name: title,
      })
    },
    peekSessionPatch: (sessionId: string) => {
      const tracker = trackersBySessionId.get(sessionId)
      return tracker ? normalizeTrackerPatch(tracker) : null
    },
    resumeSessionWithAppServer: async (sessionId: string) => {
      try {
        const result = await sendAppServerRequest('thread/resume', {
          threadId: sessionId,
          history: null,
          path: null,
          model: null,
          modelProvider: null,
          cwd: null,
          approvalPolicy: null,
          sandbox: null,
          config: null,
          baseInstructions: null,
          developerInstructions: null,
          persistExtendedHistory: true,
        })
        const tracker = ensureSyntheticTracker(sessionId)
        applyThreadPayloadToTracker(
          tracker,
          result && typeof result === 'object' ? (result as { thread?: unknown }).thread : null,
          new Date().toISOString(),
        )
        upsertTracker(tracker)
        return {
          sessionPatch: normalizeTrackerPatch(tracker),
          interactionRequests: listTrackerInteractionRequests(tracker),
          planSnapshot: tracker.planSnapshot,
        }
      } catch {
        return null
      }
    },
  }
}
