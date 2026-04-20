import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import compress from '@fastify/compress'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import {
  agentActionRequestSchema,
  agentControlPlaneSyncSchema,
  codexCommandCatalogSchema,
  devManagerActionRequestSchema,
  devManagerConfigUpdateSchema,
  sessionRunCommandDraftSchema,
  sessionRunWebsiteDraftSchema,
  webPushPublicConfigSchema,
  webPushSubscriptionRemoveRequestSchema,
  webPushSubscriptionUpsertRequestSchema,
  webPushTestRequestSchema,
  type CodexCommand,
  type CodexCommandCatalog,
  type CodexCommandPanel,
  type CodexCommandPanelEffect,
  mergeTimelineAttachments,
  type AgentNode,
  type ChangeSet,
  type ChangeSetSummary,
  type ChangeFile,
  type ChangeFileSummary,
  type DirectoryNode,
  type HubDirectorySnapshot,
  type HubRecentSession,
  type HubRecentSessionsSnapshot,
  type PhaseOneSnapshot,
  type ProjectSkill,
  type ProjectRef,
  type SessionLocation,
  type SessionGitWorkspace,
  type SessionGitWorkspaceFile,
  type SessionGitWorkspaceFileDiff,
  type SessionGitHistory,
  type SessionGitHistoryCommit,
  type SessionGitHistoryCommitFile,
  type SessionGitHistoryFileDiff,
  type SessionFilePreviewContentResponse,
  type SessionFilePreviewFileKind,
  type SessionFilePreviewTreeNode,
  type SessionFilePreviewTreeResponse,
  type SessionInteractionRequest,
  type SessionBootstrapSnapshot,
  type SessionChangeSetFileDiff,
  type SessionInputAttachment,
  type SessionContextUsage,
  type SessionPlanSnapshot,
  type SessionRecoveryPatch,
  type SessionRecoverySnapshot,
  type SessionRunCommandDraft,
  type SessionRunCommandGeneration,
  type SessionRunWebsiteDraft,
  type SessionRunWebsiteGeneration,
  type SessionTerminalSnapshot,
  type SessionToolCallDetail,
  type SessionTimelineSnapshot,
  type SessionTimelineView,
  type SessionRef,
  type TimelinePatchSummary,
  type TimelineEntry,
  type WebPushSubscriptionResponse,
  type WorkspaceDirectorySnapshot,
  type WorkspaceAgentSummary,
  type WorkspaceProjectDirectory,
  type WorkspaceProjectStats,
  type WorkspaceSessionDetail,
  type WorkspaceSessionDetailResponse,
  type WorkspaceSessionBucket,
  type WorkspaceSessionListItem,
  type WorkspaceSessionPage,
} from '@panda/protocol'
import { createHubAgentRegistry } from './hub-agent-registry'
import { createHubPushSubscriptionStore } from './hub-push-subscription-store'
import {
  appendSessionIndexUpdate,
  deleteRolloutFile,
  getOrderedWorkspaceRoots,
  moveRolloutFileFromArchived,
  moveRolloutFileToArchived,
  readPandaThreadPrefs,
  setSessionPinned,
  setWorkspaceRootLabel,
  setWorkspaceRootOrder,
  setWorkspaceRootPinned,
  setWorkspaceRootVisibility,
  sortByStoredWorkspaceOrder,
} from './codex-state'
import {
  createCodexLiveSessionStream,
  parseApplyPatchChangeFiles,
} from './live-session-stream'
import { buildInlineTimelineAttachments } from './message-content'
import { collapseDuplicateUserEntries } from './timeline-user-dedup'
import {
  createSessionRunWorkbenchManager,
  readProjectRunCommandCatalog,
  readProjectRunWebsiteCatalog,
  readSessionRunNodeRuntime,
  replaceGeneratedProjectRunCommands,
  replaceGeneratedProjectRunWebsites,
  resolveRunCommandExecution,
  saveProjectRunCommand,
  saveProjectRunWebsite,
} from './session-run-workbench'
import { createDevManager } from './dev-manager'

type SessionWithRunState = SessionRef & {
  run_state: 'idle' | 'running' | 'completed'
  run_state_changed_at: string | null
}

type MaterializedSessionState = {
  session: SessionRef | SessionWithRunState
  sessionPatch: SessionRecoveryPatch
  timeline: TimelineEntry[]
  interactions: SessionInteractionRequest[]
  planSnapshot: SessionPlanSnapshot | null
  changeSets: ChangeSet[]
  terminalSnapshot: SessionTerminalSnapshot | null
}

type StoredCommandPanel = {
  panel: CodexCommandPanel
  mode: 'none' | 'model' | 'rename'
  projectPath: string
  expiresAt: number
}

type VisibleCodexCommandConfigEntry = {
  name: string
  reason: string
}

type VisibleCodexCommandConfig = {
  version: 1 | 2
  visible_commands: VisibleCodexCommandConfigEntry[]
}

type GitCommandResult = {
  stdout: string
  stderr: string
}

type ParsedGitStatusEntry = {
  path: string
  previousPath: string | null
  status: SessionGitWorkspaceFile['status']
}

type ParsedGitHistoryFile = {
  path: string
  previousPath: string | null
  status: SessionGitHistoryCommitFile['status']
}

type GitBranchStatus = {
  branch: string
  upstreamBranch: string | null
  headOid: string | null
  upstreamHeadOid: string | null
  aheadCount: number
  behindCount: number
}

type DiagnosticLogger = {
  info: (payload: Record<string, unknown>, message: string) => void
  warn: (payload: Record<string, unknown>, message: string) => void
  error: (payload: Record<string, unknown>, message: string) => void
  debug: (payload: Record<string, unknown>, message: string) => void
}

type PandaSocketEventType =
  | 'agent.online'
  | 'agent.offline'
  | 'snapshot.changed'
  | 'session.updated'
  | 'thread.updated'
  | 'timeline.delta'
  | 'timeline.reset'
  | 'interaction.delta'
  | 'interaction.reset'
  | 'plan.delta'
  | 'plan.reset'
  | 'changeset.delta'
  | 'changeset.reset'
  | 'terminal.snapshot'
  | 'terminal.delta'
  | 'turn.delta'
  | 'turn.completed'

export type PandaSessionServiceOptions = {
  serviceName: string
  mode: 'direct' | 'hub'
  port: number
  transport: AgentNode['transport']
  codexHome?: string
  localAgentName?: string
  localAgentId?: string
  tailscaleIp?: string | null
  tailscaleDnsName?: string | null
  directBaseUrl?: string | null
  wsBaseUrl?: string | null
  version?: string | null
  webUiDir?: string | null
}

const SNAPSHOT_REFRESH_TTL_MS = 30_000
const SNAPSHOT_BACKGROUND_REFRESH_DEBOUNCE_MS = 600
const PROJECT_SKILLS_CACHE_TTL_MS = 60_000
const WORKSPACE_VISIBLE_SESSION_WINDOW_MS = 6 * 24 * 60 * 60 * 1000
const HUB_RECENT_SESSION_LIMIT = 24
const DEFAULT_WORKSPACE_SESSION_PAGE_LIMIT = 24
const MAX_WORKSPACE_SESSION_PAGE_LIMIT = 100
const COMMAND_PANEL_TTL_MS = 30 * 60_000
const CODEX_VERSION_PROBE_TIMEOUT_MS = 2_500
const CODEX_SOURCE_FETCH_TIMEOUT_MS = 8_000
const GIT_COMMAND_TIMEOUT_MS = 20_000
const HUB_AGENT_HEARTBEAT_INTERVAL_MS = Number(
  process.env.PANDA_HUB_AGENT_HEARTBEAT_INTERVAL_MS ?? 15_000,
)
const HUB_AGENT_HEARTBEAT_TIMEOUT_MS = Number(
  process.env.PANDA_HUB_AGENT_HEARTBEAT_TIMEOUT_MS ?? 45_000,
)
const FORWARDING_DIAGNOSTIC_LOG_RELATIVE_PATH = path.join(
  'logs',
  'panda',
  'codex-forwarding-diagnostics.latest.log',
)
const HUB_AGENT_REGISTRY_RELATIVE_PATH = path.join(
  'state',
  'panda',
  'hub-agent-registry.json',
)
const HUB_PUSH_SUBSCRIPTIONS_RELATIVE_PATH = path.join(
  'state',
  'panda',
  'hub-push-subscriptions.json',
)
const HUB_WEB_PUSH_VAPID_RELATIVE_PATH = path.join(
  'state',
  'panda',
  'hub-web-push-vapid.json',
)
const USER_OVERLAY_ENTRY_PREFIX = 'overlay-user:'
const USER_ENTRY_MATCH_EARLY_SKEW_MS = 5_000
const TIMELINE_TOOL_SUMMARY_LIMIT = 160
const HTTP_COMPRESSION_MIN_BYTES = 4 * 1024
const DEFAULT_SESSION_TITLE_GENERATION_MODEL = 'gpt-5.4-mini'
const SESSION_TITLE_GENERATION_TIMEOUT_MS = 25_000
const SESSION_GENERATED_TITLE_MAX_LENGTH = 30
const SESSION_FILE_PREVIEW_ROOT_PATH = '/'
const SESSION_FILE_PREVIEW_TEXT_BYTE_LIMIT = 256 * 1024
const SESSION_FILE_PREVIEW_IMAGE_BYTE_LIMIT = 6 * 1024 * 1024
const SESSION_FILE_PREVIEW_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])
const SESSION_FILE_PREVIEW_CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.css',
  '.html',
  '.xml',
  '.yml',
  '.yaml',
  '.sh',
  '.java',
])
const SESSION_FILE_PREVIEW_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.log',
])
const SESSION_FILE_PREVIEW_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
])
const SESSION_FILE_PREVIEW_CODE_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'jenkinsfile',
])
const SESSION_FILE_PREVIEW_CODE_NAME_PATTERNS = [
  /^\.(?:env(?:\..+)?)$/i,
  /^\.(?:gitignore|gitattributes|npmrc|yarnrc|editorconfig)$/i,
  /^\.(?:prettierrc|eslintrc)(?:\..+)?$/i,
]
const SESSION_FILE_PREVIEW_MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.java': 'text/x-java-source; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
}
const WEB_UI_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
const CAPACITOR_LOCAL_ORIGIN = 'capacitor://localhost'
const PLAN_MODE_PROMPT_PREFIX = `<user_instructions>
Plan mode is enabled for this message only. Before doing substantial work, create or refresh a concise plan with the update_plan tool and keep it current as steps progress. For trivial asks, you may skip the plan.
</user_instructions>

`
const LATEST_VISIBLE_CODEX_COMMAND_CONFIG_VERSION = 2
const REVIEW_VISIBLE_CODEX_COMMAND_ENTRY: VisibleCodexCommandConfigEntry = {
  name: 'review',
  reason: '快速审查当前工作区未提交改动，适合在提交前或继续编码前先自检一遍。',
}

const FALLBACK_CODEX_COMMAND_CATALOG: CodexCommand[] = [
  { name: 'compact', description: '压缩当前会话上下文，释放窗口并继续工作。', availability: 'supported' },
  { name: 'copy', description: '复制最近一次助手输出。', availability: 'unsupported' },
  { name: 'diff', description: '查看当前工作区最近变更。', availability: 'unsupported' },
  { name: 'feedback', description: '提交关于 Codex 的反馈。', availability: 'unsupported' },
  { name: 'fork', description: '从当前会话派生一个新的分支会话。', availability: 'unsupported' },
  { name: 'init', description: '初始化 Codex 项目文件。', availability: 'unsupported' },
  { name: 'mcp', description: '查看当前可用的 MCP 服务和工具。', availability: 'supported' },
  { name: 'model', description: '切换后续对话使用的模型。', availability: 'supported' },
  { name: 'new', description: '开始一个新会话。', availability: 'unsupported' },
  { name: 'permissions', description: '查看或调整确认策略。', availability: 'unsupported' },
  { name: 'personality', description: '切换响应人格。', availability: 'unsupported' },
  { name: 'rename', description: '重命名当前会话。', availability: 'supported' },
  { name: 'review', description: '审查当前工作区未提交变更。', availability: 'unsupported' },
  { name: 'skills', description: '浏览当前项目可用技能。', availability: 'supported' },
  { name: 'status', description: '查看当前会话状态、模型和上下文窗口。', availability: 'supported' },
  { name: 'statusline', description: '查看状态栏配置。', availability: 'unsupported' },
]

const PANDA_SUPPORTED_COMMANDS = new Set([
  'compact',
  'mcp',
  'model',
  'rename',
  'skills',
  'status',
])

const DEFAULT_VISIBLE_CODEX_COMMAND_CONFIG: VisibleCodexCommandConfig = {
  version: LATEST_VISIBLE_CODEX_COMMAND_CONFIG_VERSION,
  visible_commands: [
    {
      name: 'model',
      reason: '切换真实 Codex CLI 模型，是最常用也最直接影响对话体验的命令。',
    },
    {
      name: 'status',
      reason: '快速查看当前会话模型、上下文占用和沙箱等关键信息，适合先自检。',
    },
    REVIEW_VISIBLE_CODEX_COMMAND_ENTRY,
    {
      name: 'skills',
      reason: '把项目里可用技能直接暴露出来，能帮助用户发现 Panda 已接入的能力。',
    },
    {
      name: 'mcp',
      reason: '检查外部工具和服务接入状态，出了问题时排查效率最高。',
    },
    {
      name: 'rename',
      reason: '整理会话标题成本低、频率高，适合放进首屏命令列表。',
    },
    {
      name: 'compact',
      reason: '上下文变长时很实用，但又不像实验性命令那样容易让人困惑。',
    },
  ],
}

const POWERSHELL_CMDLET_PATTERN =
  /\b(?:Get-CimInstance|Get-NetTCPConnection|Where-Object|ForEach-Object|Select-Object|Stop-Process)\b/i

const PORT_BASED_KILL_COMMAND_PATTERN = /\bGet-NetTCPConnection\b/i

export const startPandaSessionService = async ({
  serviceName,
  mode,
  port,
  transport,
  codexHome = process.env.PANDA_CODEX_HOME,
  localAgentName = process.env.PANDA_AGENT_NAME ?? os.hostname(),
  localAgentId = process.env.PANDA_AGENT_ID ??
    `agent-${(process.env.PANDA_AGENT_NAME ?? os.hostname())
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'local'}`,
  tailscaleIp = process.env.PANDA_AGENT_TAILSCALE_IP ?? null,
  tailscaleDnsName = process.env.PANDA_AGENT_TAILSCALE_DNS_NAME ?? null,
  directBaseUrl = process.env.PANDA_AGENT_DIRECT_BASE_URL ?? null,
  wsBaseUrl = process.env.PANDA_AGENT_WS_BASE_URL ?? null,
  version = process.env.npm_package_version ?? null,
  webUiDir = null,
}: PandaSessionServiceOptions): Promise<FastifyInstance> => {
const app = Fastify({ logger: true })
const {
  logger: diagnosticLogger,
  filePath: diagnosticLogFilePath,
} = createDiagnosticLogger(codexHome, {
  relativePath: FORWARDING_DIAGNOSTIC_LOG_RELATIVE_PATH,
  initMessage: 'Initialized Panda Codex forwarding diagnostics log.',
})
const resolvedCodexHomePath = resolveCodexHomePath(codexHome)
app.log.info({
  diagnosticLogFilePath,
}, 'Panda Codex forwarding diagnostics will be written to file.')

let discoveredAgent: AgentNode | null = null
let discoveredSessionFiles: Record<string, string> = {}
let activeSessionId = ''
let lastSnapshotRefreshAt = 0
let snapshotRefreshPromise: Promise<PhaseOneSnapshot> | null = null
let snapshotBackgroundRefreshTimer: NodeJS.Timeout | null = null
let snapshotBackgroundRefreshQueued = false
let snapshot: PhaseOneSnapshot = {
  generated_at: new Date().toISOString(),
  agents: [],
  projects: [],
  sessions: [],
  active_session_id: '',
  timeline: [],
  changed_files: [],
  runtime_processes: [],
  previews: [],
  approvals: [],
}
const hubAgentRegistry =
  mode === 'hub'
    ? createHubAgentRegistry({
        storageFilePath: path.join(
          resolvedCodexHomePath,
          HUB_AGENT_REGISTRY_RELATIVE_PATH,
        ),
        heartbeatTimeoutMs: HUB_AGENT_HEARTBEAT_TIMEOUT_MS,
        logger: app.log,
      })
    : null
const hubPushSubscriptionStore =
  mode === 'hub'
    ? createHubPushSubscriptionStore({
        storageFilePath: path.join(
          resolvedCodexHomePath,
          HUB_PUSH_SUBSCRIPTIONS_RELATIVE_PATH,
        ),
        logger: app.log,
      })
    : null
const hubWebPushNotifier =
  mode === 'hub'
    ? await import('./hub-web-push').then(({ createHubWebPushNotifier }) =>
        createHubWebPushNotifier({
          storageFilePath: path.join(
            resolvedCodexHomePath,
            HUB_WEB_PUSH_VAPID_RELATIVE_PATH,
          ),
          publicKey: process.env.PANDA_WEB_PUSH_PUBLIC_KEY ?? null,
          privateKey: process.env.PANDA_WEB_PUSH_PRIVATE_KEY ?? null,
          subject: process.env.PANDA_WEB_PUSH_SUBJECT ?? null,
          logger: app.log,
        }),
      )
    : null
if (hubPushSubscriptionStore) {
  await hubPushSubscriptionStore.load()
}

const customProjects = new Map<string, ProjectRef>()
const managedSessions = new Map<string, SessionWithRunState>()
const managedTimelines = new Map<string, TimelineEntry[]>()
const sessionTimelineOverlays = new Map<string, TimelineEntry[]>()
const sessionPlans = new Map<string, SessionPlanSnapshot | null>()
const sessionInteractions = new Map<string, SessionInteractionRequest[]>()
const sessionChangeSets = new Map<string, ChangeSet[]>()
const projectSkillsCache = new Map<
  string,
  {
    skills: ProjectSkill[]
    fetchedAt: number
  }
>()
const commandPanels = new Map<string, StoredCommandPanel>()
let pandaLocalBaseDirectoryPromise: Promise<string> | null = null
let codexCommandCatalogCacheFilePathPromise: Promise<string> | null = null
let codexVisibleCommandsConfigFilePathPromise: Promise<string> | null = null
let codexCommandCatalogRefreshPromise: Promise<CodexCommandCatalog> | null = null
const wsClients = new Set<{
  send: (payload: string) => void
  subscribedSessionIds: Set<string>
}>()
const emittedTurnCompletionKeys = new Map<string, string>()

const isoNow = () => new Date().toISOString()
const sendSocketEvent = (
  client: {
    send: (payload: string) => void
    subscribedSessionIds: Set<string>
  },
  type: PandaSocketEventType,
  payload: Record<string, unknown>,
) => {
  client.send(
    JSON.stringify({
      type,
      timestamp: isoNow(),
      payload,
    }),
  )
}

const broadcastEvent = (
  type: PandaSocketEventType,
  payload: Record<string, unknown>,
  options?: { sessionId?: string },
) => {
  const message = JSON.stringify({
    type,
    timestamp: isoNow(),
    payload,
  })

  for (const client of wsClients) {
    if (
      options?.sessionId &&
      (type === 'timeline.delta' ||
        type === 'timeline.reset' ||
        type === 'interaction.delta' ||
        type === 'interaction.reset' ||
        type === 'plan.delta' ||
        type === 'plan.reset' ||
        type === 'changeset.delta' ||
        type === 'changeset.reset' ||
        type === 'terminal.snapshot' ||
        type === 'terminal.delta') &&
      !client.subscribedSessionIds.has(options.sessionId)
    ) {
      continue
    }

    try {
      client.send(message)
    } catch {
      wsClients.delete(client)
    }
  }
}

const runWorkbenchManager = createSessionRunWorkbenchManager({
  onSnapshot: (snapshot: SessionTerminalSnapshot) => {
    broadcastEvent(
      'terminal.snapshot',
      {
        sessionId: snapshot.session_id,
        snapshot,
      },
      { sessionId: snapshot.session_id },
    )
  },
  onDelta: (event) => {
    broadcastEvent(
      'terminal.delta',
      {
        sessionId: event.sessionId,
        activeTerminalId: event.activeTerminalId,
        terminal: event.terminal,
        chunks: event.chunks,
        nextCursor: event.nextCursor,
      },
      { sessionId: event.sessionId },
    )
  },
})

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const normalizePathKey = (value: string) =>
  process.platform === 'win32' ? value.toLowerCase() : value

const LARGE_JSON_ROUTE_COMPRESS_OPTIONS = {
  threshold: HTTP_COMPRESSION_MIN_BYTES,
} as const

const fileExists = async (targetPath: string) => {
  try {
    return (await fs.stat(targetPath)).isFile()
  } catch {
    return false
  }
}

const resolveWebUiAsset = async (webUiRoot: string, requestUrl: string) => {
  const pathnameWithQuery = requestUrl.split('?')[0] ?? requestUrl
  let pathname = pathnameWithQuery || '/'
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    return null
  }

  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`
  }

  const normalizedPathname = path.posix.normalize(pathname)
  if (normalizedPathname.startsWith('/..')) {
    return null
  }

  const webUiRootPath = path.resolve(webUiRoot)
  const relativePath =
    normalizedPathname === '/' ? 'index.html' : normalizedPathname.replace(/^\/+/, '')
  const candidatePath = path.resolve(webUiRootPath, relativePath.split('/').join(path.sep))
  const candidateRelativePath = path.relative(webUiRootPath, candidatePath)
  if (
    candidateRelativePath.startsWith('..') ||
    path.isAbsolute(candidateRelativePath)
  ) {
    return null
  }

  const hasExtension = path.extname(relativePath) !== ''
  if (await fileExists(candidatePath)) {
    return {
      filePath: candidatePath,
      cacheControl: relativePath.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
      contentType:
        WEB_UI_CONTENT_TYPES[path.extname(candidatePath).toLowerCase()] ??
        'application/octet-stream',
    }
  }

  if (hasExtension) {
    return null
  }

  const indexPath = path.join(webUiRootPath, 'index.html')
  if (!(await fileExists(indexPath))) {
    return null
  }

  return {
    filePath: indexPath,
    cacheControl: 'no-cache',
    contentType: WEB_UI_CONTENT_TYPES['.html'],
  }
}

const normalizeGitWorkspacePath = (value: string) =>
  value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/')

const isAllowedCorsOrigin = (origin: string | undefined) => {
  const normalizedOrigin = origin?.trim() ?? ''
  if (!normalizedOrigin) {
    return true
  }

  if (normalizedOrigin === CAPACITOR_LOCAL_ORIGIN) {
    return true
  }

  try {
    const parsedOrigin = new URL(normalizedOrigin)
    return parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:'
  } catch {
    return false
  }
}

const isPathInsideProject = (projectPath: string, candidatePath: string) => {
  const resolvedProjectPath = path.resolve(projectPath)
  const resolvedCandidatePath = path.resolve(projectPath, candidatePath)
  const relativePath = path.relative(resolvedProjectPath, resolvedCandidatePath)

  if (!relativePath) {
    return true
  }

  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

const isAbsolutePathInsideProject = (projectPath: string, candidatePath: string) => {
  const resolvedProjectPath = path.resolve(projectPath)
  const resolvedCandidatePath = path.resolve(candidatePath)
  const relativePath = path.relative(resolvedProjectPath, resolvedCandidatePath)

  if (!relativePath) {
    return true
  }

  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
}

const normalizeSessionFilePreviewPath = (value: string | null | undefined) =>
  normalizeGitWorkspacePath(value?.trim() ?? '').replace(/^\/+|\/+$/g, '')

const isMissingPathError = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  (error as NodeJS.ErrnoException).code === 'ENOENT'

const resolveSessionFilePreviewPath = async (
  projectPath: string,
  requestedPath: string | null | undefined,
) => {
  const normalizedPath = normalizeSessionFilePreviewPath(requestedPath)
  const absolutePath = normalizedPath
    ? path.resolve(projectPath, normalizedPath)
    : path.resolve(projectPath)

  if (!isAbsolutePathInsideProject(projectPath, absolutePath)) {
    throw new Error('目标路径不在当前项目内。')
  }

  let realPath: string
  try {
    realPath = await fs.realpath(absolutePath)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error('File not found.')
    }
    throw error
  }

  if (!isAbsolutePathInsideProject(projectPath, realPath)) {
    throw new Error('目标路径不在当前项目内。')
  }

  return {
    normalizedPath,
    absolutePath,
    realPath,
  }
}

const normalizeSessionFilePreviewExtension = (value: string) => {
  const extension = path.extname(value).trim().toLowerCase()
  return extension || null
}

const detectSessionFilePreviewKind = (
  fileName: string,
  extension: string | null,
): SessionFilePreviewFileKind | null => {
  const normalizedName = fileName.trim().toLowerCase()

  if (extension && SESSION_FILE_PREVIEW_MARKDOWN_EXTENSIONS.has(extension)) {
    return 'markdown'
  }

  if (extension && SESSION_FILE_PREVIEW_IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }

  if (extension && SESSION_FILE_PREVIEW_TEXT_EXTENSIONS.has(extension)) {
    return 'text'
  }

  if (
    (extension && SESSION_FILE_PREVIEW_CODE_EXTENSIONS.has(extension)) ||
    SESSION_FILE_PREVIEW_CODE_FILENAMES.has(normalizedName) ||
    SESSION_FILE_PREVIEW_CODE_NAME_PATTERNS.some((pattern) => pattern.test(normalizedName))
  ) {
    return 'code'
  }

  return null
}

const getSessionFilePreviewMimeType = (
  extension: string | null,
  fileKind: SessionFilePreviewFileKind,
) => {
  if (extension && SESSION_FILE_PREVIEW_MIME_TYPES[extension]) {
    return SESSION_FILE_PREVIEW_MIME_TYPES[extension]
  }

  if (fileKind === 'markdown') {
    return 'text/markdown; charset=utf-8'
  }

  if (fileKind === 'code' || fileKind === 'text') {
    return 'text/plain; charset=utf-8'
  }

  return null
}

const looksLikeTextBuffer = (buffer: Buffer) => {
  if (buffer.length === 0) {
    return true
  }

  let suspiciousControlCount = 0
  for (const byte of buffer.values()) {
    if (byte === 0) {
      return false
    }

    const isAllowedWhitespace = byte === 9 || byte === 10 || byte === 13
    if (!isAllowedWhitespace && byte < 32) {
      suspiciousControlCount += 1
    }
  }

  return suspiciousControlCount / buffer.length < 0.08
}

const readPreviewBuffer = async (filePath: string, byteLimit: number) => {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(byteLimit)
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const readDirectoryHasChildren = async (directoryPath: string) => {
  try {
    const entries = await fs.readdir(directoryPath)
    return entries.length > 0
  } catch {
    return false
  }
}

const buildSessionFilePreviewTreeNode = async (
  projectPath: string,
  parentRelativePath: string,
  parentRealPath: string,
  entry: import('node:fs').Dirent,
): Promise<SessionFilePreviewTreeNode | null> => {
  const nextRelativePath = normalizeGitWorkspacePath(
    parentRelativePath ? `${parentRelativePath}/${entry.name}` : entry.name,
  )
  const entryPath = path.join(parentRealPath, entry.name)

  if (entry.isSymbolicLink()) {
    try {
      const realPath = await fs.realpath(entryPath)
      if (!isAbsolutePathInsideProject(projectPath, realPath)) {
        return null
      }
    } catch {
      return null
    }
  }

  const stat = await fs.stat(entryPath).catch(() => null)
  if (!stat) {
    return null
  }

  const kind = stat.isDirectory()
    ? 'directory'
    : stat.isFile()
      ? 'file'
      : null

  if (!kind) {
    return null
  }

  const extension = kind === 'file' ? normalizeSessionFilePreviewExtension(entry.name) : null
  const fileKind = kind === 'file' ? detectSessionFilePreviewKind(entry.name, extension) ?? 'binary' : null

  return {
    path: nextRelativePath,
    name: entry.name,
    kind,
    has_children: kind === 'directory' ? await readDirectoryHasChildren(entryPath) : false,
    extension,
    file_kind: fileKind,
    size_bytes: kind === 'file' ? stat.size : null,
  }
}

const runGitCommand = async (
  cwd: string,
  args: string[],
  options?: {
    timeoutMs?: number
    allowNonZeroExitCodes?: number[]
  },
) =>
  new Promise<GitCommandResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const allowNonZeroExitCodes = new Set(options?.allowNonZeroExitCodes ?? [])
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const finalizeResolve = (result: GitCommandResult) => {
      if (settled) {
        return
      }
      settled = true
      resolve(result)
    }

    const finalizeReject = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    }

    const timer = setTimeout(() => {
      child.kill()
      finalizeReject(new Error(`Git command timed out: git ${args.join(' ')}`))
    }, options?.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finalizeReject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const result = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      }
      if (code === 0 || allowNonZeroExitCodes.has(code ?? 1)) {
        finalizeResolve(result)
        return
      }

      finalizeReject(
        new Error(
          result.stderr || result.stdout || `Git command failed: git ${args.join(' ')}`,
        ),
      )
    })
  })

const mapGitStatusFromXY = (xy: string): SessionGitWorkspaceFile['status'] => {
  if (xy.includes('R')) {
    return 'renamed'
  }
  if (xy.includes('D')) {
    return 'deleted'
  }
  if (xy.includes('A')) {
    return 'added'
  }
  return 'modified'
}

const parseGitStatusEntries = (stdout: string): ParsedGitStatusEntry[] => {
  const records = stdout.split('\0').filter(Boolean)
  const entries: ParsedGitStatusEntry[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    if (!record || record.startsWith('# ')) {
      continue
    }

    if (record.startsWith('? ')) {
      entries.push({
        path: normalizeGitWorkspacePath(record.slice(2)),
        previousPath: null,
        status: 'untracked',
      })
      continue
    }

    const ordinaryMatch =
      /^1 ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.+)$/.exec(record)
    if (ordinaryMatch) {
      entries.push({
        path: normalizeGitWorkspacePath(ordinaryMatch[8]!),
        previousPath: null,
        status: mapGitStatusFromXY(ordinaryMatch[1]!),
      })
      continue
    }

    const renamedMatch =
      /^2 ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.+)$/.exec(record)
    if (renamedMatch) {
      const previousPath = records[index + 1] ?? ''
      index += 1
      entries.push({
        path: normalizeGitWorkspacePath(renamedMatch[9]!),
        previousPath: previousPath ? normalizeGitWorkspacePath(previousPath) : null,
        status:
          renamedMatch[1]!.includes('R')
            ? 'renamed'
            : mapGitStatusFromXY(renamedMatch[1]!),
      })
    }
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

const parseGitHistoryFileStatus = (value: string): ParsedGitHistoryFile['status'] => {
  if (value.startsWith('R')) {
    return 'renamed'
  }
  if (value.startsWith('D')) {
    return 'deleted'
  }
  if (value.startsWith('A')) {
    return 'added'
  }
  return 'modified'
}

const parseGitHistoryRefs = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

const parseGitHistory = (stdout: string): SessionGitHistoryCommit[] =>
  stdout
    .split('\x1e')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/)
      const header = lines.shift() ?? ''
      const [
        oid = '',
        shortOid = '',
        authorName = '',
        authoredAt = '',
        committedAt = '',
        subject = '',
        parentOidsValue = '',
        refsValue = '',
      ] = header.split('\x1f')

      const files = lines
        .map((line): ParsedGitHistoryFile | null => {
          const trimmed = line.trim()
          if (!trimmed) {
            return null
          }

          const parts = trimmed.split('\t')
          const statusCode = parts[0]?.trim() ?? ''
          if (!statusCode) {
            return null
          }

          if (statusCode.startsWith('R')) {
            const previousPath = parts[1]?.trim() ?? ''
            const nextPath = parts[2]?.trim() ?? ''
            if (!previousPath || !nextPath) {
              return null
            }
            return {
              path: normalizeGitWorkspacePath(nextPath),
              previousPath: normalizeGitWorkspacePath(previousPath),
              status: 'renamed',
            }
          }

          const nextPath = parts[1]?.trim() ?? ''
          if (!nextPath) {
            return null
          }

          return {
            path: normalizeGitWorkspacePath(nextPath),
            previousPath: null,
            status: parseGitHistoryFileStatus(statusCode),
          }
        })
        .filter((entry): entry is ParsedGitHistoryFile => Boolean(entry))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map<SessionGitHistoryCommitFile>((entry) => ({
          path: entry.path,
          previous_path: entry.previousPath,
          status: entry.status,
        }))

      return {
        oid,
        short_oid: shortOid,
        subject,
        author_name: authorName,
        authored_at: authoredAt,
        committed_at: committedAt,
        parent_oids: parentOidsValue.trim() ? parentOidsValue.trim().split(/\s+/) : [],
        refs: parseGitHistoryRefs(refsValue),
        files,
      } satisfies SessionGitHistoryCommit
    })


const countDiffLineChanges = (diffText: string) => {
  let additions = 0
  let deletions = 0
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
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

  return { additions, deletions }
}

const parseGitNumstat = (stdout: string) => {
  const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const match = /^([-\d]+)\t([-\d]+)/.exec(firstLine)
  if (!match) {
    return { additions: 0, deletions: 0 }
  }

  const additions = Number.parseInt(match[1] ?? '0', 10)
  const deletions = Number.parseInt(match[2] ?? '0', 10)
  return {
    additions: Number.isFinite(additions) ? additions : 0,
    deletions: Number.isFinite(deletions) ? deletions : 0,
  }
}

const countTextFileLines = (content: string) => {
  if (!content.length) {
    return 0
  }

  return content.replace(/\r\n/g, '\n').split('\n').length
}

const readGitBranchStatus = async (projectPath: string): Promise<GitBranchStatus> => {
  const branch = (
    await runGitCommand(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  ).stdout || 'unknown'
  const headOidResult = await runGitCommand(
    projectPath,
    ['rev-parse', 'HEAD'],
    { allowNonZeroExitCodes: [128] },
  )
  const headOid = headOidResult.stdout || null
  const upstreamResult = await runGitCommand(
    projectPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { allowNonZeroExitCodes: [128] },
  )
  const upstreamBranch = upstreamResult.stdout || null

  if (!upstreamBranch) {
    return {
      branch,
      headOid,
      upstreamBranch: null,
      upstreamHeadOid: null,
      aheadCount: 0,
      behindCount: 0,
    }
  }

  const upstreamHeadResult = await runGitCommand(
    projectPath,
    ['rev-parse', '@{upstream}'],
    { allowNonZeroExitCodes: [128] },
  )
  const upstreamHeadOid = upstreamHeadResult.stdout || null

  const aheadBehind = (
    await runGitCommand(projectPath, ['rev-list', '--left-right', '--count', `${upstreamBranch}...HEAD`])
  ).stdout.split(/\s+/)
  const behindCount = Number(aheadBehind[0] ?? 0)
  const aheadCount = Number(aheadBehind[1] ?? 0)

  return {
    branch,
    headOid,
    upstreamBranch,
    upstreamHeadOid,
    aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
    behindCount: Number.isFinite(behindCount) ? behindCount : 0,
  }
}

const listGitBranches = async (projectPath: string, currentBranch: string) => {
  const result = await runGitCommand(projectPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ])
  const branches = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)

  return [...new Set([currentBranch, ...branches])].sort((left, right) => {
    if (left === currentBranch) {
      return -1
    }
    if (right === currentBranch) {
      return 1
    }
    return left.localeCompare(right)
  })
}

const readTrackedFileDiff = async (
  projectPath: string,
  filePath: string,
) => (await runGitCommand(
  projectPath,
  ['diff', '--no-ext-diff', '--no-color', '--binary', 'HEAD', '--', filePath],
)).stdout

const readUntrackedFileDiff = async (
  projectPath: string,
  filePath: string,
) => {
  const absolutePath = path.join(projectPath, filePath)
  return (
    await runGitCommand(
      projectPath,
      ['diff', '--no-index', '--no-color', '--binary', '--', '/dev/null', absolutePath],
      { allowNonZeroExitCodes: [1] },
    )
  ).stdout
}

const readTrackedFileChangeCounts = async (
  projectPath: string,
  filePath: string,
) => parseGitNumstat((await runGitCommand(
  projectPath,
  ['diff', '--numstat', '--find-renames', 'HEAD', '--', filePath],
)).stdout)

const readUntrackedFileChangeCounts = async (
  projectPath: string,
  filePath: string,
) => {
  const absolutePath = path.join(projectPath, filePath)
  try {
    const content = await fs.readFile(absolutePath, 'utf8')
    return {
      additions: countTextFileLines(content),
      deletions: 0,
    }
  } catch {
    return {
      additions: 0,
      deletions: 0,
    }
  }
}

const buildSessionGitWorkspaceFile = async (
  projectPath: string,
  entry: ParsedGitStatusEntry,
): Promise<SessionGitWorkspaceFile> => {
  const counts =
    entry.status === 'untracked'
      ? await readUntrackedFileChangeCounts(projectPath, entry.path)
      : await readTrackedFileChangeCounts(projectPath, entry.path)

  return {
    path: entry.path,
    previous_path: entry.previousPath,
    status: entry.status,
    additions: counts.additions,
    deletions: counts.deletions,
  }
}

const readSessionGitWorkspace = async (
  session: SessionRef,
  project: ProjectRef,
): Promise<SessionGitWorkspace> => {
  const branchStatus = await readGitBranchStatus(project.path)
  const branches = await listGitBranches(project.path, branchStatus.branch)
  const statusOutput = await runGitCommand(
    project.path,
    ['status', '--porcelain=v2', '--untracked-files=all', '-z'],
  )
  const statusEntries = parseGitStatusEntries(statusOutput.stdout)
  const files = await Promise.all(
    statusEntries.map((entry) => buildSessionGitWorkspaceFile(project.path, entry)),
  )

  return {
    session_id: session.id,
    project_id: project.id,
    branch: branchStatus.branch,
    branches,
    upstream_branch: branchStatus.upstreamBranch,
    ahead_count: branchStatus.aheadCount,
    behind_count: branchStatus.behindCount,
    files,
    updated_at: isoNow(),
  }
}

const readSessionGitWorkspaceFileDiff = async (
  session: SessionRef,
  project: ProjectRef,
  filePath: string,
  previousPath: string | null,
): Promise<SessionGitWorkspaceFileDiff> => {
  const diff =
    previousPath && previousPath !== filePath
      ? await readTrackedFileDiff(project.path, filePath)
      : filePath
        ? await (
          async () => {
            const statusOutput = await runGitCommand(
              project.path,
              ['status', '--porcelain=v2', '--untracked-files=all', '-z', '--', filePath],
            )
            const entry = parseGitStatusEntries(statusOutput.stdout).find((candidate) => candidate.path === filePath)
            if (entry?.status === 'untracked') {
              return readUntrackedFileDiff(project.path, filePath)
            }
            return readTrackedFileDiff(project.path, filePath)
          }
        )()
        : ''
  const counts = countDiffLineChanges(diff)

  return {
    session_id: session.id,
    project_id: project.id,
    path: filePath,
    previous_path: previousPath,
    additions: counts.additions,
    deletions: counts.deletions,
    diff,
  }
}

const readSessionGitHistory = async (
  session: SessionRef,
  project: ProjectRef,
): Promise<SessionGitHistory> => {
  const branchStatus = await readGitBranchStatus(project.path)
  const historyRefs = branchStatus.upstreamBranch
    ? [branchStatus.branch, branchStatus.upstreamBranch]
    : [branchStatus.branch]
  const logOutput = await runGitCommand(project.path, [
    'log',
    '--max-count=40',
    '--date=iso-strict',
    '--topo-order',
    '--decorate=short',
    '--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%cI%x1f%s%x1f%P%x1f%D',
    '--name-status',
    '--find-renames',
    ...historyRefs,
  ])

  return {
    session_id: session.id,
    project_id: project.id,
    branch: branchStatus.branch,
    upstream_branch: branchStatus.upstreamBranch,
    head_oid: branchStatus.headOid,
    upstream_head_oid: branchStatus.upstreamHeadOid,
    commits: parseGitHistory(logOutput.stdout),
    updated_at: isoNow(),
  }
}

const readSessionGitHistoryFileDiff = async (
  session: SessionRef,
  project: ProjectRef,
  commitOid: string,
  filePath: string,
  previousPath: string | null,
): Promise<SessionGitHistoryFileDiff> => {
  const readDiff = async (paths: string[]) =>
    (await runGitCommand(
      project.path,
      [
        'show',
        '--format=',
        '--no-ext-diff',
        '--no-color',
        '--binary',
        '--find-renames',
        '--unified=20',
        commitOid,
        '--',
        ...paths,
      ],
      { allowNonZeroExitCodes: [128] },
    )).stdout

  let diff = ''
  const uniquePaths = [...new Set([filePath, previousPath].filter((value): value is string => Boolean(value?.trim())))]
  if (uniquePaths.length > 0) {
    diff = await readDiff(uniquePaths)
  }

  if (!diff && previousPath && previousPath !== filePath) {
    diff = await readDiff([previousPath])
  }

  if (!diff) {
    diff = await readDiff([filePath])
  }

  const counts = countDiffLineChanges(diff)

  return {
    session_id: session.id,
    project_id: project.id,
    commit_oid: commitOid,
    path: filePath,
    previous_path: previousPath,
    additions: counts.additions,
    deletions: counts.deletions,
    diff,
  }
}

const parseSlashCommandInput = (value: string) => {
  if (!value.startsWith('/')) {
    return null
  }

  const trimmed = value.trimEnd()
  const match = /^\/([A-Za-z][A-Za-z0-9._-]*)(?:\s+(.*))?$/.exec(trimmed)
  if (!match) {
    return null
  }

  return {
    name: match[1]!.toLowerCase(),
    args: match[2]?.trim() ?? '',
    raw: trimmed,
  }
}

const detectCodexCliVersion = async () =>
  new Promise<string | null>((resolve) => {
    let stdout = ''
    let settled = false
    const command = process.platform === 'win32' ? 'codex' : 'codex'
    const child = spawn(command, ['--version'], {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const finalize = (value: string | null) => {
      if (settled) {
        return
      }
      settled = true
      resolve(value)
    }

    const timer = setTimeout(() => {
      child.kill()
      finalize(null)
    }, CODEX_VERSION_PROBE_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      finalize(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const normalized = stdout.trim()
      finalize(normalized || null)
    })
  })

const extractCodexSemver = (value: string | null) => {
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(value ?? '')
  return match?.[1] ?? null
}

const toKebabCase = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()

const parseSlashCommandNameFromAttrs = (
  variantName: string,
  attrs: string[],
) => {
  const attrText = attrs.join(' ')
  const explicitName = /to_string\s*=\s*"([^"]+)"/.exec(attrText)?.[1]
  if (explicitName) {
    return explicitName
  }

  const serializeNames = [...attrText.matchAll(/serialize\s*=\s*"([^"]+)"/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean)
  if (serializeNames.length > 0) {
    return serializeNames[0]!
  }

  return toKebabCase(variantName)
}

const isSlashCommandVisibleForCurrentEnvironment = (
  variantName: string,
) => {
  if (variantName === 'SandboxReadRoot') {
    return process.platform === 'win32'
  }

  if (variantName === 'Copy') {
    return process.platform !== 'android'
  }

  if (variantName === 'Rollout' || variantName === 'TestApproval') {
    return false
  }

  return true
}

const parseCodexSlashCommandSource = (source: string): CodexCommand[] => {
  const enumMatch = /pub enum SlashCommand\s*\{([\s\S]*?)^\}/m.exec(source)
  const descriptionMatch =
    /pub fn description\(self\) -> &'static str \{\s*match self \{([\s\S]*?)^\s*\}\s*\}/m.exec(
      source,
    )

  if (!enumMatch || !descriptionMatch) {
    throw new Error('Unable to parse Codex slash command source.')
  }

  const attrBuffer: string[] = []
  const variants: Array<{ variantName: string; commandName: string }> = []
  for (const rawLine of enumMatch[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) {
      continue
    }

    if (line.startsWith('#[strum(')) {
      attrBuffer.push(line)
      continue
    }

    const variantMatch = /^([A-Za-z][A-Za-z0-9]*)\s*,?$/.exec(line)
    if (!variantMatch) {
      attrBuffer.length = 0
      continue
    }

    const variantName = variantMatch[1]!
    variants.push({
      variantName,
      commandName: parseSlashCommandNameFromAttrs(variantName, attrBuffer),
    })
    attrBuffer.length = 0
  }

  if (variants.length === 0) {
    throw new Error('Codex slash command enum was empty.')
  }

  const descriptions = new Map<string, string>()
  const descriptionArmPattern =
    /((?:SlashCommand::[A-Za-z][A-Za-z0-9]*(?:\s*\|\s*SlashCommand::[A-Za-z][A-Za-z0-9]*)*))\s*=>\s*(?:"([^"]+)"|\{\s*"([^"]+)"\s*\})/gms
  for (const match of descriptionMatch[1].matchAll(descriptionArmPattern)) {
    const targetVariants = [...match[1].matchAll(/SlashCommand::([A-Za-z][A-Za-z0-9]*)/g)]
      .map((variantMatch) => variantMatch[1])
      .filter((value): value is string => Boolean(value))
    const description = (match[2] ?? match[3] ?? '').trim()
    for (const variantName of targetVariants) {
      descriptions.set(variantName, description)
    }
  }

  return variants
    .filter(({ variantName }) => isSlashCommandVisibleForCurrentEnvironment(variantName))
    .map(({ variantName, commandName }) => ({
      name: commandName,
      description: descriptions.get(variantName) ?? commandName,
      availability: PANDA_SUPPORTED_COMMANDS.has(commandName) ? 'supported' : 'unsupported',
    }))
}

const fetchTextWithTimeout = async (url: string) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CODEX_SOURCE_FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'panda-codex-command-catalog',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Codex source request failed with ${response.status}.`)
    }

    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

const loadCodexCommandCatalog = async (
  cliVersion: string | null,
): Promise<CodexCommand[]> => {
  const semver = extractCodexSemver(cliVersion)
  if (!semver) {
    return FALLBACK_CODEX_COMMAND_CATALOG
  }

  try {
    const source = await fetchTextWithTimeout(
      `https://raw.githubusercontent.com/openai/codex/rust-v${semver}/codex-rs/tui_app_server/src/slash_command.rs`,
    )
    const commands = parseCodexSlashCommandSource(source)
    return commands.length > 0 ? commands : FALLBACK_CODEX_COMMAND_CATALOG
  } catch {
    return FALLBACK_CODEX_COMMAND_CATALOG
  }
}

let projectSkillsCacheDirty = false

const getPandaLocalBaseDirectory = async () => {
  if (!pandaLocalBaseDirectoryPromise) {
    pandaLocalBaseDirectoryPromise = (async () => {
      const baseDirectory =
        codexHome?.trim() ||
        process.env.PANDA_CODEX_HOME?.trim() ||
        path.join(os.homedir(), '.panda')
      await fs.mkdir(baseDirectory, { recursive: true })
      return baseDirectory
    })()
  }

  return pandaLocalBaseDirectoryPromise
}

const getCodexCommandCatalogCacheFilePath = async () => {
  if (!codexCommandCatalogCacheFilePathPromise) {
    codexCommandCatalogCacheFilePathPromise = (async () => {
      const baseDirectory = await getPandaLocalBaseDirectory()
      const cacheDirectory = path.join(baseDirectory, 'cache')
      await fs.mkdir(cacheDirectory, { recursive: true })
      return path.join(cacheDirectory, 'codex-command-catalog.json')
    })()
  }

  return codexCommandCatalogCacheFilePathPromise
}

const readCachedCodexCommandCatalog = async () => {
  const cacheFilePath = await getCodexCommandCatalogCacheFilePath()

  try {
    const raw = await fs.readFile(cacheFilePath, 'utf8')
    return codexCommandCatalogSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

const writeCachedCodexCommandCatalog = async (catalog: CodexCommandCatalog) => {
  const cacheFilePath = await getCodexCommandCatalogCacheFilePath()
  await fs.writeFile(cacheFilePath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
}

const getCodexVisibleCommandsConfigFilePath = async () => {
  if (!codexVisibleCommandsConfigFilePathPromise) {
    codexVisibleCommandsConfigFilePathPromise = (async () => {
      const baseDirectory = await getPandaLocalBaseDirectory()
      const configDirectory = path.join(baseDirectory, 'config')
      await fs.mkdir(configDirectory, { recursive: true })
      return path.join(configDirectory, 'codex-visible-commands.json')
    })()
  }

  return codexVisibleCommandsConfigFilePathPromise
}

const normalizeVisibleCodexCommandConfigEntry = (
  value: unknown,
): VisibleCodexCommandConfigEntry | null => {
  if (typeof value === 'string' && value.trim()) {
    return {
      name: value.trim().toLowerCase(),
      reason: '',
    }
  }

  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as {
    name?: unknown
    reason?: unknown
  }
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
    return null
  }

  return {
    name: candidate.name.trim().toLowerCase(),
    reason:
      typeof candidate.reason === 'string' ? candidate.reason.trim() : '',
  }
}

const parseVisibleCodexCommandConfig = (
  value: unknown,
): VisibleCodexCommandConfig | null => {
  if (Array.isArray(value)) {
    const visibleCommands = value
      .map((entry) => normalizeVisibleCodexCommandConfigEntry(entry))
      .filter((entry): entry is VisibleCodexCommandConfigEntry => Boolean(entry))
    return {
      version: 1,
      visible_commands: visibleCommands,
    }
  }

  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as {
    version?: unknown
    visible_commands?: unknown
  }
  if (
    candidate.version !== undefined &&
    candidate.version !== 1 &&
    candidate.version !== LATEST_VISIBLE_CODEX_COMMAND_CONFIG_VERSION
  ) {
    return null
  }

  if (!Array.isArray(candidate.visible_commands)) {
    return null
  }

  return {
    version:
      candidate.version === LATEST_VISIBLE_CODEX_COMMAND_CONFIG_VERSION
        ? LATEST_VISIBLE_CODEX_COMMAND_CONFIG_VERSION
        : 1,
    visible_commands: candidate.visible_commands
      .map((entry) => normalizeVisibleCodexCommandConfigEntry(entry))
      .filter((entry): entry is VisibleCodexCommandConfigEntry => Boolean(entry)),
  }
}

const migrateVisibleCodexCommandConfig = (
  config: VisibleCodexCommandConfig,
): VisibleCodexCommandConfig => {
  if (config.version >= LATEST_VISIBLE_CODEX_COMMAND_CONFIG_VERSION) {
    return config
  }

  const visibleCommands = [...config.visible_commands]
  const hasReview = visibleCommands.some((entry) => entry.name === REVIEW_VISIBLE_CODEX_COMMAND_ENTRY.name)
  if (!hasReview) {
    const skillsIndex = visibleCommands.findIndex((entry) => entry.name === 'skills')
    if (skillsIndex === -1) {
      visibleCommands.push(REVIEW_VISIBLE_CODEX_COMMAND_ENTRY)
    } else {
      visibleCommands.splice(skillsIndex, 0, REVIEW_VISIBLE_CODEX_COMMAND_ENTRY)
    }
  }

  return {
    version: LATEST_VISIBLE_CODEX_COMMAND_CONFIG_VERSION,
    visible_commands: visibleCommands,
  }
}

const writeVisibleCodexCommandConfig = async (
  config: VisibleCodexCommandConfig,
) => {
  const configFilePath = await getCodexVisibleCommandsConfigFilePath()
  await fs.writeFile(configFilePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

const readVisibleCodexCommandConfig = async () => {
  const configFilePath = await getCodexVisibleCommandsConfigFilePath()

  try {
    const raw = await fs.readFile(configFilePath, 'utf8')
    const parsed = parseVisibleCodexCommandConfig(JSON.parse(raw))
    if (parsed) {
      const migrated = migrateVisibleCodexCommandConfig(parsed)
      if (migrated !== parsed) {
        await writeVisibleCodexCommandConfig(migrated)
      }
      return migrated
    }
  } catch {
    // Recreate the config below when missing or invalid.
  }

  await writeVisibleCodexCommandConfig(DEFAULT_VISIBLE_CODEX_COMMAND_CONFIG)
  return DEFAULT_VISIBLE_CODEX_COMMAND_CONFIG
}

const filterCodexCommandsForDisplay = (
  commands: CodexCommand[],
  visibleConfig: VisibleCodexCommandConfig,
) => {
  const commandMap = new Map(
    commands.map((command) => [command.name.toLowerCase(), command]),
  )
  const filteredCommands: CodexCommand[] = []
  const seen = new Set<string>()

  for (const entry of visibleConfig.visible_commands) {
    const normalizedName = entry.name.toLowerCase()
    if (seen.has(normalizedName)) {
      continue
    }

    const command = commandMap.get(normalizedName)
    if (!command) {
      continue
    }

    filteredCommands.push(command)
    seen.add(normalizedName)
  }

  return filteredCommands
}

const extractJsonObject = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Codex 没有返回命令草稿。')
  }
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1]?.trim() || trimmed
  const firstBraceIndex = candidate.indexOf('{')
  const lastBraceIndex = candidate.lastIndexOf('}')
  if (firstBraceIndex < 0 || lastBraceIndex <= firstBraceIndex) {
    throw new Error('Codex 返回的命令草稿不是有效 JSON。')
  }
  return candidate.slice(firstBraceIndex, lastBraceIndex + 1)
}

const escapePowerShellSingleQuotedLikeFragment = (value: string) =>
  value.replace(/'/g, "''")

const extractSupervisorCommandMatchFragment = (command: string) => {
  const trimmed = command.trim()

  const pnpmFilterDevMatch = trimmed.match(
    /\bpnpm\b[\s\S]*?--filter\s+([^\s"'`]+)[\s\S]*?\b(?:run\s+)?dev\b/i,
  )
  if (pnpmFilterDevMatch?.[1]) {
    return `${pnpmFilterDevMatch[1]} dev`
  }

  const npmWorkspaceDevMatch = trimmed.match(
    /\bnpm\b[\s\S]*?\brun\s+dev\b[\s\S]*?(?:--workspace|-w)\s+([^\s"'`]+)/i,
  )
  if (npmWorkspaceDevMatch?.[1]) {
    return `${npmWorkspaceDevMatch[1]} dev`
  }

  if (/\b(?:npm|yarn|pnpm|bun)\b[\s\S]*?\b(?:run\s+)?dev\b/i.test(trimmed)) {
    return trimmed
  }

  if (/\bconcurrently\b/i.test(trimmed)) {
    return 'concurrently'
  }

  if (/\bnodemon\b/i.test(trimmed)) {
    return 'nodemon'
  }

  return null
}

const buildPowerShellProcessMatchKillCommand = (commandFragment: string) =>
  [
    'Get-CimInstance Win32_Process',
    `| Where-Object { $_.CommandLine -like '*${escapePowerShellSingleQuotedLikeFragment(commandFragment)}*' }`,
    '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
  ].join(' ')

const normalizeGeneratedRunCommandDraft = (
  draft: SessionRunCommandDraft,
): SessionRunCommandDraft => {
  const normalizedDraft: SessionRunCommandDraft = {
    ...draft,
    command: draft.command.trim(),
    description: draft.description?.trim() || null,
    cwd: draft.cwd?.trim() || null,
    kill_command: draft.kill_command?.trim() || null,
    port:
      typeof draft.port === 'number' && Number.isInteger(draft.port) && draft.port > 0
        ? draft.port
        : null,
  }

  const supervisorCommandFragment = extractSupervisorCommandMatchFragment(normalizedDraft.command)
  if (
    normalizedDraft.kill_command
    && supervisorCommandFragment
    && PORT_BASED_KILL_COMMAND_PATTERN.test(normalizedDraft.kill_command)
  ) {
    normalizedDraft.kill_command =
      buildPowerShellProcessMatchKillCommand(supervisorCommandFragment)
  }

  if (
    normalizedDraft.kill_command
    && POWERSHELL_CMDLET_PATTERN.test(normalizedDraft.kill_command)
  ) {
    normalizedDraft.shell = 'powershell'
  }

  return normalizedDraft
}

const normalizeGeneratedRunWebsiteDraft = (
  draft: SessionRunWebsiteDraft,
): SessionRunWebsiteDraft => ({
  ...draft,
  name: draft.name.trim(),
  description: draft.description?.trim() || null,
  url: draft.url.trim(),
})

const parseGeneratedRunCommandDrafts = (
  value: string,
): SessionRunCommandGeneration => {
  const parsedObject = JSON.parse(extractJsonObject(value)) as {
    commands?: unknown
    reason?: unknown
  }
  const rawCommands = Array.isArray(parsedObject.commands) ? parsedObject.commands : []
  return {
    commands: rawCommands.map((entry) =>
      normalizeGeneratedRunCommandDraft(
        sessionRunCommandDraftSchema.parse(entry as SessionRunCommandDraft),
      )),
    reason:
      typeof parsedObject.reason === 'string'
        ? (parsedObject.reason.trim() || null)
        : null,
  }
}

const parseGeneratedRunWebsiteDrafts = (
  value: string,
): SessionRunWebsiteGeneration => {
  const parsedObject = JSON.parse(extractJsonObject(value)) as {
    websites?: unknown
    reason?: unknown
  }
  const rawWebsites = Array.isArray(parsedObject.websites) ? parsedObject.websites : []
  return {
    websites: rawWebsites.map((entry) =>
      normalizeGeneratedRunWebsiteDraft(
        sessionRunWebsiteDraftSchema.parse(entry as SessionRunWebsiteDraft),
      )),
    reason:
      typeof parsedObject.reason === 'string'
        ? (parsedObject.reason.trim() || null)
        : null,
  }
}

const buildStrictJsonOnlyInstructions = (input: {
  example: string
  requiredArrayField: 'commands' | 'websites'
}) => [
  'Output contract:',
  '- Your entire final answer must be exactly one valid JSON object.',
  '- The first non-whitespace character must be { and the last non-whitespace character must be }.',
  '- Do not include markdown fences, headings, explanations, bullet points, or any text before/after the JSON object.',
  '- Do not omit top-level keys; always include every required top-level key even when empty.',
  `- If you are uncertain, still return valid JSON with "${input.requiredArrayField}": [] and put the uncertainty in "reason".`,
  '- Use null for nullable fields instead of empty strings.',
  '- Do not use trailing commas.',
  '- Follow this JSON shape exactly:',
  input.example,
]

const buildRunCommandGenerationPrompt = async (projectPath: string, prompt: string) => {
  return [
    'You are Codex generating reusable Panda project run commands.',
    `Your working directory is the target project: ${projectPath}`,
    'Before answering, inspect the repository directly using your normal tools just like in a real Codex conversation.',
    'Read the files you need, search the repo, and infer the best command from the actual project contents.',
    'Do not rely on the caller to summarize package scripts, ports, or framework details for you.',
    ...buildStrictJsonOnlyInstructions({
      requiredArrayField: 'commands',
      example:
        '{"commands":[{"name":"...","description":"...","command":"...","kill_command":null,"cwd":null,"shell":"auto","node_version":null,"port":3000}],"reason":"..."}',
    }),
    'Rules:',
    '- commands: an array with one or more reusable run commands for this repo.',
    '- name: short, user-facing label in Chinese.',
    '- description: one concise sentence in Chinese.',
    '- command: a real executable command string for this repo.',
    '- kill_command: null or a real executable command string that stops the long-running process started by command.',
    '- cwd: null or a project-relative subdirectory using forward slashes.',
    '- shell: one of auto, powershell, cmd, bash.',
    '- node_version: null or an explicit x.y.z Node version if the project clearly requires one.',
    '- port: null or a positive integer when this command clearly exposes a stable local port.',
    '- reason: explain briefly why this command set is useful.',
    '- Do not include markdown fences or extra commentary.',
    '- Prefer the simplest direct foreground commands that satisfy the user intent.',
    '- Prefer an existing package script such as pnpm/npm/yarn/bun run <script> when it already matches the task.',
    '- Generate multiple commands when the project clearly has separate frontend/backend services or an extra combined startup command is obviously useful.',
    '- If a combined startup command exists naturally in the repo, include it alongside the separate commands.',
    '- Do not orchestrate multiple processes unless the repo already supports it or the user explicitly asks for a combined startup command.',
    '- Do not use Start-Process, backgrounding, command chaining, terminal multiplexing, or wrapper shell logic unless the user explicitly asks for that complexity.',
    '- You may inspect package.json files, env files, framework entrypoints, build scripts, and other relevant repo files before deciding.',
    '- If the request is ambiguous, still choose the most likely useful command set instead of inventing unsupported workflows.',
    '- Leave kill_command as null for one-shot commands such as build, test, lint, format, migration, or other commands that exit on their own.',
    '- Only provide kill_command when the main command is likely to keep running or occupy a port, such as dev servers, watchers, workers, or local backends.',
    '- Default to kill_command = null unless there is a clear reusable stop action.',
    '- If kill_command uses PowerShell cmdlets, set shell to powershell instead of auto.',
    '- If the project already has a dedicated stop script or shutdown command, prefer that over inventing a process-kill command.',
    '- If the real problem is likely "an old process is still occupying a known fixed port", prefer a targeted port-based stop command over process-name or command-line matching.',
    '- But if the chosen command is itself a package-manager dev/watch entrypoint or supervisor command, such as pnpm --filter <pkg> dev, npm run dev, concurrently, nodemon, or a watcher that will restart child processes, prefer stopping the outer startup command by a distinctive command-line fragment rather than killing only the listening port.',
    '- If no stable fixed port is known, or a port-based stop command would be less reliable than matching the actual startup command, you may fall back to a Windows command-line match stop command.',
    '- As a last resort on Windows, it is acceptable to use Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*...*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } when the match string is distinctive and clearly tied to the chosen command.',
    '- If you provide kill_command, prefer the narrowest targeted stop command that reliably fixes the expected conflict, but a practical fallback is better than returning null for a long-running backend startup command.',
    '',
    `User intent: ${prompt.trim()}`,
  ].join('\n')
}

const buildRunWebsiteGenerationPrompt = (input: {
  projectPath: string
  prompt: string
  requestHost: string | null
  requestProtocol: string | null
}) => {
  return [
    'You are Codex generating reusable Panda project website entries.',
    `Your working directory is the target project: ${input.projectPath}`,
    'Before answering, inspect the repository directly using your normal tools just like in a real Codex conversation.',
    'Read the files you need, search the repo, and infer the likely frontend or preview URLs from the actual project contents.',
    'Do not rely on the caller to summarize ports, frameworks, or scripts for you.',
    ...buildStrictJsonOnlyInstructions({
      requiredArrayField: 'websites',
      example:
        '{"websites":[{"name":"...","description":"...","url":"http://localhost:3000"}],"reason":"..."}',
    }),
    'Rules:',
    '- websites: an array with one or more project website entries.',
    '- name: short, user-facing label in Chinese.',
    '- description: one concise sentence in Chinese.',
    '- url: a direct http or https URL.',
    '- Use localhost in generated URLs when Panda is being accessed via localhost or loopback.',
    '- Use the same visible host IP/domain pattern as Panda when Panda is being accessed via a non-localhost host.',
    '- Infer ports from real project files, scripts, env values, or framework defaults only when reasonable.',
    '- Prefer frontend dev or preview addresses, not backend API addresses, unless the project itself is an API console or admin page.',
    '- Do not include markdown fences or extra commentary.',
    '- reason: explain briefly why these website entries are useful.',
    `Visible Panda host: ${input.requestHost ?? 'localhost'}`,
    `Visible Panda protocol: ${input.requestProtocol ?? 'http'}`,
    '',
    `User intent: ${input.prompt.trim()}`,
  ].join('\n')
}

function resolveCodexHomePath(codexHome: string | undefined) {
  return codexHome?.trim() || path.join(os.homedir(), '.codex')
}

function formatDiagnosticLogEntry(
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
  message: string,
  payload: Record<string, unknown>,
) {
  const lines = [
    `${new Date().toISOString()} [${level}] ${message}`,
    JSON.stringify(payload, null, 2),
    '',
  ]
  return `${lines.join('\n')}\n`
}

function createDiagnosticLogger(
  codexHome: string | undefined,
  options: {
    relativePath: string
    initMessage: string
  },
): {
  logger: DiagnosticLogger
  filePath: string
} {
  const filePath = path.join(resolveCodexHomePath(codexHome), options.relativePath)
  let writeQueue: Promise<void> = fs
    .mkdir(path.dirname(filePath), { recursive: true })
    .then(() =>
      fs.writeFile(
        filePath,
        formatDiagnosticLogEntry('INFO', options.initMessage, {
          filePath,
          pid: process.pid,
        }),
        'utf8',
      ),
    )
    .catch(() => undefined)

  const enqueueWrite = (
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
    message: string,
    payload: Record<string, unknown>,
  ) => {
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(() => fs.appendFile(filePath, formatDiagnosticLogEntry(level, message, payload), 'utf8'))
      .catch(() => undefined)
  }

  return {
    filePath,
    logger: {
      info(payload, message) {
        enqueueWrite('INFO', message, payload)
      },
      warn(payload, message) {
        enqueueWrite('WARN', message, payload)
      },
      error(payload, message) {
        enqueueWrite('ERROR', message, payload)
      },
      debug() {
        return
      },
    },
  }
}

const basenameFromPath = (targetPath: string) => {
  const normalized = targetPath.replace(/[\\/]+$/, '')
  return path.basename(normalized) || normalized
}

const truncateSummary = (value: string, maxLength = 88) => {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) {
    return trimmed
  }

  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`
}

const sanitizeGeneratedSessionTitle = (
  value: string,
  maxLength = SESSION_GENERATED_TITLE_MAX_LENGTH,
) => {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^["'`\[\]【】()（）\s]+|["'`\[\]【】()（）\s]+$/g, '')
    .replace(/^(标题|Title)\s*[:：-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return null
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return normalized.slice(0, maxLength).trimEnd()
}

const buildSessionTitleGenerationPrompt = (input: {
  message: string
  attachments: SessionInputAttachment[]
}) => {
  const message = input.message.trim()
  const attachmentNames = input.attachments
    .map((attachment) => attachment.name.trim())
    .filter(Boolean)
    .slice(0, 5)

  const contextParts = [
    message ? `用户首条消息：\n${message}` : null,
    attachmentNames.length > 0
      ? `附件：\n${attachmentNames.map((name) => `- ${name}`).join('\n')}`
      : null,
  ].filter(Boolean)

  return [
    '请根据下面的新会话首条消息生成一个简短的中文会话标题。',
    '要求：',
    '1. 只输出标题本身，不要解释，不要加引号。',
    '2. 标题要准确概括任务目标，不要照抄原句。',
    '3. 尽量控制在 4 到 14 个汉字，或等价的短英文长度。',
    '4. 避免空泛词，比如“求助”“问题”“聊天”“新会话”。',
    '',
    ...contextParts,
  ].join('\n')
}

const createDiagnosticHash = (value: string) =>
  createHash('sha1').update(value).digest('hex').slice(0, 16)

const summarizeTextForDiagnostics = (
  value: string | null | undefined,
  options?: { previewLength?: number },
) => {
  const normalized = typeof value === 'string' ? value.trim() : ''
  const previewLength = options?.previewLength ?? 120
  return {
    length: normalized.length,
    hash: createDiagnosticHash(normalized),
    preview: normalized ? truncateSummary(normalized, previewLength) : '',
  }
}

const summarizeAttachmentsForDiagnostics = (
  attachments: SessionInputAttachment[],
) =>
  attachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mime_type ?? null,
    sizeBytes: attachment.size_bytes ?? null,
    dataHash: createDiagnosticHash(attachment.data_url),
  }))

const summarizeForwardingPayload = (input: {
  title?: string | null
  input: string
  prompt: string | null
  attachments: SessionInputAttachment[]
  model: string | null
  titleGenerationModel?: string | null
  reasoningEffort: string | null
  requestedServiceTier: unknown
  normalizedRequestedServiceTier: 'fast' | 'flex' | null
  effectiveServiceTier: 'fast' | null
  planMode: boolean
  yoloMode?: boolean
}) => {
  const titleSummary = summarizeTextForDiagnostics(input.title ?? '', { previewLength: 80 })
  const inputSummary = summarizeTextForDiagnostics(input.input)
  const promptSummary = summarizeTextForDiagnostics(input.prompt)
  const attachmentsSummary = summarizeAttachmentsForDiagnostics(input.attachments)
  return {
    fingerprint: createDiagnosticHash(
      JSON.stringify({
        titleHash: titleSummary.hash,
        inputHash: inputSummary.hash,
        promptHash: promptSummary.hash,
        attachments: attachmentsSummary.map((attachment) => ({
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataHash: attachment.dataHash,
        })),
        model: input.model,
        titleGenerationModel: input.titleGenerationModel ?? null,
        reasoningEffort: input.reasoningEffort,
        requestedServiceTier: input.requestedServiceTier ?? null,
        normalizedRequestedServiceTier: input.normalizedRequestedServiceTier,
        effectiveServiceTier: input.effectiveServiceTier,
        planMode: input.planMode,
        yoloMode: input.yoloMode === true,
      }),
    ),
    title: titleSummary,
    input: inputSummary,
    prompt: promptSummary,
    attachments: attachmentsSummary,
    model: input.model,
    titleGenerationModel: input.titleGenerationModel ?? null,
    reasoningEffort: input.reasoningEffort,
    requestedServiceTier:
      input.requestedServiceTier === 'fast' || input.requestedServiceTier === 'flex'
        ? input.requestedServiceTier
        : input.requestedServiceTier ?? null,
    normalizedRequestedServiceTier: input.normalizedRequestedServiceTier,
    effectiveServiceTier: input.effectiveServiceTier,
    planMode: input.planMode,
    yoloMode: input.yoloMode === true,
  }
}

const normalizeServiceTier = (value: unknown): 'fast' | 'flex' | null =>
  value === 'fast' || value === 'flex' ? value : null

const resolvePandaServiceTier = (
  requestedServiceTier: 'fast' | 'flex' | null,
): 'fast' | null => (requestedServiceTier === 'fast' ? 'fast' : null)

const readHeaderValue = (
  value: string | string[] | undefined,
) => {
  if (Array.isArray(value)) {
    return value[0] ?? null
  }
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const parseRequestVisibleHost = (request: FastifyRequest) => {
  const hostCandidate =
    readHeaderValue(request.headers['x-forwarded-host']) ||
    readHeaderValue(request.headers.host)
  if (!hostCandidate) {
    return 'localhost'
  }

  const withoutPort = hostCandidate
    .split(',')[0]
    ?.trim()
    .replace(/^\[|\]$/g, '')
    .split(':')[0]
    ?.trim()
  return withoutPort || 'localhost'
}

const parseRequestVisibleProtocol = (request: FastifyRequest) => {
  const forwardedProto = readHeaderValue(request.headers['x-forwarded-proto'])
    ?.split(',')[0]
    ?.trim()
  if (forwardedProto === 'https') {
    return 'https'
  }
  if (forwardedProto === 'http') {
    return 'http'
  }

  const origin = readHeaderValue(request.headers.origin)
  if (origin) {
    try {
      return new URL(origin).protocol === 'https:' ? 'https' : 'http'
    } catch {
      // Ignore malformed origin header.
    }
  }

  return 'http'
}

const normalizeGeneratedWebsiteDrafts = (
  drafts: SessionRunWebsiteDraft[],
  request: FastifyRequest,
) => {
  const visibleHost = parseRequestVisibleHost(request)
  const visibleProtocol = parseRequestVisibleProtocol(request)
  const preferredHost = LOOPBACK_HOSTS.has(visibleHost) ? 'localhost' : visibleHost

  return drafts.map((draft) => {
    try {
      const parsed = new URL(draft.url)
      if (LOOPBACK_HOSTS.has(parsed.hostname) || parsed.hostname === '0.0.0.0') {
        parsed.hostname = preferredHost
      }
      parsed.protocol = visibleProtocol === 'https' ? 'https:' : 'http:'
      return {
        ...draft,
        url: parsed.toString(),
      }
    } catch {
      return draft
    }
  })
}

const summarizeForwardingRequest = (request: FastifyRequest) => ({
  host: readHeaderValue(request.headers.host),
  origin: readHeaderValue(request.headers.origin),
  referer: readHeaderValue(request.headers.referer),
  forwardedHost: readHeaderValue(request.headers['x-forwarded-host']),
  forwardedProto: readHeaderValue(request.headers['x-forwarded-proto']),
  userAgent: readHeaderValue(request.headers['user-agent']),
  remoteAddress: request.ip,
})

const normalizeSessionInputAttachments = (
  value: unknown,
): SessionInputAttachment[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const candidate = item as Partial<SessionInputAttachment>
      const id =
        typeof candidate.id === 'string' && candidate.id.trim()
          ? candidate.id.trim()
          : `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const kind = candidate.kind === 'image' || candidate.kind === 'file'
        ? candidate.kind
        : null
      const name =
        typeof candidate.name === 'string' && candidate.name.trim()
          ? candidate.name.trim()
          : ''
      const dataUrl =
        typeof candidate.data_url === 'string' && candidate.data_url.trim()
          ? candidate.data_url.trim()
          : ''
      const mimeType =
        typeof candidate.mime_type === 'string' && candidate.mime_type.trim()
          ? candidate.mime_type.trim()
          : null
      const sizeBytes =
        typeof candidate.size_bytes === 'number' && Number.isFinite(candidate.size_bytes)
          ? Math.max(0, Math.round(candidate.size_bytes))
          : null

      if (!kind || !name || !dataUrl) {
        return null
      }

      return {
        id,
        kind,
        name,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        data_url: dataUrl,
      } satisfies SessionInputAttachment
    })
    .filter((item): item is SessionInputAttachment => Boolean(item))
}

const buildTurnPrompt = (input: string, planMode: boolean) => {
  if (!planMode || !input.trim()) {
    return input
  }

  return `${PLAN_MODE_PROMPT_PREFIX}${input}`
}

const toSessionWithRunState = (
  session: SessionRef,
  patch?: Partial<SessionWithRunState>,
): SessionWithRunState => ({
  ...session,
  run_state: patch?.run_state ?? session.run_state ?? 'idle',
  run_state_changed_at:
    patch?.run_state_changed_at ?? session.run_state_changed_at ?? null,
  ...patch,
})

const mergeTimelineEntries = (
  baseEntries: TimelineEntry[],
  overlayEntries: TimelineEntry[],
) => {
  const seen = new Set<string>()
  const mergedEntries = [...baseEntries, ...overlayEntries]
    .filter((entry) => {
      if (seen.has(entry.id)) {
        return false
      }
      seen.add(entry.id)
      return true
    })
    .sort((left, right) => +new Date(left.timestamp) - +new Date(right.timestamp))

  return collapseDuplicateUserEntries(mergedEntries, {
    maxSkewMs: USER_ENTRY_MATCH_EARLY_SKEW_MS,
  })
}

const isUserOverlayEntry = (entry: TimelineEntry) =>
  entry.kind === 'user' && entry.id.startsWith(USER_OVERLAY_ENTRY_PREFIX)

const normalizeTimelineEntryBody = (entry: Pick<TimelineEntry, 'body'>) =>
  entry.body.replace(/\r\n/g, '\n').trim()

const canMatchUserEntries = (
  overlayEntry: Pick<TimelineEntry, 'body' | 'timestamp'>,
  authoritativeEntry: Pick<TimelineEntry, 'body' | 'timestamp'>,
) => {
  if (normalizeTimelineEntryBody(overlayEntry) !== normalizeTimelineEntryBody(authoritativeEntry)) {
    return false
  }

  const overlayTime = +new Date(overlayEntry.timestamp)
  const authoritativeTime = +new Date(authoritativeEntry.timestamp)
  if (!Number.isFinite(overlayTime) || !Number.isFinite(authoritativeTime)) {
    return true
  }

  return authoritativeTime >= overlayTime - USER_ENTRY_MATCH_EARLY_SKEW_MS
}

const reconcileTimelineOverlayEntries = (
  overlayEntries: TimelineEntry[],
  authoritativeEntries: TimelineEntry[],
) => {
  const authoritativeUsers = authoritativeEntries.filter(
    (entry) => entry.kind === 'user' && !isUserOverlayEntry(entry),
  )
  if (overlayEntries.length === 0 || authoritativeUsers.length === 0) {
    return overlayEntries
  }

  const usedAuthoritativeIndexes = new Set<number>()
  return overlayEntries.filter((entry) => {
    if (!isUserOverlayEntry(entry)) {
      return true
    }

    const matchedIndex = authoritativeUsers.findIndex(
      (authoritativeEntry, index) =>
        !usedAuthoritativeIndexes.has(index) &&
        canMatchUserEntries(entry, authoritativeEntry),
    )

    if (matchedIndex < 0) {
      return true
    }

    usedAuthoritativeIndexes.add(matchedIndex)
    return false
  })
}

const readTimelineOverlay = (
  sessionId: string,
  authoritativeEntries?: TimelineEntry[],
) => {
  const overlayEntries = sessionTimelineOverlays.get(sessionId) ?? []
  if (!authoritativeEntries || overlayEntries.length === 0) {
    return overlayEntries
  }

  const nextOverlayEntries = reconcileTimelineOverlayEntries(
    overlayEntries,
    authoritativeEntries,
  )
  const matchedOverlayEntries = overlayEntries.filter(
    (entry) => !nextOverlayEntries.includes(entry),
  )

  if (matchedOverlayEntries.length > 0) {
    const remainingAuthoritativeIndexes = new Set(
      authoritativeEntries
        .map((entry, index) =>
          entry.kind === 'user' && !isUserOverlayEntry(entry) ? index : -1,
        )
        .filter((index) => index >= 0),
    )

    for (const overlayEntry of matchedOverlayEntries) {
      if ((overlayEntry.attachments ?? []).length === 0) {
        continue
      }

      const matchedIndex = authoritativeEntries.findIndex(
        (authoritativeEntry, index) =>
          remainingAuthoritativeIndexes.has(index) &&
          authoritativeEntry.kind === 'user' &&
          !isUserOverlayEntry(authoritativeEntry) &&
          canMatchUserEntries(overlayEntry, authoritativeEntry),
      )

      if (matchedIndex < 0) {
        continue
      }

      remainingAuthoritativeIndexes.delete(matchedIndex)
      const authoritativeEntry = authoritativeEntries[matchedIndex]
      if (!authoritativeEntry) {
        continue
      }

      authoritativeEntries[matchedIndex] = {
        ...authoritativeEntry,
        attachments: mergeTimelineAttachments(
          authoritativeEntry.attachments,
          overlayEntry.attachments,
        ),
      }
    }
  }

  if (nextOverlayEntries.length === overlayEntries.length) {
    return overlayEntries
  }

  if (nextOverlayEntries.length === 0) {
    sessionTimelineOverlays.delete(sessionId)
    return []
  }

  sessionTimelineOverlays.set(sessionId, nextOverlayEntries)
  return nextOverlayEntries
}

const readTimelineFromRollout = async (sessionId: string) => {
  const { readCodexTimeline } = await import('./index')
  return readCodexTimeline(sessionId, {
    codexHome,
    sessionFiles: discoveredSessionFiles,
  })
}

const mergeSessionRecoveryPatch = (
  ...patches: Array<SessionRecoveryPatch | null | undefined>
) => {
  const merged: SessionRecoveryPatch = {}

  for (const patch of patches) {
    if (!patch) {
      continue
    }

    if (patch.run_state !== undefined) {
      merged.run_state = patch.run_state
    }
    if (patch.run_state_changed_at !== undefined) {
      merged.run_state_changed_at = patch.run_state_changed_at
    }
    if (patch.summary !== undefined) {
      merged.summary = patch.summary
    }
    if (patch.latest_assistant_message !== undefined) {
      merged.latest_assistant_message = patch.latest_assistant_message
    }
    if (patch.last_event_at !== undefined) {
      merged.last_event_at = patch.last_event_at
    }
    if (patch.context_usage !== undefined) {
      merged.context_usage = patch.context_usage
    }
  }

  return merged
}

const materializeSessionState = async (
  sessionId: string,
  options?: {
    session?: SessionRef | SessionWithRunState | null
    resumeLiveSession?: boolean
    includeChangeSets?: boolean
  },
): Promise<MaterializedSessionState | null> => {
  const session = options?.session ?? (await findSnapshotSession(sessionId))
  if (!session) {
    return null
  }

  const filePath = discoveredSessionFiles[sessionId]
  await liveSessionStream.ensureSessionTracker(sessionId, filePath).catch(() => false)

  const resumed =
    options?.resumeLiveSession === false
      ? null
      : await liveSessionStream.resumeSessionWithAppServer(sessionId)
  const includeChangeSets = options?.includeChangeSets !== false
  const hydrated = await liveSessionStream.hydrateSession(sessionId, filePath, {
    includeChangeSets,
  })
  const managedTimeline = managedTimelines.get(sessionId) ?? []
  const rolloutTimeline =
    hydrated?.entries ??
    (managedTimeline.length > 0 ? managedTimeline : await readTimelineFromRollout(sessionId))
  const baseTimeline = mergeTimelineEntries(rolloutTimeline, managedTimeline)
  const timeline = mergeTimelineEntries(
    baseTimeline,
    readTimelineOverlay(sessionId, baseTimeline),
  )
  if (baseTimeline.length > 0) {
    managedTimelines.set(sessionId, baseTimeline)
  }

  const sessionPatch = mergeSessionRecoveryPatch(
    hydrated?.sessionPatch,
    resumed?.sessionPatch,
    liveSessionStream.peekSessionPatch(sessionId) ?? undefined,
  )
  if (Object.keys(sessionPatch).length > 0) {
    applySessionPatch(sessionId, sessionPatch)
  }

  const interactions =
    resumed?.interactionRequests ??
    hydrated?.interactionRequests ??
    sessionInteractions.get(sessionId) ??
    []
  sessionInteractions.set(sessionId, interactions)

  const planSnapshot =
    resumed?.planSnapshot ??
    hydrated?.planSnapshot ??
    sessionPlans.get(sessionId) ??
    null
  sessionPlans.set(sessionId, planSnapshot)

  const changeSets = includeChangeSets
    ? hydrated?.changeSets.length
        ? hydrated.changeSets
        : sessionChangeSets.get(sessionId) ?? []
    : []
  if (includeChangeSets) {
    sessionChangeSets.set(sessionId, changeSets)
  }

  const terminalSnapshot = session.capability.can_show_terminal
    ? runWorkbenchManager.getSnapshot({
        sessionId,
        projectId: session.project_id,
      })
    : null

  return {
    session,
    sessionPatch,
    timeline,
    interactions,
    planSnapshot,
    changeSets,
    terminalSnapshot,
  }
}

const buildSessionRecoverySnapshot = async (
  sessionId: string,
  options?: {
    session?: SessionRef | SessionWithRunState | null
    resumeLiveSession?: boolean
  },
): Promise<SessionRecoverySnapshot | null> => {
  const materialized = await materializeSessionState(sessionId, options)
  if (!materialized) {
    return null
  }

  return {
    session_id: sessionId,
    recovered_at: isoNow(),
    session_patch: materialized.sessionPatch,
    timeline: materialized.timeline,
    interactions: materialized.interactions,
    plan_snapshot: materialized.planSnapshot,
    change_sets: materialized.changeSets,
    terminal_snapshot: materialized.terminalSnapshot,
  }
}

const findLastUserTimelineEntryIndex = (entries: TimelineEntry[]) => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === 'user') {
      return index
    }
  }

  return -1
}

const buildTailTimelineEntries = (entries: TimelineEntry[]) => {
  const lastUserIndex = findLastUserTimelineEntryIndex(entries)
  if (lastUserIndex < 0) {
    return {
      anchorEntryId: null,
      hasEarlierEntries: false,
      entries,
    }
  }

  return {
    anchorEntryId: entries[lastUserIndex]?.id ?? null,
    hasEarlierEntries: lastUserIndex > 0,
    entries: entries.slice(lastUserIndex),
  }
}

const compactEarlierTimelineEntries = (entries: TimelineEntry[]) => {
  const compacted: TimelineEntry[] = []
  let pendingUsers: TimelineEntry[] = []
  let pendingAssistants: TimelineEntry[] = []

  const flushTurn = () => {
    if (pendingUsers.length === 0 && pendingAssistants.length === 0) {
      return
    }

    compacted.push(...pendingUsers)
    const finalAssistant = pendingAssistants[pendingAssistants.length - 1]
    if (finalAssistant) {
      compacted.push(finalAssistant)
    }

    pendingUsers = []
    pendingAssistants = []
  }

  for (const entry of entries) {
    if (entry.kind === 'user') {
      if (pendingAssistants.length > 0) {
        flushTurn()
      }
      pendingUsers.push(entry)
      continue
    }

    if (entry.kind === 'assistant' && pendingUsers.length > 0) {
      pendingAssistants.push(entry)
    }
  }

  flushTurn()
  return compacted
}

const truncateTimelineToolText = (value: string, limit = TIMELINE_TOOL_SUMMARY_LIMIT) => {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

const tryParseTimelineToolBody = (body: string) => {
  try {
    const parsed = JSON.parse(body) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const resolveTimelineToolSessionIds = (input: {
  entry: TimelineEntry
  commandTitle?: string | null
}) => {
  const parsedBody = tryParseTimelineToolBody(input.entry.body)
  if (!parsedBody) {
    return [] as string[]
  }

  const sessionIds = new Set<string>()
  const addSessionId = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      sessionIds.add(value.trim())
    }
  }

  if (input.entry.title === 'close_agent') {
    addSessionId(parsedBody.target)
    addSessionId(parsedBody.id)
    addSessionId(parsedBody.sessionId)
    addSessionId(parsedBody.session_id)
  }

  if (input.entry.title === 'spawn_agent' || input.commandTitle === 'spawn_agent') {
    addSessionId(parsedBody.agent_id)
    addSessionId(parsedBody.id)
    addSessionId(parsedBody.sessionId)
    addSessionId(parsedBody.session_id)
  }

  return [...sessionIds]
}

const buildTimelinePatchSummary = (body: string): TimelinePatchSummary | null => {
  const files = parseApplyPatchChangeFiles(body)
  if (files.length === 0) {
    return null
  }

  return {
    files: files.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

const summarizeTimelineToolBody = (entry: TimelineEntry, patchSummary: TimelinePatchSummary | null) => {
  if (entry.title === 'apply_patch' && patchSummary) {
    if (patchSummary.files.length === 1) {
      return truncateTimelineToolText(patchSummary.files[0]!.path)
    }

    return `${patchSummary.files.length} 个文件`
  }

  const parsedBody = tryParseTimelineToolBody(entry.body)
  if (parsedBody) {
    const preferredFields = ['command', 'cmd', 'path', 'pattern', 'q', 'input', 'output', 'message']
    for (const field of preferredFields) {
      const value = parsedBody[field]
      if (typeof value === 'string' && value.trim()) {
        return truncateTimelineToolText(value)
      }
    }
  }

  if (entry.title && entry.title !== 'tool-output') {
    if (entry.body.trim().startsWith('{') || entry.body.trim().startsWith('[')) {
      return truncateTimelineToolText(entry.title.replace(/[_-]+/g, ' '))
    }

    return truncateTimelineToolText(entry.body || entry.title)
  }

  return truncateTimelineToolText(entry.body || '工具执行')
}

const summarizeTimelineEntryTransport = (
  entry: TimelineEntry,
  options?: {
    commandTitle?: string | null
  },
): TimelineEntry => {
  if (entry.kind !== 'tool') {
    return {
      ...entry,
      body_truncated: false,
      detail_available: false,
      patch_summary: null,
      session_ids: [],
    }
  }

  const patchSummary = entry.title === 'apply_patch' ? buildTimelinePatchSummary(entry.body) : null
  const summaryBody = summarizeTimelineToolBody(entry, patchSummary)
  const normalizedBody = entry.body.trim()
  const bodyTruncated = normalizedBody !== summaryBody

  return {
    ...entry,
    body: summaryBody,
    body_truncated: bodyTruncated,
    detail_available: normalizedBody.length > 0 && (bodyTruncated || patchSummary !== null),
    patch_summary: patchSummary,
    session_ids: resolveTimelineToolSessionIds({
      entry,
      commandTitle: options?.commandTitle ?? null,
    }),
  }
}

const summarizeTimelineEntriesForTransport = (entries: TimelineEntry[]) => {
  const summarizedEntries: TimelineEntry[] = []
  let currentCommandTitle: string | null = null

  for (const entry of entries) {
    if (entry.kind !== 'tool') {
      currentCommandTitle = null
      summarizedEntries.push(summarizeTimelineEntryTransport(entry))
      continue
    }

    if (entry.title === 'tool-output') {
      summarizedEntries.push(
        summarizeTimelineEntryTransport(entry, {
          commandTitle: currentCommandTitle,
        }),
      )
      continue
    }

    currentCommandTitle = entry.title
    summarizedEntries.push(summarizeTimelineEntryTransport(entry))
  }

  return summarizedEntries
}

const buildTimelineSnapshot = (
  sessionId: string,
  entries: TimelineEntry[],
  view: SessionTimelineView,
): SessionTimelineSnapshot => {
  const tail = buildTailTimelineEntries(entries)
  const nextEntries =
    view === 'full_compact' && tail.hasEarlierEntries
      ? [
          ...compactEarlierTimelineEntries(
            entries.slice(0, Math.max(0, entries.length - tail.entries.length)),
          ),
          ...tail.entries,
        ]
      : tail.entries

  return {
    session_id: sessionId,
    generated_at: isoNow(),
    view,
    anchor_entry_id: tail.anchorEntryId,
    has_earlier_entries: view === 'full_compact' ? false : tail.hasEarlierEntries,
    entries: summarizeTimelineEntriesForTransport(nextEntries),
  }
}

const summarizeChangeFile = (file: ChangeFile): ChangeFileSummary => ({
  path: file.path,
  kind: file.kind,
  move_path: file.move_path,
  additions: file.additions,
  deletions: file.deletions,
  item_id: file.item_id,
  diff_available: file.diff.trim().length > 0,
})

const summarizeChangeSet = (changeSet: ChangeSet): ChangeSetSummary => ({
  id: changeSet.id,
  session_id: changeSet.session_id,
  turn_id: changeSet.turn_id,
  source: changeSet.source,
  status: changeSet.status,
  started_at: changeSet.started_at,
  completed_at: changeSet.completed_at,
  updated_at: changeSet.updated_at,
  aggregated_diff_available: changeSet.aggregated_diff.trim().length > 0,
  files: changeSet.files.map(summarizeChangeFile),
})

const summarizeChangeSets = (changeSets: ChangeSet[]) =>
  changeSets.map(summarizeChangeSet)

const readSessionRunWorkbench = async (
  session: SessionRef | SessionWithRunState,
): Promise<{
  command_catalog: Awaited<ReturnType<typeof readProjectRunCommandCatalog>>
  website_catalog: Awaited<ReturnType<typeof readProjectRunWebsiteCatalog>>
  node_runtime: Awaited<ReturnType<typeof readSessionRunNodeRuntime>>
  terminal_snapshot: NonNullable<ReturnType<typeof runWorkbenchManager.getSnapshot>>
} | null> => {
  if (!session.capability.can_show_terminal) {
    return null
  }

  const project = await readProjectForSession(session)
  if (!project) {
    throw new Error('Project not found.')
  }

  const [commandCatalog, websiteCatalog, nodeRuntime, terminalSnapshot] = await Promise.all([
    readProjectRunCommandCatalog({
      sessionId: session.id,
      projectId: project.id,
      projectPath: project.path,
    }),
    readProjectRunWebsiteCatalog({
      sessionId: session.id,
      projectId: project.id,
      projectPath: project.path,
    }),
    readSessionRunNodeRuntime(),
    Promise.resolve(
      runWorkbenchManager.getSnapshot({
        sessionId: session.id,
        projectId: project.id,
      }),
    ),
  ])

  return {
    command_catalog: commandCatalog,
    website_catalog: websiteCatalog,
    node_runtime: nodeRuntime,
    terminal_snapshot: terminalSnapshot,
  }
}

const buildSessionBootstrapSnapshot = async (
  sessionId: string,
  options?: {
    session?: SessionRef | SessionWithRunState | null
    resumeLiveSession?: boolean
    timelineView?: SessionTimelineView
  },
): Promise<SessionBootstrapSnapshot | null> => {
  const materialized = await materializeSessionState(sessionId, {
    ...options,
    includeChangeSets: false,
  })
  if (!materialized) {
    return null
  }

  return {
    session_id: sessionId,
    generated_at: isoNow(),
    session_patch: materialized.sessionPatch,
    timeline: buildTimelineSnapshot(
      sessionId,
      materialized.timeline,
      options?.timelineView ?? 'tail',
    ),
    interactions: materialized.interactions,
    plan_snapshot: materialized.planSnapshot,
    run_workbench: await readSessionRunWorkbench(materialized.session),
    change_sets: [],
  }
}

const readTimelineForSession = async (
  sessionId: string,
  view: SessionTimelineView,
) => {
  const materialized = await materializeSessionState(sessionId, {
    resumeLiveSession: false,
    includeChangeSets: false,
  })
  return buildTimelineSnapshot(sessionId, materialized?.timeline ?? [], view)
}

const buildSessionToolCallDetail = async (
  sessionId: string,
  entryId: string,
): Promise<SessionToolCallDetail | null> => {
  const materialized = await materializeSessionState(sessionId, {
    resumeLiveSession: false,
    includeChangeSets: false,
  })
  const timeline = materialized?.timeline ?? []
  const entryIndex = timeline.findIndex((entry) => entry.id === entryId)
  if (entryIndex < 0) {
    return null
  }

  const commandEntry = timeline[entryIndex]
  if (!commandEntry || commandEntry.kind !== 'tool' || commandEntry.title === 'tool-output') {
    return null
  }

  const outputEntries: TimelineEntry[] = []
  for (let index = entryIndex + 1; index < timeline.length; index += 1) {
    const candidate = timeline[index]
    if (!candidate || candidate.kind !== 'tool' || candidate.title !== 'tool-output') {
      break
    }

    outputEntries.push({
      ...candidate,
      body_truncated: false,
      detail_available: false,
      patch_summary: null,
      session_ids: resolveTimelineToolSessionIds({
        entry: candidate,
        commandTitle: commandEntry.title,
      }),
    })
  }

  return {
    session_id: sessionId,
    entry_id: entryId,
    command_entry: {
      ...commandEntry,
      body_truncated: false,
      detail_available: false,
      patch_summary:
        commandEntry.title === 'apply_patch' ? buildTimelinePatchSummary(commandEntry.body) : null,
      session_ids: resolveTimelineToolSessionIds({
        entry: commandEntry,
      }),
    },
    output_entries: outputEntries,
  }
}

const readLatestTimelineEntryByKind = (
  entries: TimelineEntry[],
  kind: TimelineEntry['kind'],
) => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.kind === kind) {
      return entry
    }
  }

  return null
}

const readSessionCompletionTitle = (sessionId: string) => {
  const session =
    managedSessions.get(sessionId) ??
    snapshot.sessions.find((item) => item.id === sessionId) ??
    null
  const title = session?.title?.trim()
  return title || '当前会话'
}

const resolveCompletionReply = (input: {
  sessionId: string
  sessionPatch?: {
    latest_assistant_message?: string | null
  }
  entries?: TimelineEntry[]
  completionReason: 'completed' | 'interrupted'
}) => {
  if (input.completionReason !== 'completed') {
    return ''
  }

  const patchReply =
    typeof input.sessionPatch?.latest_assistant_message === 'string'
      ? input.sessionPatch.latest_assistant_message.trim()
      : ''
  if (patchReply) {
    return patchReply
  }

  const latestAssistantEntry = input.entries
    ? readLatestTimelineEntryByKind(input.entries, 'assistant')
    : null
  const timelineReply = latestAssistantEntry?.body?.trim() ?? ''
  if (timelineReply) {
    return timelineReply
  }

  const snapshotReply =
    managedSessions.get(input.sessionId)?.latest_assistant_message?.trim() ||
    snapshot.sessions
      .find((item) => item.id === input.sessionId)
      ?.latest_assistant_message?.trim() ||
    ''

  return snapshotReply
}

const buildTurnCompletedPayload = (input: {
  sessionId: string
  sessionPatch: {
    run_state?: 'idle' | 'running' | 'completed'
    run_state_changed_at?: string | null
    latest_assistant_message?: string | null
  }
  entries?: TimelineEntry[]
  completionReason: 'completed' | 'interrupted'
}) => {
  if (input.sessionPatch.run_state !== 'completed') {
    return null
  }

  const completedAt =
    typeof input.sessionPatch.run_state_changed_at === 'string' &&
    input.sessionPatch.run_state_changed_at.trim()
      ? input.sessionPatch.run_state_changed_at
      : null

  if (!completedAt) {
    return null
  }

  return {
    sessionId: input.sessionId,
    completedAt,
    completionReason: input.completionReason,
    sessionTitle: readSessionCompletionTitle(input.sessionId),
    finalReply: resolveCompletionReply(input),
  }
}

const maybeBroadcastTurnCompleted = (input: {
  sessionId: string
  sessionPatch: {
    run_state?: 'idle' | 'running' | 'completed'
    run_state_changed_at?: string | null
    latest_assistant_message?: string | null
  }
  entries?: TimelineEntry[]
  completionReason: 'completed' | 'interrupted'
}) => {
  const payload = buildTurnCompletedPayload(input)
  if (!payload) {
    return
  }

  const completionKey = `${payload.completionReason}:${payload.completedAt}`
  if (emittedTurnCompletionKeys.get(payload.sessionId) === completionKey) {
    return
  }

  emittedTurnCompletionKeys.set(payload.sessionId, completionKey)
  broadcastEvent('turn.completed', payload)
  void notifyCompletionPush(payload)
}

const COMPLETION_PUSH_BODY_MAX_LENGTH = 280

const formatCompletionPushBody = (value: string | null | undefined) => {
  const normalized = (typeof value === 'string' ? value : '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return '点开查看本次会话的最终回复。'
  }

  if (normalized.length <= COMPLETION_PUSH_BODY_MAX_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, COMPLETION_PUSH_BODY_MAX_LENGTH - 1).trimEnd()}…`
}

const notifyCompletionPush = async (payload: {
  sessionId: string
  completedAt: string
  sessionTitle: string
  finalReply: string
}) => {
  if (!hubPushSubscriptionStore || !hubWebPushNotifier?.publicConfig.supported) {
    return
  }

  const subscriptions =
    hubPushSubscriptionStore.listEnabledForCompletionNotifications()
  if (subscriptions.length === 0) {
    return
  }

  const notificationPayload = {
    title: payload.sessionTitle || 'Panda 会话已完成',
    body: formatCompletionPushBody(payload.finalReply),
    url: `/session/${payload.sessionId}`,
    tag: `session-completed:${payload.sessionId}:${payload.completedAt}`,
    sessionId: payload.sessionId,
  }

  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      const result = await hubWebPushNotifier.sendNotification(
        subscription.subscription,
        notificationPayload,
      )

      if (result.ok) {
        hubPushSubscriptionStore.markDeliveryResult(
          subscription.subscription.endpoint,
          { success: true },
        )
        return
      }

      hubPushSubscriptionStore.markDeliveryResult(
        subscription.subscription.endpoint,
        {
          success: false,
          failureReason:
            ('message' in result && typeof result.message === 'string'
              ? result.message
              : null) ?? 'Push delivery failed.',
          remove: result.shouldRemove,
        },
      )
      app.log.warn(
        {
          endpoint: subscription.subscription.endpoint,
          statusCode: result.statusCode,
          sessionId: payload.sessionId,
          shouldRemove: result.shouldRemove,
        },
        'Unable to deliver Panda Web Push notification.',
      )
    }),
  )
}

const deliverWebPushToStoredSubscription = async (
  endpoint: string,
  notificationPayload: {
    title: string
    body: string
    url: string
    tag: string
    sessionId?: string | null
  },
) => {
  if (!hubPushSubscriptionStore || !hubWebPushNotifier?.publicConfig.supported) {
    return { ok: false as const, error: 'Web Push is unavailable on hub.' }
  }

  const storedSubscription = hubPushSubscriptionStore.get(endpoint)
  if (!storedSubscription) {
    return { ok: false as const, error: 'Web Push subscription not found.' }
  }

  const result = await hubWebPushNotifier.sendNotification(
    storedSubscription.subscription,
    notificationPayload,
  )

  if (result.ok) {
    hubPushSubscriptionStore.markDeliveryResult(endpoint, { success: true })
    return { ok: true as const, deliveredAt: isoNow() }
  }

  hubPushSubscriptionStore.markDeliveryResult(endpoint, {
    success: false,
    failureReason:
      ('message' in result && typeof result.message === 'string'
        ? result.message
        : null) ?? 'Push delivery failed.',
    remove: result.shouldRemove,
  })

  app.log.warn(
    {
      endpoint,
      statusCode: result.statusCode,
      shouldRemove: result.shouldRemove,
    },
    'Unable to deliver Panda Web Push notification.',
  )

  return {
    ok: false as const,
    error:
      ('message' in result && typeof result.message === 'string'
        ? result.message
        : null) ?? 'Push delivery failed.',
  }
}

const readChangeSetsForSession = async (sessionId: string) => {
  const existing = sessionChangeSets.get(sessionId)
  if (existing) {
    return existing
  }

  const hydrated = await liveSessionStream.hydrateSession(
    sessionId,
    discoveredSessionFiles[sessionId],
  )

  if (hydrated?.changeSets) {
    sessionChangeSets.set(sessionId, hydrated.changeSets)
    return hydrated.changeSets
  }

  return []
}

const readChangeSetForSession = async (sessionId: string, changeSetId: string) => {
  const changeSets = await readChangeSetsForSession(sessionId)
  return changeSets.find((entry) => entry.id === changeSetId) ?? null
}

const readChangeSetForTurn = async (sessionId: string, turnId: string) => {
  const changeSets = await readChangeSetsForSession(sessionId)
  return changeSets.find((entry) => entry.turn_id === turnId) ?? null
}

const readPlanForSession = async (sessionId: string) => {
  const existing = sessionPlans.get(sessionId)
  if (existing !== undefined) {
    return existing
  }

  const hydrated = await liveSessionStream.hydrateSession(
    sessionId,
    discoveredSessionFiles[sessionId],
  )

  if (hydrated) {
    sessionPlans.set(sessionId, hydrated.planSnapshot)
    return hydrated.planSnapshot
  }

  return null
}

const readInteractionsForSession = async (sessionId: string) => {
  const existing = sessionInteractions.get(sessionId)
  if (existing) {
    return existing
  }

  const hydrated = await liveSessionStream.hydrateSession(
    sessionId,
    discoveredSessionFiles[sessionId],
  )

  if (hydrated) {
    sessionInteractions.set(sessionId, hydrated.interactionRequests)
    return hydrated.interactionRequests
  }

  return [] as SessionInteractionRequest[]
}

const readChangeSetFileDiffForSession = async (
  sessionId: string,
  input: {
    changeSetId: string
    path: string
    itemId?: string | null
  },
): Promise<SessionChangeSetFileDiff | null> => {
  const changeSet = await readChangeSetForSession(sessionId, input.changeSetId)
  if (!changeSet) {
    return null
  }

  const match = changeSet.files.find((file) =>
    file.path === input.path &&
    (input.itemId !== undefined ? file.item_id === (input.itemId ?? null) : true),
  )
  if (!match) {
    return null
  }

  return {
    session_id: sessionId,
    change_set_id: changeSet.id,
    file: match,
    empty_message: '此变更没有可展示的补丁内容',
  }
}

const upsertSessionInteractions = (
  sessionId: string,
  incoming: SessionInteractionRequest[],
) => {
  if (incoming.length === 0) {
    return
  }

  const byId = new Map(
    (sessionInteractions.get(sessionId) ?? []).map((request) => [request.id, request]),
  )
  for (const request of incoming) {
    byId.set(request.id, request)
  }

  sessionInteractions.set(
    sessionId,
    [...byId.values()].sort(
      (left, right) => +new Date(right.updated_at) - +new Date(left.updated_at),
    ),
  )
}

const resolveSessionInteractions = (
  sessionId: string,
  requestIds: string[],
) => {
  if (requestIds.length === 0) {
    return
  }

  const current = sessionInteractions.get(sessionId) ?? []
  if (current.length === 0) {
    return
  }

  const targets = new Set(requestIds)
  sessionInteractions.set(
    sessionId,
    current.filter((request) => !targets.has(request.id)),
  )
}

const setManagedSessionActive = (sessionId: string) => {
  activeSessionId = sessionId
  managedSessions.forEach((session, id) => {
    managedSessions.set(id, {
      ...session,
      health: id === sessionId ? 'active' : 'idle',
    })
  })
}

const upsertSessionChangeSets = (sessionId: string, incoming: ChangeSet[]) => {
  if (incoming.length === 0) {
    return
  }

  const next = [...(sessionChangeSets.get(sessionId) ?? [])]
  const byId = new Map(next.map((changeSet) => [changeSet.id, changeSet]))
  for (const changeSet of incoming) {
    byId.set(changeSet.id, changeSet)
  }

  const normalized = [...byId.values()].sort((a, b) => +new Date(a.started_at) - +new Date(b.started_at))
  sessionChangeSets.set(sessionId, normalized)
}

const applySessionPatch = (
  sessionId: string,
  patch: {
    title?: string
    run_state?: 'idle' | 'running' | 'completed'
    run_state_changed_at?: string | null
    summary?: string
    latest_assistant_message?: string | null
    last_event_at?: string
    context_usage?: SessionContextUsage | null
  },
) => {
  let didUpdate = false
  snapshot.sessions = snapshot.sessions.map((session) => {
    if (session.id !== sessionId) {
      return session
    }

    const nextLastEventAt =
      typeof patch.last_event_at === 'string' && patch.last_event_at.trim()
        ? patch.last_event_at
        : undefined
    const currentLastEventAt = new Date(session.last_event_at).getTime()
    const incomingLastEventAt = nextLastEventAt
      ? new Date(nextLastEventAt).getTime()
      : Number.NaN
    const shouldUpdateLastEventAt =
      nextLastEventAt !== undefined &&
      Number.isFinite(incomingLastEventAt) &&
      (!Number.isFinite(currentLastEventAt) || incomingLastEventAt > currentLastEventAt)

    didUpdate = true
    return {
      ...session,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.run_state ? { run_state: patch.run_state } : {}),
      ...(patch.run_state_changed_at !== undefined
        ? { run_state_changed_at: patch.run_state_changed_at }
        : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.latest_assistant_message !== undefined
        ? { latest_assistant_message: patch.latest_assistant_message }
        : {}),
      ...(shouldUpdateLastEventAt ? { last_event_at: nextLastEventAt } : {}),
      ...(patch.context_usage !== undefined ? { context_usage: patch.context_usage } : {}),
    }
  })

  if (didUpdate) {
    refreshSnapshotDerivedState()
  }

  return didUpdate
}

const applyLiveTrackerPatch = (session: SessionRef): SessionRef => {
  const livePatch = liveSessionStream.peekSessionPatch(session.id)
  if (!livePatch) {
    return session
  }

  const nextLastEventAt =
    typeof livePatch.last_event_at === 'string' && livePatch.last_event_at.trim()
      ? livePatch.last_event_at
      : null
  const currentLastEventAt = new Date(session.last_event_at).getTime()
  const incomingLastEventAt = nextLastEventAt
    ? new Date(nextLastEventAt).getTime()
    : Number.NaN
  const shouldUseIncomingLastEventAt =
    nextLastEventAt !== null &&
    Number.isFinite(incomingLastEventAt) &&
    (!Number.isFinite(currentLastEventAt) || incomingLastEventAt > currentLastEventAt)

  return {
    ...session,
    ...(livePatch.run_state ? { run_state: livePatch.run_state } : {}),
    ...(livePatch.run_state_changed_at !== undefined
      ? { run_state_changed_at: livePatch.run_state_changed_at }
      : {}),
    ...(livePatch.summary !== undefined ? { summary: livePatch.summary } : {}),
    ...(livePatch.latest_assistant_message !== undefined
      ? { latest_assistant_message: livePatch.latest_assistant_message }
      : {}),
    ...(shouldUseIncomingLastEventAt ? { last_event_at: nextLastEventAt } : {}),
    ...(livePatch.context_usage !== undefined ? { context_usage: livePatch.context_usage } : {}),
  }
}

const sortSessionsByActivity = (sessions: SessionRef[]) =>
  [...sessions].sort((a, b) => +new Date(b.last_event_at) - +new Date(a.last_event_at))

const isWorkspaceVisibleSession = (
  session: SessionRef,
  selectedSessionId?: string | null,
) =>
  session.archived ||
  session.id === (selectedSessionId?.trim() ?? '') ||
  Date.now() - new Date(session.last_event_at).getTime() <= WORKSPACE_VISIBLE_SESSION_WINDOW_MS

const parseWorkspaceSessionPageLimit = (value: unknown) => {
  const parsed =
    typeof value === 'string' && value.trim()
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WORKSPACE_SESSION_PAGE_LIMIT
  }

  return Math.max(1, Math.min(MAX_WORKSPACE_SESSION_PAGE_LIMIT, parsed))
}

const parseWorkspaceSessionCursor = (value: unknown) => {
  const parsed =
    typeof value === 'string' && value.trim()
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0
  }

  return Math.max(0, parsed)
}

const buildWorkspaceProjectStats = (
  projects: ProjectRef[],
  sessions: SessionRef[],
  selectedSessionId?: string | null,
): WorkspaceProjectStats[] =>
  projects.map((project) => {
    const projectSessions = sessions.filter((session) => session.project_id === project.id)
    const visibleSessionCount = projectSessions.filter(
      (session) =>
        !session.archived && isWorkspaceVisibleSession(session, selectedSessionId),
    ).length
    const archivedSessionCount = projectSessions.filter((session) => session.archived).length
    const hiddenHistoryCount = projectSessions.filter(
      (session) =>
        !session.archived && !isWorkspaceVisibleSession(session, selectedSessionId),
    ).length

    return {
      project_id: project.id,
      visible_session_count: visibleSessionCount,
      archived_session_count: archivedSessionCount,
      hidden_history_count: hiddenHistoryCount,
    }
  })

const toWorkspaceProjectDirectory = (
  project: ProjectRef,
): WorkspaceProjectDirectory => ({
  id: project.id,
  agent_id: project.agent_id,
  name: project.name,
  display_name: project.display_name,
  pinned: project.pinned,
  path: project.path,
})

const toWorkspaceAgentSummary = (
  agent: AgentNode,
): WorkspaceAgentSummary => ({
  id: agent.id,
  name: agent.name,
  display_name: agent.display_name,
  status: agent.status,
})

const toWorkspaceSessionListItem = (
  session: SessionRef,
): WorkspaceSessionListItem => ({
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

const toWorkspaceSessionDetail = (
  session: SessionRef,
): WorkspaceSessionDetail => ({
  id: session.id,
  agent_id: session.agent_id,
  project_id: session.project_id,
  archived: session.archived,
  title: session.title,
  provider: session.provider,
  mode: session.mode,
  health: session.health,
  branch: session.branch,
  worktree: session.worktree,
  summary: session.summary,
  latest_assistant_message: session.latest_assistant_message,
  last_event_at: session.last_event_at,
  pinned: session.pinned,
  run_state: session.run_state,
  run_state_changed_at: session.run_state_changed_at,
  subagent: session.subagent,
  context_usage: session.context_usage,
  capability: session.capability,
})

const buildHubDirectorySnapshot = (): HubDirectorySnapshot => ({
  generated_at: snapshot.generated_at,
  agents: snapshot.agents,
})

const buildHubRecentSessionsSnapshot = (): HubRecentSessionsSnapshot => ({
  generated_at: snapshot.generated_at,
  recent_sessions: sortSessionsByActivity(snapshot.sessions)
    .slice(0, HUB_RECENT_SESSION_LIMIT)
    .map((session): HubRecentSession => ({
      id: session.id,
      title: session.title,
      run_state: session.run_state,
      run_state_changed_at: session.run_state_changed_at,
      latest_assistant_message: session.latest_assistant_message,
    })),
})

const buildWorkspaceDirectorySnapshot = (options?: {
  selectedSessionId?: string | null
}): WorkspaceDirectorySnapshot => {
  const selectedSessionId = options?.selectedSessionId?.trim() ?? ''
  const projects = snapshot.projects
    .filter((project) => project.agent_id === localAgentId)
    .sort((left, right) => {
      const pinnedDelta = Number(right.pinned) - Number(left.pinned)
      if (pinnedDelta !== 0) {
        return pinnedDelta
      }

      return left.name.localeCompare(right.name)
    })
  const projectIds = new Set(projects.map((project) => project.id))
  const agentSessions = sortSessionsByActivity(
    snapshot.sessions.filter(
      (session) =>
        session.agent_id === localAgentId && projectIds.has(session.project_id),
    ),
  )
  const sessions = agentSessions.filter(
    (session) =>
      !session.archived &&
      isWorkspaceVisibleSession(session, selectedSessionId),
  )
  const selectedHiddenSession =
    selectedSessionId
      ? agentSessions.find(
          (session) =>
            session.id === selectedSessionId &&
            !sessions.some((candidate) => candidate.id === session.id),
        ) ?? null
      : null
  const displayedSessions = selectedHiddenSession
    ? sortSessionsByActivity([selectedHiddenSession, ...sessions])
    : sessions

  return {
    generated_at: isoNow(),
    agent: (() => {
      const localAgent = snapshot.agents.find((agent) => agent.id === localAgentId) ?? null
      return localAgent ? toWorkspaceAgentSummary(localAgent) : null
    })(),
    projects: projects.map(toWorkspaceProjectDirectory),
    project_stats: buildWorkspaceProjectStats(projects, agentSessions, selectedSessionId),
    sessions: displayedSessions.map(toWorkspaceSessionListItem),
    active_session_id:
      (selectedSessionId && agentSessions.some((session) => session.id === selectedSessionId)
        ? selectedSessionId
        : '') ||
      agentSessions.find((session) => !session.archived)?.id ||
      agentSessions[0]?.id ||
      '',
  }
}

const readWorkspaceSessionPage = (input: {
  bucket: WorkspaceSessionBucket
  projectId?: string | null
  cursor?: unknown
  limit?: unknown
  selectedSessionId?: string | null
}): WorkspaceSessionPage => {
  const limit = parseWorkspaceSessionPageLimit(input.limit)
  const offset = parseWorkspaceSessionCursor(input.cursor)
  const selectedSessionId = input.selectedSessionId?.trim() ?? ''
  const projectId = input.projectId?.trim() ?? ''
  const filteredSessions = sortSessionsByActivity(
    snapshot.sessions.filter((session) => {
      if (session.agent_id !== localAgentId) {
        return false
      }

      if (projectId && session.project_id !== projectId) {
        return false
      }

      if (input.bucket === 'archived') {
        return session.archived
      }

      return (
        !session.archived &&
        !isWorkspaceVisibleSession(session, selectedSessionId) &&
        session.id !== selectedSessionId
      )
    }),
  )
  const pageSessions = filteredSessions.slice(offset, offset + limit)
  const nextOffset = offset + pageSessions.length

  return {
    bucket: input.bucket,
    project_id: projectId || null,
    sessions: pageSessions.map(toWorkspaceSessionListItem),
    next_cursor: nextOffset < filteredSessions.length ? String(nextOffset) : null,
    total_count: filteredSessions.length,
  }
}

const readWorkspaceSessionDetail = async (
  sessionId: string,
): Promise<WorkspaceSessionDetailResponse | null> => {
  const session = await findSnapshotSession(sessionId)
  if (!session) {
    return null
  }

  return {
    generated_at: isoNow(),
    session: toWorkspaceSessionDetail(session),
  }
}

const readSessionLocationForCurrentSnapshot = (
  sessionId: string,
): SessionLocation | null => {
  const session = snapshot.sessions.find((item) => item.id === sessionId) ?? null
  if (!session) {
    return null
  }

  const agent = snapshot.agents.find((item) => item.id === session.agent_id) ?? null
  if (!agent) {
    return null
  }

  return {
    session_id: session.id,
    agent_id: session.agent_id,
    project_id: session.project_id,
    direct_base_url: agent.direct_base_url,
    ws_base_url: agent.ws_base_url,
  }
}

const refreshSnapshotDerivedState = () => {
  const sessions = sortSessionsByActivity(snapshot.sessions)
  const resolvedActiveSessionId =
    (activeSessionId && sessions.some((session) => session.id === activeSessionId)
      ? activeSessionId
      : '') ||
    snapshot.active_session_id ||
    sessions[0]?.id ||
    ''

  activeSessionId = resolvedActiveSessionId

  if (mode === 'hub') {
    const nextProjectCounts = new Map<string, number>()
    const nextSessionCounts = new Map<string, number>()
    for (const project of snapshot.projects) {
      nextProjectCounts.set(
        project.agent_id,
        (nextProjectCounts.get(project.agent_id) ?? 0) + 1,
      )
    }
    for (const session of sessions) {
      nextSessionCounts.set(
        session.agent_id,
        (nextSessionCounts.get(session.agent_id) ?? 0) + 1,
      )
    }

    snapshot = {
      ...snapshot,
      generated_at: isoNow(),
      agents: snapshot.agents.map((agent) => ({
        ...agent,
        project_count: nextProjectCounts.get(agent.id) ?? 0,
        session_count: nextSessionCounts.get(agent.id) ?? 0,
      })),
      sessions,
      active_session_id: resolvedActiveSessionId,
    }
    return
  }

  snapshot = {
    ...snapshot,
    generated_at: isoNow(),
    agents: discoveredAgent
      ? [
          {
            ...discoveredAgent,
            project_count: snapshot.projects.length,
            session_count: sessions.length,
          },
        ]
      : [],
    sessions: sessions.map((session) => {
      if (session.id === resolvedActiveSessionId) {
        return {
          ...session,
          health: 'active' as const,
        }
      }

      if (managedSessions.has(session.id) && session.health === 'active') {
        return {
          ...session,
          health: 'idle' as const,
        }
      }

      return session
    }),
    active_session_id: resolvedActiveSessionId,
  }
}

const invalidateProjectSkillsCache = () => {
  projectSkillsCache.clear()
  projectSkillsCacheDirty = true
}

const readProjectSkills = async (
  project: ProjectRef,
  options?: { forceReload?: boolean },
) => {
  const cacheKey = normalizePathKey(project.path)
  const cached = projectSkillsCache.get(cacheKey)
  const now = Date.now()
  const shouldUseCache =
    !options?.forceReload &&
    !projectSkillsCacheDirty &&
    Boolean(cached) &&
    now - (cached?.fetchedAt ?? 0) < PROJECT_SKILLS_CACHE_TTL_MS

  if (shouldUseCache && cached) {
    return cached.skills
  }

  const shouldForceReload = options?.forceReload === true || projectSkillsCacheDirty
  projectSkillsCacheDirty = false

  try {
    const skills = (await liveSessionStream.listSkills({
      cwd: project.path,
      forceReload: shouldForceReload,
    })).filter((skill) => skill.enabled)
    projectSkillsCache.set(cacheKey, {
      skills,
      fetchedAt: now,
    })
    return skills
  } catch (error) {
    if (shouldForceReload) {
      projectSkillsCacheDirty = true
    }

    if (cached) {
      return cached.skills
    }

    throw error
  }
}

const cleanupExpiredCommandPanels = () => {
  const now = Date.now()
  for (const [panelId, panelState] of commandPanels.entries()) {
    if (panelState.expiresAt <= now) {
      commandPanels.delete(panelId)
    }
  }
}

const createCommandPanel = (input: {
  sessionId: string
  commandName: string
  commandText: string
  title: string
  description?: string | null
  status: CodexCommandPanel['status']
  body: string
  inputType?: CodexCommandPanel['input_type']
  options?: CodexCommandPanel['options']
  inputPlaceholder?: string | null
  submitLabel?: string | null
  effect?: CodexCommandPanelEffect
  submittedAt?: string
}) => {
  const submittedAt = input.submittedAt ?? isoNow()
  return {
    panel_id: `command-panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    session_id: input.sessionId,
    command_name: input.commandName,
    command_text: input.commandText,
    title: input.title,
    description: input.description ?? null,
    status: input.status,
    body: input.body,
    submitted_at: submittedAt,
    updated_at: submittedAt,
    input_type: input.inputType ?? 'none',
    options: input.options ?? [],
    input_placeholder: input.inputPlaceholder ?? null,
    submit_label: input.submitLabel ?? null,
    effect: input.effect ?? null,
  } satisfies CodexCommandPanel
}

const storeCommandPanel = (
  panel: CodexCommandPanel,
  input: {
    mode: StoredCommandPanel['mode']
    projectPath: string
  },
) => {
  cleanupExpiredCommandPanels()
  commandPanels.set(panel.panel_id, {
    panel,
    mode: input.mode,
    projectPath: input.projectPath,
    expiresAt: Date.now() + COMMAND_PANEL_TTL_MS,
  })
  return panel
}

const readStoredCommandPanel = (
  sessionId: string,
  panelId: string,
) => {
  cleanupExpiredCommandPanels()
  const stored = commandPanels.get(panelId)
  if (!stored || stored.panel.session_id !== sessionId) {
    return null
  }

  return stored
}

const clearStoredCommandPanel = (panelId: string) => {
  commandPanels.delete(panelId)
}

const refreshCodexCommandCatalog = async () => {
  if (!codexCommandCatalogRefreshPromise) {
    codexCommandCatalogRefreshPromise = (async () => {
      const cliVersion = await detectCodexCliVersion()
      const catalog = codexCommandCatalogSchema.parse({
        cli_version: cliVersion,
        loaded_at: isoNow(),
        cache_ttl_ms: 0,
        commands: await loadCodexCommandCatalog(cliVersion),
      })

      await writeCachedCodexCommandCatalog(catalog)
      return catalog
    })().finally(() => {
      codexCommandCatalogRefreshPromise = null
    })
  }

  return codexCommandCatalogRefreshPromise
}

const readCodexCommandCatalog = async () => {
  const cachedCatalog = await readCachedCodexCommandCatalog()
  if (cachedCatalog) {
    return cachedCatalog
  }

  return refreshCodexCommandCatalog()
}

const toDisplayedCodexCommandCatalog = async (
  catalog: CodexCommandCatalog,
): Promise<CodexCommandCatalog> => {
  const visibleConfig = await readVisibleCodexCommandConfig()
  return {
    ...catalog,
    commands: filterCodexCommandsForDisplay(catalog.commands, visibleConfig),
  }
}

const renameSession = async (sessionId: string, nextName: string) => {
  if (managedSessions.has(sessionId)) {
    const managedSession = managedSessions.get(sessionId)!
    managedSessions.set(sessionId, {
      ...managedSession,
      title: nextName,
    })
  }

  await liveSessionStream.setThreadName(sessionId, nextName).catch(() => {
    // Fall back to the session index for discovery if the app-server cannot rename.
  })
  await appendSessionIndexUpdate(
    sessionId,
    {
      thread_name: nextName,
    },
    codexHome,
  )

  patchSnapshotSession(sessionId, { title: nextName })
  broadcastEvent('session.updated', {
    sessionId,
    sessionPatch: {
      title: nextName,
    },
  })
}

const generateSessionTitleInBackground = async (input: {
  sessionId: string
  project: ProjectRef
  fallbackTitle: string
  message: string
  attachments: SessionInputAttachment[]
  model: string | null
}) => {
  const prompt = buildSessionTitleGenerationPrompt({
    message: input.message,
    attachments: input.attachments,
  })

  try {
    const generated = await liveSessionStream.runOneShotPrompt({
      cwd: input.project.path,
      prompt,
      model: input.model,
      timeoutMs: SESSION_TITLE_GENERATION_TIMEOUT_MS,
    })
    const nextTitle = sanitizeGeneratedSessionTitle(generated)
    if (!nextTitle || nextTitle === input.fallbackTitle) {
      return
    }

    const currentSession = await findSnapshotSession(input.sessionId)
    if (!currentSession || currentSession.title !== input.fallbackTitle) {
      return
    }

    await renameSession(input.sessionId, nextTitle)
  } catch (error) {
    diagnosticLogger.warn({
      sessionId: input.sessionId,
      projectId: input.project.id,
      projectPath: input.project.path,
      model: input.model,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Failed to generate background session title.')
  }
}

const executeSessionCommand = async (
  session: SessionRef,
  project: ProjectRef,
  rawInput: string,
) => {
  const parsed = parseSlashCommandInput(rawInput)
  if (!parsed) {
    return createCommandPanel({
      sessionId: session.id,
      commandName: 'unknown',
      commandText: rawInput,
      title: '无法识别命令',
      status: 'failed',
      body: '只有以 / 开头的首个词会被识别为命令。',
    })
  }

  const catalog = await readCodexCommandCatalog()
  const command = catalog.commands.find((item) => item.name === parsed.name)
  if (!command) {
    return createCommandPanel({
      sessionId: session.id,
      commandName: parsed.name,
      commandText: parsed.raw,
      title: `未识别 /${parsed.name}`,
      status: 'failed',
      body: 'Panda 还没有识别到这个 Codex 命令。',
    })
  }

  if (command.availability === 'unsupported') {
    return createCommandPanel({
      sessionId: session.id,
      commandName: command.name,
      commandText: parsed.raw,
      title: `/${command.name} 暂未接入`,
      description: command.description,
      status: 'completed',
      body: '命令目录已经接入，但这个命令的执行流还没有在 Panda 中实现。',
    })
  }

  if (command.name === 'status') {
    const config = await liveSessionStream.readConfig({ cwd: project.path })
    const usage = session.context_usage
    return createCommandPanel({
      sessionId: session.id,
      commandName: command.name,
      commandText: parsed.raw,
      title: '当前会话状态',
      description: command.description,
      status: 'completed',
      body: [
        `会话：${session.title}`,
        `运行状态：${session.run_state === 'running' ? '运行中' : session.run_state === 'completed' ? '已完成' : '空闲'}`,
        `模型：${config.model ?? '未设置'}`,
        `推理强度：${config.reasoningEffort ?? '默认'}`,
        `确认策略：${config.approvalPolicy ?? '默认'}`,
        `沙箱模式：${config.sandboxMode ?? '默认'}`,
        usage
          ? `上下文窗口：${usage.used_tokens}/${usage.total_tokens}（${usage.percent_used.toFixed(1)}%）`
          : '上下文窗口：暂无数据',
      ].join('\n'),
    })
  }

  if (command.name === 'skills') {
    const skills = await readProjectSkills(project)
    return createCommandPanel({
      sessionId: session.id,
      commandName: command.name,
      commandText: parsed.raw,
      title: `技能列表 (${skills.length})`,
      description: command.description,
      status: 'completed',
      body:
        skills.length > 0
          ? skills
              .map((skill) => `$${skill.name}  ${skill.description}`.trim())
              .join('\n')
          : '当前项目没有可用技能。',
    })
  }

  if (command.name === 'mcp') {
    const servers = await liveSessionStream.listMcpServers()
    return createCommandPanel({
      sessionId: session.id,
      commandName: command.name,
      commandText: parsed.raw,
      title: `MCP 服务 (${servers.length})`,
      description: command.description,
      status: 'completed',
      body:
        servers.length > 0
          ? servers
              .map((server) =>
                [
                  server.name,
                  `${server.toolCount} tools`,
                  `${server.resourceCount} resources`,
                  server.authStatus ? `auth: ${server.authStatus}` : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
              )
              .join('\n')
          : '当前没有可用的 MCP 服务。',
    })
  }

  if (command.name === 'compact') {
    await liveSessionStream.compactThread(session.id)
    return createCommandPanel({
      sessionId: session.id,
      commandName: command.name,
      commandText: parsed.raw,
      title: '已提交上下文压缩',
      description: command.description,
      status: 'completed',
      body: '压缩请求已经提交给 Codex，后续结果会继续体现在当前会话里。',
    })
  }

  if (command.name === 'rename') {
    if (parsed.args) {
      await renameSession(session.id, parsed.args)
      return createCommandPanel({
        sessionId: session.id,
        commandName: command.name,
        commandText: parsed.raw,
        title: '会话已重命名',
        description: command.description,
        status: 'completed',
        body: `当前会话已重命名为 “${parsed.args}”。`,
      })
    }

    const panel = createCommandPanel({
      sessionId: session.id,
      commandName: command.name,
      commandText: parsed.raw,
      title: '重命名当前会话',
      description: command.description,
      status: 'awaiting_input',
      body: '输入新的会话名称，然后在这个面板里直接提交。',
      inputType: 'text',
      inputPlaceholder: '输入新的会话名称',
      submitLabel: '重命名',
    })
    return storeCommandPanel(panel, {
      mode: 'rename',
      projectPath: project.path,
    })
  }

  if (command.name === 'model') {
    const models = await liveSessionStream.listModels()
    const panel = createCommandPanel({
      sessionId: session.id,
      commandName: command.name,
      commandText: parsed.raw,
      title: '选择模型',
      description: '选择后会更新 Panda 当前会话后续发送时使用的模型。',
      status: 'awaiting_input',
      body:
        models.length > 0
          ? '继续在列表里选择一个模型，面板会直接更新结果。'
          : '当前没有可用模型。',
      inputType: models.length > 0 ? 'choice' : 'none',
      options: models.map((model) => ({
        id: model.id,
        label: model.label,
        description: model.description || null,
      })),
    })

    return models.length > 0
      ? storeCommandPanel(panel, {
          mode: 'model',
          projectPath: project.path,
        })
      : panel
  }

  return createCommandPanel({
    sessionId: session.id,
    commandName: command.name,
    commandText: parsed.raw,
    title: `/${command.name} 已识别`,
    description: command.description,
    status: 'completed',
    body: '命令目录已经接入，但这个命令的执行流还没有在 Panda 中实现。',
  })
}

const respondToSessionCommand = async (input: {
  sessionId: string
  panelId: string
  optionId?: string | null
  text?: string | null
}) => {
  const stored = readStoredCommandPanel(input.sessionId, input.panelId)
  if (!stored) {
    throw new Error('命令面板已失效，请重新执行该命令。')
  }

  if (stored.mode === 'rename') {
    const nextName = input.text?.trim() ?? ''
    if (!nextName) {
      throw new Error('请输入新的会话名称。')
    }

    await renameSession(input.sessionId, nextName)
    clearStoredCommandPanel(input.panelId)
    return {
      ...stored.panel,
      status: 'completed',
      body: `当前会话已重命名为 “${nextName}”。`,
      updated_at: isoNow(),
      input_type: 'none',
      input_placeholder: null,
      submit_label: null,
    } satisfies CodexCommandPanel
  }

  if (stored.mode === 'model') {
    const selectedModelId = input.optionId?.trim() ?? ''
    if (!selectedModelId) {
      throw new Error('请选择一个模型。')
    }

    const models = await liveSessionStream.listModels()
    const selectedModel = models.find((model) => model.id === selectedModelId)
    if (!selectedModel) {
      throw new Error('所选模型已失效，请重新打开 /model。')
    }

    clearStoredCommandPanel(input.panelId)
    return {
      ...stored.panel,
      status: 'completed',
      body: [
        `后续消息将优先使用 ${selectedModel.label}。`,
        selectedModel.defaultReasoningEffort
          ? `默认推理强度：${selectedModel.defaultReasoningEffort}`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
      updated_at: isoNow(),
      input_type: 'none',
      options: [],
      effect: {
        type: 'set_session_model',
        model: selectedModel.id,
        reasoning_effort: selectedModel.defaultReasoningEffort,
      },
    } satisfies CodexCommandPanel
  }

  clearStoredCommandPanel(input.panelId)
  return {
    ...stored.panel,
    status: 'failed',
    body: '这个命令面板不接受后续输入。',
    updated_at: isoNow(),
    input_type: 'none',
    options: [],
  } satisfies CodexCommandPanel
}

const upsertSnapshotProject = (project: ProjectRef) => {
  const nextProjects = snapshot.projects.filter((item) => item.id !== project.id)
  nextProjects.push(project)
  snapshot = {
    ...snapshot,
    projects: nextProjects,
  }
  refreshSnapshotDerivedState()
}

const upsertSnapshotSession = (session: SessionRef) => {
  const nextSessions = snapshot.sessions.filter((item) => item.id !== session.id)
  nextSessions.push(session)
  snapshot = {
    ...snapshot,
    sessions: nextSessions,
  }
  refreshSnapshotDerivedState()
}

const patchSnapshotSession = (
  sessionId: string,
  patch: Partial<SessionRef>,
) => {
  const existing = snapshot.sessions.find((session) => session.id === sessionId)
  if (!existing) {
    return false
  }

  upsertSnapshotSession({
    ...existing,
    ...patch,
  })
  return true
}

const removeSnapshotSessions = (sessionIds: string[]) => {
  if (sessionIds.length === 0) {
    return
  }

  const targets = new Set(sessionIds)
  snapshot = {
    ...snapshot,
    sessions: snapshot.sessions.filter((session) => !targets.has(session.id)),
  }
  refreshSnapshotDerivedState()
}

const patchSnapshotProject = (
  projectId: string,
  patch: Partial<ProjectRef>,
) => {
  if (!snapshot.projects.some((project) => project.id === projectId)) {
    return false
  }

  snapshot = {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            ...patch,
          }
        : project,
    ),
  }
  refreshSnapshotDerivedState()
  return true
}

const reorderSnapshotProjects = (orderedProjectIds: string[]) => {
  if (orderedProjectIds.length === 0 || snapshot.projects.length <= 1) {
    return false
  }

  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]))
  const seen = new Set<string>()
  const nextProjects: ProjectRef[] = []

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

  if (
    nextProjects.length !== snapshot.projects.length ||
    nextProjects.every((project, index) => project.id === snapshot.projects[index]?.id)
  ) {
    return false
  }

  snapshot = {
    ...snapshot,
    projects: nextProjects,
  }
  refreshSnapshotDerivedState()
  return true
}

const removeSnapshotProject = (projectId: string) => {
  snapshot = {
    ...snapshot,
    projects: snapshot.projects.filter((project) => project.id !== projectId),
    sessions: snapshot.sessions.filter((session) => session.project_id !== projectId),
  }
  refreshSnapshotDerivedState()
}

const broadcastSnapshotChanged = (reason: string = 'topology') => {
  broadcastEvent('snapshot.changed', {
    generated_at: snapshot.generated_at,
    reason,
  })
}

const buildSnapshot = async (options?: { force?: boolean }) => {
  if (!options?.force) {
    const hasSnapshotData = snapshot.projects.length > 0 || snapshot.sessions.length > 0
    if (hasSnapshotData && Date.now() - lastSnapshotRefreshAt < SNAPSHOT_REFRESH_TTL_MS) {
      return snapshot
    }
  }

  if (snapshotRefreshPromise) {
    return snapshotRefreshPromise
  }

  snapshotRefreshPromise = (async () => {
    if (mode === 'hub' && hubAgentRegistry) {
      snapshot = hubAgentRegistry.buildSnapshot()
      activeSessionId = snapshot.active_session_id
      lastSnapshotRefreshAt = Date.now()
      return snapshot
    }

    const { discoverLocalCodexData } = await import('./index')
    const discovery = await discoverLocalCodexData({
      agentId: localAgentId,
      agentName: localAgentName,
      codexHome,
      tailscaleIp,
      tailscaleDnsName,
      directBaseUrl,
      wsBaseUrl,
      version,
      transport,
    })

    discoveredAgent = discovery.agent
    discoveredSessionFiles = discovery.sessionFiles

    const mergedProjects = new Map<string, ProjectRef>()
    for (const project of discovery.projects) {
      mergedProjects.set(project.id, project)
    }

    for (const project of customProjects.values()) {
      const exists = [...mergedProjects.values()].some(
        (item) =>
          normalizePathKey(item.path) === normalizePathKey(project.path),
      )
      if (!exists) {
        mergedProjects.set(project.id, project)
      }
    }

    const mergedSessions = new Map<string, SessionRef>()
    for (const session of discovery.sessions) {
      mergedSessions.set(session.id, applyLiveTrackerPatch(session))
    }

    for (const session of managedSessions.values()) {
      mergedSessions.set(session.id, applyLiveTrackerPatch(session as SessionRef))
    }

    const threadPrefs = await readPandaThreadPrefs(codexHome)
    const orderedProjects = sortByStoredWorkspaceOrder(
      [...mergedProjects.values()],
      getOrderedWorkspaceRoots(threadPrefs),
    )

    snapshot = {
      generated_at: isoNow(),
      agents: [],
      projects: orderedProjects,
      sessions: [...mergedSessions.values()],
      active_session_id:
        discovery.activeSessionId ||
        snapshot.active_session_id,
      timeline: [],
      changed_files: [],
      runtime_processes: [],
      previews: [],
      approvals: [],
    }
    refreshSnapshotDerivedState()
    lastSnapshotRefreshAt = Date.now()
    return snapshot
  })()

  try {
    return await snapshotRefreshPromise
  } finally {
    snapshotRefreshPromise = null
    if (snapshotBackgroundRefreshQueued && !snapshotBackgroundRefreshTimer) {
      refreshSnapshotInBackground()
    }
  }
}

const ensureSnapshotLoaded = async () => {
  if (snapshot.projects.length > 0 || snapshot.sessions.length > 0) {
    return snapshot
  }

  return buildSnapshot({ force: true })
}

const findSnapshotSession = async (sessionId: string) => {
  return (
    snapshot.sessions.find((session) => session.id === sessionId) ??
    (await buildSnapshot({ force: true })).sessions.find((session) => session.id === sessionId) ??
    null
  )
}

const findSnapshotProject = async (projectId: string) => {
  return (
    snapshot.projects.find((project) => project.id === projectId) ??
    (await buildSnapshot({ force: true })).projects.find((project) => project.id === projectId) ??
    null
  )
}

const readProjectForSession = async (session: SessionRef) =>
  findSnapshotProject(session.project_id)

const readSessionFilePreviewTree = async (
  session: SessionRef,
  project: ProjectRef,
  requestedPath: string | null | undefined,
): Promise<SessionFilePreviewTreeResponse> => {
  const resolved = await resolveSessionFilePreviewPath(project.path, requestedPath)
  const stat = await fs.stat(resolved.realPath).catch((error) => {
    if (isMissingPathError(error)) {
      throw new Error('File not found.')
    }
    throw error
  })

  if (!stat.isDirectory()) {
    throw new Error('目标路径不是目录。')
  }

  const entries = await fs.readdir(resolved.realPath, {
    withFileTypes: true,
  })
  const nodes = (
    await Promise.all(
      entries.map((entry) =>
        buildSessionFilePreviewTreeNode(
          project.path,
          resolved.normalizedPath,
          resolved.realPath,
          entry,
        ),
      ),
    )
  )
    .filter((entry): entry is SessionFilePreviewTreeNode => Boolean(entry))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1
      }
      return left.name.localeCompare(right.name, 'zh-CN')
    })

  return {
    session_id: session.id,
    project_id: project.id,
    root_path: SESSION_FILE_PREVIEW_ROOT_PATH,
    parent_path: resolved.normalizedPath || null,
    nodes,
    loaded_at: isoNow(),
  }
}

const readSessionFilePreviewContent = async (
  session: SessionRef,
  project: ProjectRef,
  requestedPath: string,
): Promise<SessionFilePreviewContentResponse> => {
  const resolved = await resolveSessionFilePreviewPath(project.path, requestedPath)
  const stat = await fs.stat(resolved.realPath).catch((error) => {
    if (isMissingPathError(error)) {
      throw new Error('File not found.')
    }
    throw error
  })

  if (!stat.isFile()) {
    throw new Error('目标路径不是文件。')
  }

  const fileName = path.basename(resolved.normalizedPath || resolved.realPath)
  const extension = normalizeSessionFilePreviewExtension(fileName)
  let fileKind =
    detectSessionFilePreviewKind(fileName, extension) ?? null
  let previewBuffer: Buffer | null = null

  if (!fileKind || fileKind === 'binary') {
    previewBuffer = await readPreviewBuffer(
      resolved.realPath,
      Math.min(SESSION_FILE_PREVIEW_TEXT_BYTE_LIMIT, Math.max(1024, stat.size)),
    )
    fileKind = looksLikeTextBuffer(previewBuffer) ? 'text' : 'binary'
  }

  if (fileKind === 'image') {
    if (stat.size > SESSION_FILE_PREVIEW_IMAGE_BYTE_LIMIT) {
      return {
        session_id: session.id,
        project_id: project.id,
        path: resolved.normalizedPath,
        name: fileName,
        extension,
        file_kind: fileKind,
        mime_type: getSessionFilePreviewMimeType(extension, fileKind),
        size_bytes: stat.size,
        encoding: null,
        is_truncated: true,
        content_text: null,
        content_base64: null,
        loaded_at: isoNow(),
      }
    }

    const buffer = await fs.readFile(resolved.realPath)
    return {
      session_id: session.id,
      project_id: project.id,
      path: resolved.normalizedPath,
      name: fileName,
      extension,
      file_kind: fileKind,
      mime_type: getSessionFilePreviewMimeType(extension, fileKind),
      size_bytes: stat.size,
      encoding: 'base64',
      is_truncated: false,
      content_text: null,
      content_base64: buffer.toString('base64'),
      loaded_at: isoNow(),
    }
  }

  if (fileKind === 'binary') {
    return {
      session_id: session.id,
      project_id: project.id,
      path: resolved.normalizedPath,
      name: fileName,
      extension,
      file_kind: fileKind,
      mime_type: getSessionFilePreviewMimeType(extension, fileKind),
      size_bytes: stat.size,
      encoding: null,
      is_truncated: false,
      content_text: null,
      content_base64: null,
      loaded_at: isoNow(),
    }
  }

  const buffer =
    previewBuffer ??
    await readPreviewBuffer(resolved.realPath, SESSION_FILE_PREVIEW_TEXT_BYTE_LIMIT)

  return {
    session_id: session.id,
    project_id: project.id,
    path: resolved.normalizedPath,
    name: fileName,
    extension,
    file_kind: fileKind,
    mime_type: getSessionFilePreviewMimeType(extension, fileKind),
    size_bytes: stat.size,
    encoding: 'utf8',
    is_truncated: stat.size > SESSION_FILE_PREVIEW_TEXT_BYTE_LIMIT,
    content_text: buffer.toString('utf8'),
    content_base64: null,
    loaded_at: isoNow(),
  }
}

const validateHubControlPlaneAuth = (request: FastifyRequest) => {
  const expectedApiKey = process.env.PANDA_HUB_API_KEY?.trim() ?? ''
  if (!expectedApiKey) {
    return true
  }

  const providedApiKey = readHeaderValue(request.headers['x-panda-hub-api-key'])
  return providedApiKey === expectedApiKey
}

const ensureGitActionPath = (projectPath: string, targetPath: string | null | undefined) => {
  const nextPath = normalizeGitWorkspacePath(targetPath?.trim() ?? '')
  if (!nextPath) {
    throw new Error('缺少目标文件路径。')
  }
  if (!isPathInsideProject(projectPath, nextPath)) {
    throw new Error('目标文件不在当前工作区中。')
  }
  return nextPath
}

const discardGitWorkspaceFile = async (
  projectPath: string,
  file: SessionGitWorkspaceFile,
) => {
  const targetPaths = [file.path, file.previous_path]
    .filter((value): value is string => Boolean(value))
    .map((value) => ensureGitActionPath(projectPath, value))

  if (file.status === 'untracked' || file.status === 'added') {
    await runGitCommand(projectPath, ['reset', '--quiet', 'HEAD', '--', file.path], {
      allowNonZeroExitCodes: [1, 128],
    })
    await runGitCommand(projectPath, ['clean', '-f', '--', file.path], {
      allowNonZeroExitCodes: [1],
    })
    return
  }

  await runGitCommand(projectPath, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...targetPaths])
}

const normalizeRollbackPatchText = (input: string) => {
  const normalized = input.replace(/\r\n/g, '\n').trim()
  return normalized ? `${normalized}\n` : ''
}

const buildRollbackPatchText = (changeSet: ChangeSet) => {
  if (changeSet.aggregated_diff.trim()) {
    return normalizeRollbackPatchText(changeSet.aggregated_diff)
  }

  if (changeSet.files.some((file) => file.diff.trim().length === 0)) {
    return ''
  }

  return normalizeRollbackPatchText(
    changeSet.files
      .map((file) => file.diff)
      .filter((diff) => diff.trim().length > 0)
      .join('\n\n'),
  )
}

const ensureChangeSetPathsAreInProject = (projectPath: string, changeSet: ChangeSet) => {
  for (const file of changeSet.files) {
    const candidates = [file.path, file.move_path].filter((value): value is string => Boolean(value?.trim()))
    for (const candidate of candidates) {
      if (!isPathInsideProject(projectPath, candidate)) {
        throw new Error('这轮改动包含超出当前工作区的路径，无法安全回滚。')
      }
    }
  }
}

const rollbackSessionChangeSet = async (projectPath: string, changeSet: ChangeSet) => {
  if (changeSet.status !== 'completed') {
    throw new Error('当前这轮改动尚未完成，暂时不能回滚。')
  }

  if (changeSet.files.length === 0) {
    throw new Error('这轮对话没有可回滚的文件改动。')
  }

  ensureChangeSetPathsAreInProject(projectPath, changeSet)

  const patchText = buildRollbackPatchText(changeSet)
  if (!patchText) {
    throw new Error('这轮改动缺少可逆补丁，暂时无法回滚。')
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-change-set-rollback-'))
  const patchFilePath = path.join(tempDir, 'rollback.patch')
  await fs.writeFile(patchFilePath, patchText, 'utf8')

  try {
    const patchArgs = ['apply', '--reverse', '--whitespace=nowarn', '--binary', patchFilePath]
    await runGitCommand(projectPath, [...patchArgs.slice(0, 1), '--check', ...patchArgs.slice(1)])
    await runGitCommand(projectPath, patchArgs)
  } catch (error) {
    const reason =
      error instanceof Error && error.message.trim()
        ? error.message
        : 'Git 无法反向应用这轮改动的补丁。'
    throw new Error(`无法安全回滚这轮改动：${reason}`)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const discardAllGitWorkspaceChanges = async (projectPath: string) => {
  await runGitCommand(projectPath, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'])
  await runGitCommand(projectPath, ['clean', '-fd', '--', '.'], {
    allowNonZeroExitCodes: [1],
  })
}

const commitAllGitWorkspaceChanges = async (projectPath: string, message: string) => {
  const nextMessage = message.trim()
  if (!nextMessage) {
    throw new Error('请输入提交信息。')
  }

  await runGitCommand(projectPath, ['add', '-A'])
  await runGitCommand(projectPath, ['commit', '-m', nextMessage])
}

const switchGitWorkspaceBranch = async (projectPath: string, branch: string) => {
  const nextBranch = branch.trim()
  if (!nextBranch) {
    throw new Error('请选择要切换的分支。')
  }

  await runGitCommand(projectPath, ['switch', nextBranch])
}

const pushGitWorkspaceBranch = async (projectPath: string) => {
  await runGitCommand(projectPath, ['push'])
}

const refreshSnapshotInBackground = () => {
  snapshotBackgroundRefreshQueued = true
  if (snapshotBackgroundRefreshTimer) {
    return
  }

  snapshotBackgroundRefreshTimer = setTimeout(() => {
    snapshotBackgroundRefreshTimer = null
    if (snapshotRefreshPromise) {
      return
    }

    snapshotBackgroundRefreshQueued = false
    void buildSnapshot({ force: true }).then(() => {
      broadcastSnapshotChanged('discovery')
    }).catch(() => {
      // Discovery refresh is best-effort; live events still carry session-local state.
    }).finally(() => {
      if (snapshotBackgroundRefreshQueued) {
        refreshSnapshotInBackground()
      }
    })
  }, SNAPSHOT_BACKGROUND_REFRESH_DEBOUNCE_MS)
}

const listDriveRoots = async () => {
  if (process.platform !== 'win32') {
    return [os.homedir()]
  }

  const candidates = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`)
  const checks = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const stat = await fs.stat(candidate)
        return stat.isDirectory() ? candidate : null
      } catch {
        return null
      }
    }),
  )

  return checks.filter((item): item is string => Boolean(item))
}

const WINDOWS_RESERVED_DIRECTORY_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

const validateDirectoryName = (value: string) => {
  const name = value.trim()
  if (!name) {
    return 'Directory name is required.'
  }

  if (name === '.' || name === '..') {
    return 'Directory name is invalid.'
  }

  if (/[\\/]/.test(name)) {
    return 'Directory name cannot include path separators.'
  }

  if (/[\u0000-\u001F]/.test(name)) {
    return 'Directory name contains invalid characters.'
  }

  if (process.platform === 'win32') {
    if (/[<>:"|?*]/.test(name)) {
      return 'Directory name contains invalid characters.'
    }

    if (/[. ]$/.test(name)) {
      return 'Directory name cannot end with a period or space.'
    }

    const reservedToken = name.split('.')[0]?.toLowerCase() ?? ''
    if (WINDOWS_RESERVED_DIRECTORY_NAMES.has(reservedToken)) {
      return 'Directory name is reserved.'
    }
  }

  return null
}

const toDirectoryNode = async (targetPath: string): Promise<DirectoryNode | null> => {
  try {
    const stat = await fs.stat(targetPath)
    if (!stat.isDirectory()) {
      return null
    }

    const entries = await fs.readdir(targetPath, { withFileTypes: true })
    const hasChildren = entries.some((entry) => entry.isDirectory())

    return {
      path: targetPath,
      name: basenameFromPath(targetPath),
      has_children: hasChildren,
    }
  } catch {
    return null
  }
}

const listDirectories = async (targetPath?: string | null) => {
  const roots = !targetPath
    ? await listDriveRoots()
    : (await fs.readdir(targetPath, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(targetPath, entry.name))

  const nodes = await Promise.all(
    roots
      .sort((a, b) => a.localeCompare(b))
      .map(async (directoryPath) => toDirectoryNode(directoryPath)),
  )

  return nodes.filter((node): node is DirectoryNode => Boolean(node))
}

const createDirectory = async (input: {
  parentPath: string
  name: string
}): Promise<DirectoryNode> => {
  const parentPath = input.parentPath.trim()
  const validationError = validateDirectoryName(input.name)
  if (validationError) {
    throw new Error(validationError)
  }

  if (!parentPath) {
    throw new Error('Parent directory path is required.')
  }

  const resolvedParentPath = path.resolve(parentPath)
  const parentStat = await fs.stat(resolvedParentPath).catch(() => null)
  if (!parentStat?.isDirectory()) {
    throw new Error('Parent directory does not exist.')
  }

  const directoryName = input.name.trim()
  const targetPath = path.join(resolvedParentPath, directoryName)

  try {
    await fs.mkdir(targetPath)
  } catch (error) {
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code ?? '')
        : ''

    if (errorCode === 'EEXIST') {
      throw new Error('Directory already exists.')
    }

    throw error
  }

  return (
    (await toDirectoryNode(targetPath)) ?? {
      path: targetPath,
      name: basenameFromPath(targetPath),
      has_children: false,
    }
  )
}

const removeCustomProjectByPath = (targetPath: string) => {
  for (const [projectId, project] of customProjects) {
    if (normalizePathKey(project.path) === normalizePathKey(targetPath)) {
      customProjects.delete(projectId)
    }
  }
}

const removeManagedSessionsByProjectId = (projectId: string) => {
  for (const [sessionId, session] of managedSessions) {
    if (session.project_id !== projectId) {
      continue
    }

    managedSessions.delete(sessionId)
    managedTimelines.delete(sessionId)
    sessionTimelineOverlays.delete(sessionId)
    sessionPlans.delete(sessionId)
    sessionInteractions.delete(sessionId)
    sessionChangeSets.delete(sessionId)
  }
}

const collectDescendantSessionIds = (
  rootSessionId: string,
  sessions: SessionRef[],
) => {
  const descendants: string[] = []
  const queue = [rootSessionId]

  while (queue.length > 0) {
    const currentId = queue.shift()!
    for (const session of sessions) {
      if (session.subagent?.parent_session_id !== currentId) {
        continue
      }

      descendants.push(session.id)
      queue.push(session.id)
    }
  }

  return descendants
}

const setManagedSessionPinnedState = (sessionId: string, pinned: boolean) => {
  const session = managedSessions.get(sessionId)
  if (!session) {
    return
  }

  managedSessions.set(sessionId, {
    ...session,
    pinned,
  })
}

const archiveManagedSession = (sessionId: string) => {
  const session = managedSessions.get(sessionId)
  if (!session) {
    return
  }

  const snapshotPatch = buildArchivedSessionSnapshotPatch(session)
  managedSessions.set(sessionId, {
    ...session,
    ...snapshotPatch,
  })
}

const buildArchivedSessionSnapshotPatch = (
  session: SessionRef,
): Partial<SessionRef> => ({
  archived: true,
  pinned: false,
  health: 'offline',
  mode: 'history-only',
  run_state: 'idle',
  run_state_changed_at: null,
  capability: {
    ...session.capability,
    can_stream_live: false,
    can_send_input: false,
    can_interrupt: false,
    can_approve: false,
    can_reject: false,
    can_show_terminal: false,
  },
})

const buildUnarchivedSessionSnapshotPatch = (
  session: SessionRef,
): Partial<SessionRef> => ({
  archived: false,
  health: 'idle',
  mode: session.mode === 'history-only' ? 'managed' : session.mode,
  run_state: 'idle',
  run_state_changed_at: null,
  capability: {
    ...session.capability,
    can_stream_live: true,
    can_send_input: true,
    can_interrupt: true,
    can_approve: true,
    can_reject: true,
    can_show_terminal: true,
  },
})

const unarchiveManagedSession = (sessionId: string) => {
  const session = managedSessions.get(sessionId)
  if (!session) {
    return
  }

  const snapshotPatch = buildUnarchivedSessionSnapshotPatch(session)
  managedSessions.set(sessionId, {
    ...session,
    ...snapshotPatch,
  })
}

const deleteManagedSession = (sessionId: string) => {
  managedSessions.delete(sessionId)
  managedTimelines.delete(sessionId)
  sessionTimelineOverlays.delete(sessionId)
  sessionPlans.delete(sessionId)
  sessionInteractions.delete(sessionId)
  sessionChangeSets.delete(sessionId)

  if (activeSessionId === sessionId) {
    activeSessionId = ''
  }
}

const archiveDiscoveredSession = async (sessionId: string) => {
  const filePath = discoveredSessionFiles[sessionId]
  if (!filePath) {
    return
  }

  const nextPath = await moveRolloutFileToArchived(filePath, codexHome)
  discoveredSessionFiles[sessionId] = nextPath
}

const unarchiveDiscoveredSession = async (sessionId: string) => {
  const filePath = discoveredSessionFiles[sessionId]
  if (!filePath) {
    return
  }

  const nextPath = await moveRolloutFileFromArchived(filePath, codexHome)
  discoveredSessionFiles[sessionId] = nextPath
}

const deleteDiscoveredSession = async (sessionId: string) => {
  const filePath = discoveredSessionFiles[sessionId]
  if (!filePath) {
    return
  }

  await deleteRolloutFile(filePath)
  delete discoveredSessionFiles[sessionId]

  if (activeSessionId === sessionId) {
    activeSessionId = ''
  }
}

const findNextSessionId = (sessions: SessionRef[]) =>
  sessions.find((session) => !session.archived && !session.subagent)?.id ??
  sessions.find((session) => !session.archived)?.id ??
  sessions[0]?.id ??
  null

await app.register(cors, {
  credentials: true,
  origin: (origin, callback) => {
    callback(null, isAllowedCorsOrigin(origin))
  },
})
const devManager = createDevManager({
  codexHome: resolvedCodexHomePath,
  logger: app.log,
})
await app.register(compress, {
  global: false,
  globalDecompression: false,
})
await app.register(websocket, {
  options: {
    perMessageDeflate: true,
  },
})

if (mode === 'hub') {
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? request.url
    if (
      pathname === '/health' ||
      pathname === '/api/bootstrap' ||
      pathname === '/api/hub/directory' ||
      pathname === '/api/hub/recent-sessions' ||
      pathname.startsWith('/api/dev-manager') ||
      pathname === '/api/agents/register' ||
      pathname === '/api/agents/heartbeat' ||
      /^\/api\/sessions\/[^/]+\/location$/.test(pathname) ||
      /^\/api\/agents\/[^/]+\/actions$/.test(pathname) ||
      pathname === '/ws'
    ) {
      return
    }

    if (pathname.startsWith('/api/')) {
      reply.code(409)
      return reply.send({
        error: 'Hub control plane does not serve agent-scoped data-plane requests.',
      })
    }
  })
}

app.get('/health', async () => ({
  ok: true,
  service: serviceName,
  mode,
  provider: 'codex',
  timestamp: isoNow(),
}))

app.get('/api/dev-manager', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as
      | { includeServiceProbe?: string | boolean | null }
      | undefined
    const includeServiceProbe =
      query?.includeServiceProbe === true ||
      query?.includeServiceProbe === 'true' ||
      query?.includeServiceProbe === '1'
    return await devManager.readSnapshot({ includeServiceProbe })
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to read dev manager snapshot.',
    }
  }
})

app.post('/api/dev-manager/config', async (request: FastifyRequest, reply: FastifyReply) => {
  const parsed = devManagerConfigUpdateSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.code(400)
    return { error: 'Invalid dev manager config payload.' }
  }

  try {
    return await devManager.saveConfig(parsed.data)
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to save dev manager config.',
    }
  }
})

app.post('/api/dev-manager/actions', async (request: FastifyRequest, reply: FastifyReply) => {
  const parsed = devManagerActionRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.code(400)
    return { error: 'Invalid dev manager action payload.' }
  }

  try {
    return await devManager.executeAction(parsed.data.action)
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to execute dev manager action.',
    }
  }
})

app.get('/api/dev-manager/apk/download', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { artifactId?: string | null } | undefined
    const download = await devManager.readApkDownload(query?.artifactId ?? null)
    if (!download) {
      reply.code(404)
      return { error: 'APK artifact not found.' }
    }

    reply.header('cache-control', 'no-store')
    reply.header(
      'content-disposition',
      `attachment; filename="${download.artifact.file_name}"`,
    )
    reply.type('application/vnd.android.package-archive')
    return reply.send(await fs.readFile(download.filePath))
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to download APK artifact.',
    }
  }
})

app.get('/api/bootstrap', {
  compress: LARGE_JSON_ROUTE_COMPRESS_OPTIONS,
}, async () => buildSnapshot())

app.get('/api/hub/directory', async (_request: FastifyRequest, reply: FastifyReply) => {
  if (mode !== 'hub') {
    reply.code(409)
    return { error: 'Hub directory is only available on hub.' }
  }

  return buildHubDirectorySnapshot()
})

app.get('/api/hub/recent-sessions', async (_request: FastifyRequest, reply: FastifyReply) => {
  if (mode !== 'hub') {
    reply.code(409)
    return { error: 'Hub recent sessions are only available on hub.' }
  }

  await ensureSnapshotLoaded()
  return buildHubRecentSessionsSnapshot()
})

app.get('/api/sessions/:sessionId/location', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }

  await ensureSnapshotLoaded()
  const location = readSessionLocationForCurrentSnapshot(sessionId)
  if (!location) {
    reply.code(404)
    return { error: 'Session location not found.' }
  }

  return location
})

app.post('/api/agents/register', async (request: FastifyRequest, reply: FastifyReply) => {
  if (mode !== 'hub' || !hubAgentRegistry) {
    reply.code(404)
    return { error: 'Agent registration is only available on hub.' }
  }

  if (!validateHubControlPlaneAuth(request)) {
    reply.code(401)
    return { error: 'Invalid hub agent api key.' }
  }

  const parsed = agentControlPlaneSyncSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.code(400)
    return { error: 'Invalid agent registration payload.' }
  }

  const registered = await hubAgentRegistry.upsert(parsed.data)
  snapshot = hubAgentRegistry.buildSnapshot()
  activeSessionId = snapshot.active_session_id
  broadcastSnapshotChanged()
  broadcastEvent('agent.online', {
    agentId: registered.agent.id,
    sessionId: registered.active_session_id,
  })

  return {
    ok: true as const,
    agent_id: registered.agent.id,
    heartbeat_interval_ms: HUB_AGENT_HEARTBEAT_INTERVAL_MS,
    heartbeat_timeout_ms: HUB_AGENT_HEARTBEAT_TIMEOUT_MS,
    registered_at: registered.agent.registered_at ?? isoNow(),
    received_at: registered.agent.last_seen_at ?? isoNow(),
  }
})

app.post('/api/agents/heartbeat', async (request: FastifyRequest, reply: FastifyReply) => {
  if (mode !== 'hub' || !hubAgentRegistry) {
    reply.code(404)
    return { error: 'Agent heartbeat is only available on hub.' }
  }

  if (!validateHubControlPlaneAuth(request)) {
    reply.code(401)
    return { error: 'Invalid hub agent api key.' }
  }

  const parsed = agentControlPlaneSyncSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.code(400)
    return { error: 'Invalid agent heartbeat payload.' }
  }

  const registered = await hubAgentRegistry.upsert(parsed.data)
  snapshot = hubAgentRegistry.buildSnapshot()
  activeSessionId = snapshot.active_session_id

  return {
    ok: true as const,
    agent_id: registered.agent.id,
    heartbeat_interval_ms: HUB_AGENT_HEARTBEAT_INTERVAL_MS,
    heartbeat_timeout_ms: HUB_AGENT_HEARTBEAT_TIMEOUT_MS,
    registered_at: registered.agent.registered_at ?? isoNow(),
    received_at: registered.agent.last_seen_at ?? isoNow(),
  }
})

app.post<{ Params: { agentId: string } }>(
  '/api/agents/:agentId/actions',
  async (
    request: FastifyRequest<{ Params: { agentId: string } }>,
    reply: FastifyReply,
  ) => {
    if (mode !== 'hub' || !hubAgentRegistry) {
      reply.code(404)
      return { error: 'Agent actions are only available on hub.' }
    }

    const parsed = agentActionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400)
      return { error: 'Invalid agent action payload.' }
    }

    const { agentId } = request.params
    const existingAgent = snapshot.agents.find((agent) => agent.id === agentId)
    if (!existingAgent) {
      reply.code(404)
      return { error: 'Agent not found.' }
    }

    if (parsed.data.action === 'rename') {
      const nextDisplayName = parsed.data.display_name?.trim() ?? ''
      await hubAgentRegistry.setDisplayName(agentId, nextDisplayName || null)
    }

    if (parsed.data.action === 'delete') {
      await hubAgentRegistry.remove(agentId)
    }

    snapshot = hubAgentRegistry.buildSnapshot()
    activeSessionId = snapshot.active_session_id
    broadcastSnapshotChanged()

    return { ok: true as const }
  },
)

app.get('/api/push/public-key', async (_request: FastifyRequest, reply: FastifyReply) => {
  if (mode !== 'hub' || !hubWebPushNotifier) {
    reply.code(404)
    return { error: 'Web Push is only available on hub.' }
  }

  return webPushPublicConfigSchema.parse(hubWebPushNotifier.publicConfig)
})

app.post('/api/push/subscriptions', async (request: FastifyRequest, reply: FastifyReply) => {
  if (mode !== 'hub' || !hubPushSubscriptionStore || !hubWebPushNotifier) {
    reply.code(404)
    return { error: 'Web Push is only available on hub.' }
  }

  if (!hubWebPushNotifier.publicConfig.supported) {
    reply.code(409)
    return {
      error:
        hubWebPushNotifier.publicConfig.reason ??
        'Hub Web Push is not configured.',
    }
  }

  const parsed = webPushSubscriptionUpsertRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.code(400)
    return { error: 'Invalid Web Push subscription payload.' }
  }

  const response = hubPushSubscriptionStore.upsert({
    subscription: parsed.data.subscription,
    settings: parsed.data.settings,
    device: parsed.data.device,
  })
  return response satisfies WebPushSubscriptionResponse
})

app.post('/api/push/subscriptions/remove', async (request: FastifyRequest, reply: FastifyReply) => {
  if (mode !== 'hub' || !hubPushSubscriptionStore) {
    reply.code(404)
    return { error: 'Web Push is only available on hub.' }
  }

  const parsed = webPushSubscriptionRemoveRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.code(400)
    return { error: 'Invalid Web Push subscription removal payload.' }
  }

  hubPushSubscriptionStore.remove(parsed.data.endpoint)
  return { ok: true as const }
})

app.post('/api/push/test', async (request: FastifyRequest, reply: FastifyReply) => {
  if (mode !== 'hub' || !hubPushSubscriptionStore || !hubWebPushNotifier) {
    reply.code(404)
    return { error: 'Web Push is only available on hub.' }
  }

  if (!hubWebPushNotifier.publicConfig.supported) {
    reply.code(409)
    return {
      error:
        hubWebPushNotifier.publicConfig.reason ??
        'Hub Web Push is not configured.',
    }
  }

  const parsed = webPushTestRequestSchema.safeParse(request.body)
  if (!parsed.success) {
    reply.code(400)
    return { error: 'Invalid Web Push test payload.' }
  }

  const delivered = await deliverWebPushToStoredSubscription(parsed.data.endpoint, {
    title: 'Panda 测试推送',
    body: '这是一条来自 Hub 的测试通知，说明后台 Web Push 链路已经打通。',
    url: '/',
    tag: `panda-web-push-test:${Date.now()}`,
  })

  if (!delivered.ok) {
    reply.code(delivered.error === 'Web Push subscription not found.' ? 404 : 502)
    return { error: delivered.error }
  }

  return {
    ok: true as const,
    endpoint: parsed.data.endpoint,
    delivered_at: delivered.deliveredAt,
  }
})

app.get('/api/sessions/:sessionId/timeline', {
  compress: LARGE_JSON_ROUTE_COMPRESS_OPTIONS,
}, async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const requestedView = (request.query as { view?: string } | undefined)?.view
  const view: SessionTimelineView =
    requestedView === 'full_compact' ? 'full_compact' : 'tail'
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session timeline not found.' }
  }

  return readTimelineForSession(sessionId, view)
})

app.get('/api/sessions/:sessionId/bootstrap', {
  compress: LARGE_JSON_ROUTE_COMPRESS_OPTIONS,
}, async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const bootstrap = await buildSessionBootstrapSnapshot(sessionId, {
    resumeLiveSession: true,
    timelineView: 'tail',
  }).catch((error) => {
    reply.code(error instanceof Error && error.message === 'Project not found.' ? 404 : 409)
    return {
      error: error instanceof Error ? error.message : 'Unable to build session bootstrap.',
    }
  })

  if (bootstrap && typeof bootstrap === 'object' && 'error' in bootstrap) {
    return bootstrap
  }

  if (!bootstrap) {
    reply.code(404)
    return { error: 'Session bootstrap not found.' }
  }

  return bootstrap
})

app.get('/api/sessions/:sessionId/tool-detail', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const query = (request.query ?? {}) as {
    entryId?: string
  }
  const entryId = query.entryId?.trim() ?? ''

  if (!entryId) {
    reply.code(400)
    return { error: 'Tool detail entryId is required.' }
  }

  const session = await findSnapshotSession(sessionId)
  if (!session) {
    reply.code(404)
    return { error: 'Session tool detail not found.' }
  }

  const detail = await buildSessionToolCallDetail(sessionId, entryId)
  if (!detail) {
    reply.code(404)
    return { error: 'Tool detail not found.' }
  }

  return detail
})

app.get('/api/sessions/:sessionId/recovery', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const recovery = await buildSessionRecoverySnapshot(sessionId, {
    resumeLiveSession: true,
  })

  if (!recovery) {
    reply.code(404)
    return { error: 'Session recovery not found.' }
  }

  return recovery
})

app.get('/api/sessions/:sessionId/change-sets', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session change sets not found.' }
  }

  return summarizeChangeSets(await readChangeSetsForSession(sessionId))
})

app.get('/api/sessions/:sessionId/change-set-file-diff', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const query = request.query as {
    changeSetId?: string
    path?: string
    itemId?: string
  } | undefined
  const changeSetId = query?.changeSetId?.trim() ?? ''
  const targetPath = query?.path?.trim() ?? ''
  const itemId = typeof query?.itemId === 'string' && query.itemId.trim()
    ? query.itemId.trim()
    : undefined
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session change set not found.' }
  }

  if (!changeSetId || !targetPath) {
    reply.code(400)
    return { error: 'changeSetId and path are required.' }
  }

  const diff = await readChangeSetFileDiffForSession(sessionId, {
    changeSetId,
    path: targetPath,
    itemId,
  })
  if (!diff) {
    reply.code(404)
    return { error: 'Change-set file diff not found.' }
  }

  return diff
})

app.post<{
  Body: {
    action: 'rollback'
  }
}>('/api/sessions/:sessionId/turns/:turnId/actions', async (
  request: FastifyRequest<{
    Body: {
      action: 'rollback'
    }
  }>,
  reply: FastifyReply,
) => {
  const { sessionId, turnId } = request.params as {
    sessionId: string
    turnId: string
  }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_git) {
    reply.code(409)
    return { error: 'This session does not support git workspace actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  if (request.body.action !== 'rollback') {
    reply.code(409)
    return { error: 'Unsupported turn action.' }
  }

  const normalizedTurnId = turnId.trim()
  if (!normalizedTurnId) {
    reply.code(400)
    return { error: 'Turn id is required.' }
  }

  const changeSet = await readChangeSetForTurn(sessionId, normalizedTurnId)
  if (!changeSet) {
    reply.code(404)
    return { error: 'Session turn change-set not found.' }
  }

  try {
    await rollbackSessionChangeSet(project.path, changeSet)
    return {
      ok: true as const,
      turn_id: changeSet.turn_id,
      change_set_id: changeSet.id,
      workspace: await readSessionGitWorkspace(session, project),
    }
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to execute turn action.',
    }
  }
})

app.get('/api/sessions/:sessionId/file-preview/tree', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const { path: requestedPath } = (request.query ?? {}) as {
    path?: string
  }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return await readSessionFilePreviewTree(session, project, requestedPath ?? null)
  } catch (error) {
    if (error instanceof Error && error.message === 'File not found.') {
      reply.code(404)
      return { error: error.message }
    }

    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to read file preview tree.',
    }
  }
})

app.get('/api/sessions/:sessionId/file-preview/content', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const { path: requestedPath } = (request.query ?? {}) as {
    path?: string
  }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!requestedPath?.trim()) {
    reply.code(400)
    return { error: 'path is required.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return await readSessionFilePreviewContent(session, project, requestedPath)
  } catch (error) {
    if (error instanceof Error && error.message === 'File not found.') {
      reply.code(404)
      return { error: error.message }
    }

    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to read file preview content.',
    }
  }
})

app.get('/api/sessions/:sessionId/git-workspace', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_git) {
    reply.code(409)
    return { error: 'This session does not support git workspace actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return await readSessionGitWorkspace(session, project)
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to read git workspace.',
    }
  }
})

app.get('/api/sessions/:sessionId/git-workspace/file-diff', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const { path: filePath, previousPath } = (request.query ?? {}) as {
    path?: string
    previousPath?: string
  }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_git) {
    reply.code(409)
    return { error: 'This session does not support git workspace actions.' }
  }

  if (!filePath?.trim()) {
    reply.code(400)
    return { error: 'path is required.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return await readSessionGitWorkspaceFileDiff(
      session,
      project,
      filePath.trim(),
      previousPath?.trim() || null,
    )
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to read git file diff.',
    }
  }
})

app.get('/api/sessions/:sessionId/git/history', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_git) {
    reply.code(409)
    return { error: 'This session does not support git workspace actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return await readSessionGitHistory(session, project)
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to read git history.',
    }
  }
})

app.get('/api/sessions/:sessionId/git/history/file-diff', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const { commitOid, path: filePath, previousPath } = (request.query ?? {}) as {
    commitOid?: string
    path?: string
    previousPath?: string
  }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_git) {
    reply.code(409)
    return { error: 'This session does not support git workspace actions.' }
  }

  if (!commitOid?.trim() || !filePath?.trim()) {
    reply.code(400)
    return { error: 'commitOid and path are required.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return await readSessionGitHistoryFileDiff(
      session,
      project,
      commitOid.trim(),
      normalizeGitWorkspacePath(filePath.trim()),
      previousPath?.trim() ? normalizeGitWorkspacePath(previousPath.trim()) : null,
    )
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to read git history file diff.',
    }
  }
})

app.post<{
  Body: {
    action: 'discard-file' | 'discard-all' | 'commit-all' | 'switch-branch' | 'push'
    path?: string
    branch?: string
    message?: string
  }
}>('/api/sessions/:sessionId/git/actions', async (
  request: FastifyRequest<{
    Body: {
      action: 'discard-file' | 'discard-all' | 'commit-all' | 'switch-branch' | 'push'
      path?: string
      branch?: string
      message?: string
    }
  }>,
  reply: FastifyReply,
) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_git) {
    reply.code(409)
    return { error: 'This session does not support git workspace actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    if (request.body.action === 'discard-file') {
      const workspace = await readSessionGitWorkspace(session, project)
      const targetPath = ensureGitActionPath(project.path, request.body.path)
      const targetFile = workspace.files.find((file) => file.path === targetPath) ?? null
      if (!targetFile) {
        throw new Error('目标文件当前没有待处理的改动。')
      }
      await discardGitWorkspaceFile(project.path, targetFile)
    } else if (request.body.action === 'discard-all') {
      await discardAllGitWorkspaceChanges(project.path)
    } else if (request.body.action === 'commit-all') {
      await commitAllGitWorkspaceChanges(project.path, request.body.message ?? '')
    } else if (request.body.action === 'switch-branch') {
      const workspace = await readSessionGitWorkspace(session, project)
      const targetBranch = request.body.branch?.trim() ?? ''
      if (!targetBranch) {
        throw new Error('请选择要切换的分支。')
      }
      if (workspace.branch === targetBranch) {
        throw new Error('当前已经在该分支。')
      }
      if (workspace.files.length > 0) {
        throw new Error('切换分支前请先提交或撤回当前分支改动。')
      }
      if (!workspace.branches.includes(targetBranch)) {
        throw new Error('目标分支不存在。')
      }
      await switchGitWorkspaceBranch(project.path, targetBranch)
    } else if (request.body.action === 'push') {
      await pushGitWorkspaceBranch(project.path)
    } else {
      throw new Error('Unsupported git action.')
    }

    return {
      ok: true as const,
      workspace: await readSessionGitWorkspace(session, project),
    }
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to execute git action.',
    }
  }
})

app.get('/api/sessions/:sessionId/run-workbench', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_terminal) {
    reply.code(409)
    return { error: 'This session does not support terminal workbench actions.' }
  }

  try {
    return await readSessionRunWorkbench(session)
  } catch (error) {
    reply.code(error instanceof Error && error.message === 'Project not found.' ? 404 : 409)
    return {
      error: error instanceof Error ? error.message : 'Unable to read terminal workbench.',
    }
  }
})

app.post<{
  Body: {
    action: 'create' | 'update' | 'delete'
    commandId?: string | null
    command?: SessionRunCommandDraft | null
  }
}>('/api/sessions/:sessionId/run-commands', async (
  request: FastifyRequest<{
    Body: {
      action: 'create' | 'update' | 'delete'
      commandId?: string | null
      command?: SessionRunCommandDraft | null
    }
  }>,
  reply: FastifyReply,
) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_terminal) {
    reply.code(409)
    return { error: 'This session does not support terminal workbench actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return {
      catalog: await saveProjectRunCommand({
        sessionId,
        projectId: project.id,
        projectPath: project.path,
        action: request.body.action,
        commandId: request.body.commandId ?? null,
        command: request.body.command ?? null,
        source: 'user',
      }),
    }
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to save run command.',
    }
  }
})

app.post<{
  Body: {
      prompt?: string | null
      model?: string | null
    }
  }>('/api/sessions/:sessionId/run-commands/generate', async (
  request: FastifyRequest<{
    Body: {
      prompt?: string | null
      model?: string | null
    }
  }>,
  reply: FastifyReply,
) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_terminal) {
    reply.code(409)
    return { error: 'This session does not support terminal workbench actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  const prompt =
    request.body.prompt?.trim() ||
    'Analyze this project and generate the most useful development startup commands, including separate frontend/backend commands when appropriate and a combined startup command if the repo already supports it.'
  const model = request.body.model?.trim() || null

  try {
    const generationPrompt = await buildRunCommandGenerationPrompt(project.path, prompt)
    const raw = await liveSessionStream.runOneShotPrompt({
      cwd: project.path,
      prompt: generationPrompt,
      model,
      reasoningEffort: 'low',
    })
    const generation = parseGeneratedRunCommandDrafts(raw)
    if (generation.commands.length === 0) {
      throw new Error('Codex 没有生成任何可保存的项目命令。')
    }
    const catalog = await replaceGeneratedProjectRunCommands({
      sessionId,
      projectId: project.id,
      projectPath: project.path,
      commands: generation.commands,
    })
    return {
      generation,
      catalog,
    }
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to generate run command.',
    }
  }
})

app.post<{
  Body: {
    action: 'create' | 'update' | 'delete'
    websiteId?: string | null
    website?: SessionRunWebsiteDraft | null
  }
}>('/api/sessions/:sessionId/run-websites', async (
  request: FastifyRequest<{
    Body: {
      action: 'create' | 'update' | 'delete'
      websiteId?: string | null
      website?: SessionRunWebsiteDraft | null
    }
  }>,
  reply: FastifyReply,
) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_terminal) {
    reply.code(409)
    return { error: 'This session does not support terminal workbench actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return {
      catalog: await saveProjectRunWebsite({
        sessionId,
        projectId: project.id,
        projectPath: project.path,
        action: request.body.action,
        websiteId: request.body.websiteId ?? null,
        website: request.body.website ?? null,
        source: 'user',
      }),
    }
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to save run website.',
    }
  }
})

app.post<{
  Body: {
    prompt?: string | null
    model?: string | null
  }
}>('/api/sessions/:sessionId/run-websites/generate', async (
  request: FastifyRequest<{
    Body: {
      prompt?: string | null
      model?: string | null
    }
  }>,
  reply: FastifyReply,
) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_terminal) {
    reply.code(409)
    return { error: 'This session does not support terminal workbench actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  const prompt =
    request.body.prompt?.trim() ||
    'Analyze this project and generate the most useful browser-accessible frontend or preview URLs for daily development.'
  const model = request.body.model?.trim() || null

  try {
    const generationPrompt = buildRunWebsiteGenerationPrompt({
      projectPath: project.path,
      prompt,
      requestHost: parseRequestVisibleHost(request),
      requestProtocol: parseRequestVisibleProtocol(request),
    })
    const raw = await liveSessionStream.runOneShotPrompt({
      cwd: project.path,
      prompt: generationPrompt,
      model,
      reasoningEffort: 'low',
    })
    const generation = parseGeneratedRunWebsiteDrafts(raw)
    const normalizedWebsites = normalizeGeneratedWebsiteDrafts(generation.websites, request)
    if (normalizedWebsites.length === 0) {
      throw new Error('Codex 没有生成任何可保存的网页地址。')
    }
    const catalog = await replaceGeneratedProjectRunWebsites({
      sessionId,
      projectId: project.id,
      projectPath: project.path,
      websites: normalizedWebsites,
    })
    return {
      generation: {
        ...generation,
        websites: normalizedWebsites,
      },
      catalog,
    }
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to generate run website.',
    }
  }
})

app.post<{
  Body: {
    action: 'run-command' | 'run-kill-command' | 'stop' | 'close' | 'focus'
    commandId?: string | null
    terminalId?: string | null
  }
}>('/api/sessions/:sessionId/terminals', async (
  request: FastifyRequest<{
    Body: {
      action: 'run-command' | 'run-kill-command' | 'stop' | 'close' | 'focus'
      commandId?: string | null
      terminalId?: string | null
    }
  }>,
  reply: FastifyReply,
) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_terminal) {
    reply.code(409)
    return { error: 'This session does not support terminal workbench actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    if (
      request.body.action === 'run-command'
      || request.body.action === 'run-kill-command'
    ) {
      const commandId = request.body.commandId?.trim() ?? ''
      if (!commandId) {
        throw new Error('请选择要运行的命令。')
      }
      const catalog = await readProjectRunCommandCatalog({
        sessionId,
        projectId: project.id,
        projectPath: project.path,
      })
      const command = catalog.commands.find((item) => item.id === commandId)
      if (!command) {
        throw new Error('目标命令不存在。')
      }
      const isKillAction = request.body.action === 'run-kill-command'
      const killCommand = command.kill_command?.trim() ?? ''
      if (isKillAction && !killCommand) {
        throw new Error('该命令没有可执行的停止命令。')
      }
      const resolved = await resolveRunCommandExecution(project.path, command, {
        overrideCommand: isKillAction ? killCommand : null,
      })
      return runWorkbenchManager.runCommand({
        sessionId,
        projectId: project.id,
        commandId: command.id,
        title: isKillAction ? `${command.name} · 停止` : command.name,
        command: resolved.command,
        cwd: resolved.cwd,
        env: resolved.env,
        launchError: resolved.launch_error,
        runtimeNodeVersion: resolved.runtime_node_version,
        shell: resolved.shell,
      })
    }

    const terminalId = request.body.terminalId?.trim() ?? ''
    if (!terminalId) {
      throw new Error('缺少目标终端。')
    }

    if (request.body.action === 'stop') {
      return {
        snapshot: runWorkbenchManager.stopTerminal({
          sessionId,
          projectId: project.id,
          terminalId,
        }),
        terminal: null,
      }
    }

    if (request.body.action === 'close') {
      return {
        snapshot: runWorkbenchManager.closeTerminal({
          sessionId,
          projectId: project.id,
          terminalId,
        }),
        terminal: null,
      }
    }

    if (request.body.action === 'focus') {
      return {
        snapshot: runWorkbenchManager.focusTerminal({
          sessionId,
          projectId: project.id,
          terminalId,
        }),
        terminal: null,
      }
    }

    throw new Error('Unsupported terminal action.')
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to execute terminal action.',
    }
  }
})

app.get('/api/sessions/:sessionId/terminals/:terminalId/output', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId, terminalId } = request.params as {
    sessionId: string
    terminalId: string
  }
  const { cursor } = (request.query ?? {}) as {
    cursor?: string
  }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (!session.capability.can_show_terminal) {
    reply.code(409)
    return { error: 'This session does not support terminal workbench actions.' }
  }

  const project = await readProjectForSession(session)
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return runWorkbenchManager.getOutput({
      sessionId,
      projectId: project.id,
      terminalId,
      cursor:
        typeof cursor === 'string' && cursor.trim()
          ? Number.parseInt(cursor, 10)
          : undefined,
    })
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to read terminal output.',
    }
  }
})

app.get('/api/sessions/:sessionId/plan', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session plan not found.' }
  }

  return readPlanForSession(sessionId)
})

app.get('/api/sessions/:sessionId/interactions', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session interactions not found.' }
  }

  return readInteractionsForSession(sessionId)
})

app.get('/api/workspace', {
  compress: LARGE_JSON_ROUTE_COMPRESS_OPTIONS,
}, async (request: FastifyRequest, reply: FastifyReply) => {
  if (mode === 'hub') {
    reply.code(409)
    return { error: 'Workspace directory is only available on agent.' }
  }

  await ensureSnapshotLoaded()
  const { selectedSessionId } = (request.query ?? {}) as {
    selectedSessionId?: string
  }

  return buildWorkspaceDirectorySnapshot({
    selectedSessionId: selectedSessionId ?? null,
  })
})

app.get('/api/workspace/session-detail', async (request: FastifyRequest, reply: FastifyReply) => {
  if (mode === 'hub') {
    reply.code(409)
    return { error: 'Workspace session detail is only available on agent.' }
  }

  await ensureSnapshotLoaded()
  const query = (request.query ?? {}) as {
    sessionId?: string
  }
  const sessionId = query.sessionId?.trim() ?? ''

  if (!sessionId) {
    reply.code(400)
    return { error: 'Workspace session detail sessionId is required.' }
  }

  const detail = await readWorkspaceSessionDetail(sessionId)
  if (!detail) {
    reply.code(404)
    return { error: 'Workspace session detail not found.' }
  }

  return detail
})

app.get('/api/workspace/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
  if (mode === 'hub') {
    reply.code(409)
    return { error: 'Workspace session pages are only available on agent.' }
  }

  await ensureSnapshotLoaded()
  const query = (request.query ?? {}) as {
    bucket?: string
    projectId?: string
    cursor?: string
    limit?: string
    selectedSessionId?: string
  }
  const bucket = query.bucket === 'archived' || query.bucket === 'history'
    ? query.bucket
    : null

  if (!bucket) {
    reply.code(400)
    return { error: 'Workspace session bucket is required.' }
  }

  return readWorkspaceSessionPage({
    bucket,
    projectId: query.projectId ?? null,
    cursor: query.cursor,
    limit: query.limit,
    selectedSessionId: query.selectedSessionId ?? null,
  })
})

app.get('/api/directories', async (request: FastifyRequest, reply: FastifyReply) => {
  const { path: targetPath, agentId } = request.query as { path?: string; agentId?: string }

  if (agentId && agentId !== localAgentId) {
    reply.code(404)
    return { error: 'Agent not found.' }
  }

  try {
    return await listDirectories(targetPath)
  } catch {
    reply.code(400)
    return { error: 'Unable to list directories.' }
  }
})

app.post<{
  Body: {
    agentId?: string
    parentPath: string
    name: string
  }
}>('/api/directories', async (
  request: FastifyRequest<{
    Body: {
      agentId?: string
      parentPath: string
      name: string
    }
  }>,
  reply: FastifyReply,
) => {
  const { agentId, parentPath, name } = request.body

  if (agentId && agentId !== localAgentId) {
    reply.code(404)
    return { error: 'Agent not found.' }
  }

  try {
    const directory = await createDirectory({
      parentPath,
      name,
    })

    reply.code(201)
    return { directory }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unable to create directory.'
    const isConflict = errorMessage === 'Directory already exists.'
    reply.code(isConflict ? 409 : 400)
    return { error: errorMessage }
  }
})

app.get<{
  Querystring: { refresh?: string }
}>('/api/projects/:projectId/skills', async (
  request: FastifyRequest<{
    Querystring: { refresh?: string }
  }>,
  reply: FastifyReply,
) => {
  const { projectId } = request.params as { projectId: string }
  const project = await findSnapshotProject(projectId)

  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return await readProjectSkills(project, {
      forceReload: request.query.refresh === '1',
    })
  } catch (error) {
    reply.code(503)
    return {
      error: error instanceof Error ? error.message : 'Unable to load project skills.',
    }
  }
})

app.get('/api/codex/commands', async (_request: FastifyRequest, reply: FastifyReply) => {
  try {
    return await toDisplayedCodexCommandCatalog(await readCodexCommandCatalog())
  } catch (error) {
    reply.code(503)
    return {
      error: error instanceof Error ? error.message : 'Unable to load Codex commands.',
    }
  }
})

app.post('/api/codex/commands/refresh', async (_request: FastifyRequest, reply: FastifyReply) => {
  try {
    return await toDisplayedCodexCommandCatalog(
      await refreshCodexCommandCatalog(),
    )
  } catch (error) {
    reply.code(503)
    return {
      error: error instanceof Error ? error.message : 'Unable to refresh Codex commands.',
    }
  }
})

app.post<{ Body: { name: string; path: string } }>('/api/projects', async (
  request: FastifyRequest<{ Body: { name: string; path: string } }>,
  reply: FastifyReply,
) => {
  const name = request.body.name.trim()
  const targetPath = request.body.path.trim()

  if (!name || !targetPath) {
    reply.code(400)
    return { error: 'Project name and path are required.' }
  }

  await ensureSnapshotLoaded()
  const existing = snapshot.projects.find(
    (project) =>
      project.agent_id === localAgentId &&
      normalizePathKey(project.path) === normalizePathKey(targetPath),
  )

  if (existing) {
    reply.code(200)
    return { project: existing, created: false }
  }

  const project: ProjectRef = {
    id: `project-${slugify(name)}-${Date.now()}`,
    agent_id: localAgentId,
    name,
    display_name: null,
    pinned: false,
    path: targetPath,
    branch: 'unknown',
    worktree: 'default',
    runtime_profiles: [],
    preview_url: null,
  }

  customProjects.set(project.id, project)
  upsertSnapshotProject(project)
  broadcastSnapshotChanged()
reply.code(201)
return { project, created: true }
})

const readCodexConfigDiagnostics = async (projectPath: string) => {
  try {
    const config = await liveSessionStream.readConfig({ cwd: projectPath })
    return {
      model: config.model,
      modelProvider: config.modelProvider,
      reasoningEffort: config.reasoningEffort,
      approvalPolicy: config.approvalPolicy,
      sandboxMode: config.sandboxMode,
      serviceTier: config.serviceTier,
      profile: config.profile,
      baseUrl: config.baseUrl,
      providerBaseUrl: config.providerBaseUrl,
      providerBaseUrls: config.providerBaseUrls,
    }
  } catch {
    return null
  }
}

app.post<{ Body: { projectId: string; title: string; input?: string; attachments?: SessionInputAttachment[]; model?: string; titleGenerationModel?: string; reasoningEffort?: string; serviceTier?: 'fast'; planMode?: boolean; yoloMode?: boolean } }>('/api/sessions', async (
  request: FastifyRequest<{
    Body: {
      projectId: string
      title: string
      input?: string
      attachments?: SessionInputAttachment[]
      model?: string
      titleGenerationModel?: string
      reasoningEffort?: string
      serviceTier?: 'fast'
      planMode?: boolean
      yoloMode?: boolean
    }
  }>,
  reply: FastifyReply,
) => {
  const title = request.body.title.trim()
  const input = request.body.input?.trim() ?? ''
  const attachments = normalizeSessionInputAttachments(request.body.attachments)
  const model = request.body.model?.trim() || null
  const titleGenerationModel =
    request.body.titleGenerationModel?.trim() ||
    DEFAULT_SESSION_TITLE_GENERATION_MODEL
  const reasoningEffort = request.body.reasoningEffort?.trim() || null
  const requestedServiceTier = request.body.serviceTier
  const normalizedRequestedServiceTier = normalizeServiceTier(requestedServiceTier)
  const serviceTier = resolvePandaServiceTier(normalizedRequestedServiceTier)
  const planMode = request.body.planMode === true
  const yoloMode = request.body.yoloMode === true
  if (!title) {
    reply.code(400)
    return { error: 'Session title is required.' }
  }

  if (!input && attachments.length === 0) {
    reply.code(400)
    return { error: 'Message input or attachments are required.' }
  }

  const project = await findSnapshotProject(request.body.projectId)
  if (!project || project.agent_id !== localAgentId) {
    reply.code(400)
    return { error: 'Project not found.' }
  }

  const requestDiagnostics = summarizeForwardingRequest(request)
  const configDiagnostics = await readCodexConfigDiagnostics(project.path)
  const prompt = buildTurnPrompt(input, planMode) || null
  const payloadDiagnostics = summarizeForwardingPayload({
    title,
    input,
    prompt,
    attachments,
    model,
    titleGenerationModel,
    reasoningEffort,
    requestedServiceTier,
    normalizedRequestedServiceTier,
    effectiveServiceTier: serviceTier,
    planMode,
    yoloMode,
  })
  diagnosticLogger.info({
    route: 'create-session',
    projectId: project.id,
    projectPath: project.path,
    payload: payloadDiagnostics,
    request: requestDiagnostics,
    codexConfig: configDiagnostics,
  }, 'Forwarding Panda session creation to Codex.')

  let sessionId = ''
  const sessionTimestamp = isoNow()
  try {
    const created = await liveSessionStream.startThread({
      cwd: project.path,
      title,
      prompt,
      attachments,
      model,
      reasoningEffort,
      serviceTier,
      yoloMode,
    })
    sessionId = created.sessionId
    await appendSessionIndexUpdate(
      sessionId,
      {
        thread_name: title,
      },
      codexHome,
    )
  } catch (error) {
    diagnosticLogger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      route: 'create-session',
      projectId: project.id,
      projectPath: project.path,
      payload: payloadDiagnostics,
      request: requestDiagnostics,
      codexConfig: configDiagnostics,
    }, 'Failed to create Codex session from Panda.')
    reply.code(502)
    return {
      error: error instanceof Error ? error.message : 'Unable to start Codex session.',
    }
  }
  diagnosticLogger.info({
    route: 'create-session',
    sessionId,
    projectId: project.id,
    projectPath: project.path,
    payload: payloadDiagnostics,
    request: requestDiagnostics,
    codexConfig: configDiagnostics,
  }, 'Successfully created Codex session from Panda.')

  const session: SessionWithRunState = {
    id: sessionId,
    agent_id: localAgentId,
    project_id: project.id,
    provider: 'codex',
    archived: false,
    title,
    mode: 'managed',
    health: 'active',
    branch: project.branch,
    worktree: project.worktree,
    summary: input ? truncateSummary(input) : attachments[0]?.name ?? '',
    latest_assistant_message: null,
    last_event_at: sessionTimestamp,
    pinned: false,
    run_state: input || attachments.length > 0 ? 'running' : 'idle',
    run_state_changed_at: input || attachments.length > 0 ? sessionTimestamp : null,
    context_usage: null,
    subagent: null,
    capability: {
      can_stream_live: true,
      can_send_input: true,
      can_interrupt: true,
      can_approve: true,
      can_reject: true,
      can_show_git: true,
      can_show_terminal: true,
    },
  }

  setManagedSessionActive(session.id)
  managedSessions.set(session.id, session)
  upsertSnapshotSession(session)
  broadcastSnapshotChanged()

  void generateSessionTitleInBackground({
    sessionId: session.id,
    project,
    fallbackTitle: title,
    message: input,
    attachments,
    model: titleGenerationModel,
  })

  reply.code(201)
  return { session }
})

app.post<{ Body: { action: 'pin' | 'unpin' | 'archive' | 'delete' | 'rename'; name?: string } }>(
  '/api/sessions/:sessionId/actions',
  async (
    request: FastifyRequest<{ Body: { action: 'pin' | 'unpin' | 'archive' | 'delete' | 'rename'; name?: string } }>,
    reply: FastifyReply,
  ) => {
    const { sessionId } = request.params as { sessionId: string }
    const session = await findSnapshotSession(sessionId)

    if (!session) {
      reply.code(404)
      return { error: 'Session not found.' }
    }

    const action = request.body.action
    if ((action === 'pin' || action === 'unpin') && session.subagent) {
      reply.code(400)
      return { error: 'Subagent sessions cannot be pinned.' }
    }

    if (action === 'rename') {
      const nextName = request.body.name?.trim() ?? ''
      if (!nextName) {
        reply.code(400)
        return { error: 'Session name is required.' }
      }
      await renameSession(sessionId, nextName)
      return {
        ok: true,
        affectedSessionIds: [sessionId],
        nextSessionId: findNextSessionId(snapshot.sessions),
      }
    }

    if ((action === 'archive' || action === 'delete') && session.run_state === 'running') {
      reply.code(409)
      return { error: 'Running sessions cannot be changed right now.' }
    }

    const affectedSessionIds = [
      sessionId,
      ...(session.subagent ? [] : collectDescendantSessionIds(sessionId, snapshot.sessions)),
    ]

    if (action === 'pin' || action === 'unpin') {
      const pinned = action === 'pin'
      for (const affectedSessionId of affectedSessionIds) {
        await setSessionPinned(affectedSessionId, pinned, codexHome)
        setManagedSessionPinnedState(affectedSessionId, pinned)
        patchSnapshotSession(affectedSessionId, { pinned })
        broadcastEvent('session.updated', {
          sessionId: affectedSessionId,
          sessionPatch: {
            pinned,
          },
        })
      }

      return {
        ok: true,
        affectedSessionIds,
        nextSessionId: findNextSessionId(snapshot.sessions),
      }
    }

    for (const affectedSessionId of affectedSessionIds) {
      await setSessionPinned(affectedSessionId, false, codexHome)
      const hasManagedOverlay = managedSessions.has(affectedSessionId)
      const hasDiscoveredFile = Boolean(discoveredSessionFiles[affectedSessionId])

      if (hasManagedOverlay) {
        if (action === 'archive') {
          archiveManagedSession(affectedSessionId)
        } else {
          deleteManagedSession(affectedSessionId)
        }
      }

      if (!hasManagedOverlay || hasDiscoveredFile) {
        if (action === 'archive') {
          await archiveDiscoveredSession(affectedSessionId)
        } else {
          await deleteDiscoveredSession(affectedSessionId)
        }
      }
    }

    if (action === 'archive') {
      for (const affectedSessionId of affectedSessionIds) {
        const snapshotSession = snapshot.sessions.find((item) => item.id === affectedSessionId)
        if (!snapshotSession) {
          continue
        }

        patchSnapshotSession(
          affectedSessionId,
          buildArchivedSessionSnapshotPatch(snapshotSession),
        )
      }
    } else {
      removeSnapshotSessions(affectedSessionIds)
    }

    refreshSnapshotInBackground()
    return {
      ok: true,
      affectedSessionIds,
      nextSessionId: findNextSessionId(snapshot.sessions),
    }
  },
)

app.post<{
  Body: {
    action: 'pin' | 'unpin' | 'rename' | 'remove' | 'archive' | 'unarchive' | 'reorder'
    name?: string
    orderedProjectIds?: string[]
  }
}>('/api/threads/:projectId/actions', async (
  request: FastifyRequest<{
    Body: {
      action: 'pin' | 'unpin' | 'rename' | 'remove' | 'archive' | 'unarchive' | 'reorder'
      name?: string
      orderedProjectIds?: string[]
    }
  }>,
  reply: FastifyReply,
) => {
  const { projectId } = request.params as { projectId: string }
  const project = await findSnapshotProject(projectId)

  if (!project) {
    reply.code(404)
    return { error: 'Thread not found.' }
  }

  const action = request.body.action
  const projectSessions = snapshot.sessions.filter((item) => item.project_id === project.id)
  const archivedProjectSessions = projectSessions.filter((item) => item.archived)
  const isCustomProject = customProjects.has(project.id)

  if (action === 'rename') {
    const nextName = request.body.name?.trim() ?? ''
    if (!nextName) {
      reply.code(400)
      return { error: 'Thread name is required.' }
    }

    if (isCustomProject) {
      customProjects.set(project.id, {
        ...customProjects.get(project.id)!,
        display_name: nextName,
      })
    } else {
      await setWorkspaceRootLabel(project.path, nextName, codexHome)
    }

    patchSnapshotProject(project.id, { display_name: nextName })
    broadcastEvent('thread.updated', {
      projectId: project.id,
      action,
      projectPatch: {
        display_name: nextName,
      },
    })
    return { ok: true, nextSessionId: findNextSessionId(snapshot.sessions) }
  }

  if (action === 'pin' || action === 'unpin') {
    const pinned = action === 'pin'
    if (isCustomProject) {
      customProjects.set(project.id, {
        ...customProjects.get(project.id)!,
        pinned,
      })
    } else {
      await setWorkspaceRootPinned(project.path, pinned, codexHome)
    }

    patchSnapshotProject(project.id, { pinned })
    broadcastEvent('thread.updated', {
      projectId: project.id,
      action,
      projectPatch: {
        pinned,
      },
    })
    return { ok: true, nextSessionId: findNextSessionId(snapshot.sessions) }
  }

  if (action === 'reorder') {
    const orderedProjectIds = Array.isArray(request.body.orderedProjectIds)
      ? request.body.orderedProjectIds
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : []

    if (!orderedProjectIds.includes(project.id)) {
      reply.code(400)
      return { error: 'Thread reorder payload must include the moved thread.' }
    }

    const nextProjects = snapshot.projects
      .filter((item) => item.agent_id === project.agent_id)
    const knownProjectIds = new Set(nextProjects.map((item) => item.id))
    const filteredProjectIds = orderedProjectIds.filter((item) => knownProjectIds.has(item))

    if (filteredProjectIds.length === 0) {
      reply.code(400)
      return { error: 'Thread reorder payload is invalid.' }
    }

    const reorderApplied = reorderSnapshotProjects(filteredProjectIds)
    if (!reorderApplied) {
      return { ok: true, nextSessionId: findNextSessionId(snapshot.sessions) }
    }

    await setWorkspaceRootOrder(
      snapshot.projects
        .filter((item) => item.agent_id === project.agent_id)
        .map((item) => item.path),
      codexHome,
    )

    broadcastEvent('thread.updated', {
      projectId: project.id,
      action,
      orderedProjectIds: filteredProjectIds,
    })
    return { ok: true, nextSessionId: findNextSessionId(snapshot.sessions) }
  }

  if (action === 'remove') {
    if (projectSessions.some((item) => item.run_state === 'running')) {
      reply.code(409)
      return { error: 'Running sessions must finish before removing this thread.' }
    }

    removeManagedSessionsByProjectId(project.id)
    removeCustomProjectByPath(project.path)

    if (!isCustomProject) {
      await setWorkspaceRootVisibility(project.path, false, codexHome)
    }

    removeSnapshotProject(project.id)
    broadcastEvent('thread.updated', {
      projectId: project.id,
      action,
      affectedSessionIds: projectSessions.map((item) => item.id),
    })
    refreshSnapshotInBackground()
    return { ok: true, nextSessionId: findNextSessionId(snapshot.sessions) }
  }

  if (action === 'archive') {
    if (projectSessions.some((item) => item.run_state === 'running')) {
      reply.code(409)
      return { error: 'Running sessions must finish before archiving this thread.' }
    }

    for (const item of projectSessions) {
      await setSessionPinned(item.id, false, codexHome)
      const hasManagedOverlay = managedSessions.has(item.id)
      const hasDiscoveredFile = Boolean(discoveredSessionFiles[item.id])
      if (hasManagedOverlay) {
        archiveManagedSession(item.id)
      }
      if (!hasManagedOverlay || hasDiscoveredFile) {
        await archiveDiscoveredSession(item.id)
      }

      patchSnapshotSession(item.id, buildArchivedSessionSnapshotPatch(item))
    }

    if (!isCustomProject) {
      await setWorkspaceRootVisibility(project.path, false, codexHome)
    }

    broadcastEvent('thread.updated', {
      projectId: project.id,
      action,
      affectedSessionIds: projectSessions.map((item) => item.id),
    })
    refreshSnapshotInBackground()
    return {
      ok: true,
      affectedSessionIds: projectSessions.map((item) => item.id),
      nextSessionId: findNextSessionId(snapshot.sessions),
    }
  }

  if (action === 'unarchive') {
    if (archivedProjectSessions.length === 0) {
      reply.code(400)
      return { error: 'This thread is not archived.' }
    }

    for (const item of archivedProjectSessions) {
      const hasManagedOverlay = managedSessions.has(item.id)
      const hasDiscoveredFile = Boolean(discoveredSessionFiles[item.id])
      if (hasManagedOverlay) {
        unarchiveManagedSession(item.id)
      }
      if (!hasManagedOverlay || hasDiscoveredFile) {
        await unarchiveDiscoveredSession(item.id)
      }

      patchSnapshotSession(item.id, buildUnarchivedSessionSnapshotPatch(item))
    }

    if (!isCustomProject) {
      await setWorkspaceRootVisibility(project.path, true, codexHome)
    }

    broadcastEvent('thread.updated', {
      projectId: project.id,
      action,
      affectedSessionIds: archivedProjectSessions.map((item) => item.id),
    })
    refreshSnapshotInBackground()
    return {
      ok: true,
      affectedSessionIds: archivedProjectSessions.map((item) => item.id),
      nextSessionId: findNextSessionId(snapshot.sessions),
    }
  }

  reply.code(400)
  return { error: 'Unsupported action.' }
})

app.post<{ Body: { input: string } }>('/api/sessions/:sessionId/commands/execute', async (
  request: FastifyRequest<{ Body: { input: string } }>,
  reply: FastifyReply,
) => {
  const { sessionId } = request.params as { sessionId: string }
  const rawInput = request.body.input ?? ''
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  if (session.archived) {
    reply.code(409)
    return { error: 'Archived sessions cannot execute commands.' }
  }

  const project = snapshot.projects.find((item) => item.id === session.project_id) ?? null
  if (!project) {
    reply.code(404)
    return { error: 'Project not found.' }
  }

  try {
    return {
      panel: await executeSessionCommand(session, project, rawInput),
    }
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to execute command.',
    }
  }
})

app.post<{
  Body: {
    panelId: string
    optionId?: string | null
    text?: string | null
  }
}>('/api/sessions/:sessionId/commands/respond', async (
  request: FastifyRequest<{
    Body: {
      panelId: string
      optionId?: string | null
      text?: string | null
    }
  }>,
  reply: FastifyReply,
) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return { error: 'Session not found.' }
  }

  try {
    return {
      panel: await respondToSessionCommand({
        sessionId,
        panelId: request.body.panelId,
        optionId: request.body.optionId ?? null,
        text: request.body.text ?? null,
      }),
    }
  } catch (error) {
    reply.code(409)
    return {
      error: error instanceof Error ? error.message : 'Unable to continue command.',
    }
  }
})

app.post<{
  Body: {
    optionId?: string | null
    text?: string | null
    answers?: Record<string, string> | null
  }
}>('/api/sessions/:sessionId/interactions/:requestId/respond', async (
  request: FastifyRequest<{
    Body: {
      optionId?: string | null
      text?: string | null
      answers?: Record<string, string> | null
    }
  }>,
  reply: FastifyReply,
) => {
  const { sessionId, requestId } = request.params as { sessionId: string; requestId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return {
      accepted: false,
      error: 'Session not found.',
    }
  }

  try {
    await liveSessionStream.ensureSessionTracker(sessionId, discoveredSessionFiles[sessionId])
    await liveSessionStream.respondToInteraction({
      sessionId,
      requestId,
      optionId: request.body.optionId ?? null,
      text: request.body.text ?? null,
      answers: request.body.answers ?? null,
    })
  } catch (error) {
    reply.code(409)
    return {
      accepted: false,
      error: error instanceof Error ? error.message : 'Unable to respond to Codex interaction.',
    }
  }

  reply.code(202)
  return { accepted: true }
})

app.post<{ Body: { input: string; attachments?: SessionInputAttachment[]; model?: string; reasoningEffort?: string; serviceTier?: 'fast'; planMode?: boolean; yoloMode?: boolean } }>('/api/sessions/:sessionId/input', async (
  request: FastifyRequest<{ Body: { input: string; attachments?: SessionInputAttachment[]; model?: string; reasoningEffort?: string; serviceTier?: 'fast'; planMode?: boolean; yoloMode?: boolean } }>,
  reply: FastifyReply,
) => {
  const { sessionId } = request.params as { sessionId: string }
  const input = request.body.input.trim()
  const attachments = normalizeSessionInputAttachments(request.body.attachments)
  const model = request.body.model?.trim() || null
  const reasoningEffort = request.body.reasoningEffort?.trim() || null
  const requestedServiceTier = request.body.serviceTier
  const normalizedRequestedServiceTier = normalizeServiceTier(requestedServiceTier)
  const serviceTier = resolvePandaServiceTier(normalizedRequestedServiceTier)
  const planMode = request.body.planMode === true
  const yoloMode = request.body.yoloMode === true
  if (!input && attachments.length === 0) {
    reply.code(400)
    return {
      accepted: false,
      error: 'Message input or attachments are required.',
    }
  }

  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return {
      accepted: false,
      error: 'Session not found.',
    }
  }

  if (session.archived) {
    reply.code(409)
    return {
      accepted: false,
      error: 'Archived sessions cannot accept new input.',
    }
  }

  const requestDiagnostics = summarizeForwardingRequest(request)
  const project = snapshot.projects.find((item) => item.id === session.project_id) ?? null
  const configDiagnostics =
    project ? await readCodexConfigDiagnostics(project.path) : null
  const prompt = buildTurnPrompt(input, planMode)
  const payloadDiagnostics = summarizeForwardingPayload({
    input,
    prompt,
    attachments,
    model,
    reasoningEffort,
    requestedServiceTier,
    normalizedRequestedServiceTier,
    effectiveServiceTier: serviceTier,
    planMode,
    yoloMode,
  })
  diagnosticLogger.info({
    route: 'session-input',
    sessionId,
    projectId: session.project_id,
    projectPath: project?.path ?? null,
    payload: payloadDiagnostics,
    request: requestDiagnostics,
    codexConfig: configDiagnostics,
  }, 'Forwarding Panda session input to Codex.')

  try {
    await liveSessionStream.ensureSessionTracker(sessionId, discoveredSessionFiles[sessionId])
    await liveSessionStream.resumeSession(sessionId).catch(() => {
      // Resuming helps align turn ids for interrupt and live updates, but should not block input.
    })
    await liveSessionStream.sendUserInput({
      sessionId,
      prompt,
      attachments,
      model,
      reasoningEffort,
      serviceTier,
      yoloMode,
    })
  } catch (error) {
    diagnosticLogger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      route: 'session-input',
      sessionId,
      projectId: session.project_id,
      projectPath: project?.path ?? null,
      payload: payloadDiagnostics,
      request: requestDiagnostics,
      codexConfig: configDiagnostics,
    }, 'Failed to forward Panda session input to Codex.')
    reply.code(409)
    return {
      accepted: false,
      error: error instanceof Error ? error.message : 'Unable to send input to Codex session.',
    }
  }
  diagnosticLogger.info({
    route: 'session-input',
    sessionId,
    projectId: session.project_id,
    projectPath: project?.path ?? null,
    payload: payloadDiagnostics,
    request: requestDiagnostics,
    codexConfig: configDiagnostics,
  }, 'Successfully forwarded Panda session input to Codex.')

  setManagedSessionActive(sessionId)
  const runningAt = isoNow()
  const summary = input ? truncateSummary(input) : attachments[0]?.name ?? '附件'
  const overlayAttachments = buildInlineTimelineAttachments(attachments)
  managedSessions.set(sessionId, {
    ...toSessionWithRunState(session, {
      health: 'active',
      summary,
      latest_assistant_message: null,
      last_event_at: runningAt,
      run_state: 'running',
      run_state_changed_at: runningAt,
      capability: {
        ...session.capability,
        can_send_input: true,
        can_interrupt: true,
      },
    }),
  })
  applySessionPatch(sessionId, {
    run_state: 'running',
    run_state_changed_at: runningAt,
    last_event_at: runningAt,
    summary,
    latest_assistant_message: null,
  })
  const overlayUserEntry: TimelineEntry = {
    id: `${USER_OVERLAY_ENTRY_PREFIX}${sessionId}:${Date.now()}`,
    kind: 'user',
    title: '你',
    body: input,
    body_truncated: false,
    detail_available: false,
    patch_summary: null,
    session_ids: [],
    timestamp: runningAt,
    accent: 'primary',
    attachments: overlayAttachments,
  }
  sessionTimelineOverlays.set(sessionId, [
    ...readTimelineOverlay(sessionId),
    overlayUserEntry,
  ])
  broadcastEvent('session.updated', {
    sessionId,
    sessionPatch: {
      run_state: 'running',
      run_state_changed_at: runningAt,
      last_event_at: runningAt,
      summary,
      latest_assistant_message: null,
    },
  })
  broadcastEvent(
    'timeline.delta',
    {
      sessionId,
      entries: summarizeTimelineEntriesForTransport([overlayUserEntry]),
    },
    { sessionId },
  )

  reply.code(202)
  return { accepted: true }
})

app.post('/api/sessions/:sessionId/interrupt', async (request: FastifyRequest, reply: FastifyReply) => {
  const { sessionId } = request.params as { sessionId: string }
  const session = await findSnapshotSession(sessionId)

  if (!session) {
    reply.code(404)
    return {
      accepted: false,
      error: 'Session not found.',
    }
  }

  setManagedSessionActive(sessionId)
  const completedAt = isoNow()
  const previousSessionState = {
    run_state: session.run_state,
    run_state_changed_at: session.run_state_changed_at,
    last_event_at: session.last_event_at,
  }
  managedSessions.set(sessionId, {
    ...toSessionWithRunState(session, {
      health: 'active',
      latest_assistant_message: null,
      last_event_at: completedAt,
      run_state: 'completed',
      run_state_changed_at: completedAt,
      capability: {
        ...session.capability,
        can_send_input: true,
        can_interrupt: true,
      },
    }),
  })
  applySessionPatch(sessionId, {
    run_state: 'completed',
    run_state_changed_at: completedAt,
    last_event_at: completedAt,
    latest_assistant_message: null,
  })
  broadcastEvent('session.updated', {
    sessionId,
    sessionPatch: {
      run_state: 'completed',
      run_state_changed_at: completedAt,
      last_event_at: completedAt,
      latest_assistant_message: null,
    },
  })
  const interruptEntry: TimelineEntry = {
    id: `entry-system-interrupt-${Date.now()}`,
    kind: 'system',
    title: '中断请求',
    body: '已提交中断请求。',
    body_truncated: false,
    detail_available: false,
    patch_summary: null,
    session_ids: [],
    timestamp: completedAt,
    accent: 'muted',
    attachments: [],
  }
  sessionTimelineOverlays.set(sessionId, [
    ...readTimelineOverlay(sessionId),
    interruptEntry,
  ])
  broadcastEvent(
    'timeline.delta',
    {
      sessionId,
      entries: summarizeTimelineEntriesForTransport([interruptEntry]),
    },
    { sessionId },
  )
  maybeBroadcastTurnCompleted({
    sessionId,
    sessionPatch: {
      run_state: 'completed',
      run_state_changed_at: completedAt,
      latest_assistant_message: null,
    },
    completionReason: 'interrupted',
  })

  reply.code(202)
  void (async () => {
    try {
      await liveSessionStream.ensureSessionTracker(sessionId, discoveredSessionFiles[sessionId])
      await liveSessionStream.interruptTurn(sessionId)
    } catch (error) {
      const failedAt = isoNow()
      const failureMessage =
        error instanceof Error ? error.message : 'Unable to interrupt Codex session.'
      const nextRunState =
        previousSessionState.run_state === 'running' ? 'running' : previousSessionState.run_state
      const nextRunStateChangedAt =
        nextRunState === 'running'
          ? failedAt
          : previousSessionState.run_state_changed_at

      managedSessions.set(sessionId, {
        ...toSessionWithRunState(session, {
          health: 'active',
          latest_assistant_message: null,
          last_event_at: failedAt,
          run_state: nextRunState,
          run_state_changed_at: nextRunStateChangedAt,
          capability: {
            ...session.capability,
            can_send_input: true,
            can_interrupt: true,
          },
        }),
      })
      applySessionPatch(sessionId, {
        run_state: nextRunState,
        run_state_changed_at: nextRunStateChangedAt,
        last_event_at: failedAt,
        latest_assistant_message: null,
      })
      broadcastEvent('session.updated', {
        sessionId,
        sessionPatch: {
          run_state: nextRunState,
          run_state_changed_at: nextRunStateChangedAt,
          last_event_at: failedAt,
          latest_assistant_message: null,
        },
      })

      const failureEntry: TimelineEntry = {
        id: `entry-system-interrupt-failed-${Date.now()}`,
        kind: 'system',
        title: '中断失败',
        body: `中断未完成：${failureMessage}`,
        body_truncated: false,
        detail_available: false,
        patch_summary: null,
        session_ids: [],
        timestamp: failedAt,
        accent: 'muted',
        attachments: [],
      }
      sessionTimelineOverlays.set(sessionId, [
        ...readTimelineOverlay(sessionId),
        failureEntry,
      ])
      broadcastEvent(
        'timeline.delta',
        {
          sessionId,
          entries: summarizeTimelineEntriesForTransport([failureEntry]),
        },
        { sessionId },
      )
    }
  })()

  return { accepted: true }
})

const liveSessionStream = createCodexLiveSessionStream({
  codexHome,
  logger: diagnosticLogger,
  onSkillsChanged: () => {
    invalidateProjectSkillsCache()
  },
  onEvent: ({
    sessionId,
    entries,
    interactionRequests,
    interactionReset,
    resolvedInteractionIds,
    planSnapshot,
    planReset,
    changeSets,
    sessionPatch,
    discoveredAtRuntime,
  }) => {
    if (discoveredAtRuntime) {
      refreshSnapshotInBackground()
    }

    applySessionPatch(sessionId, sessionPatch)
    broadcastEvent('session.updated', {
      sessionId,
      sessionPatch,
    })

    if (entries.length > 0) {
      const nextManagedTimeline = mergeTimelineEntries(
        managedTimelines.get(sessionId) ?? [],
        entries,
      )
      managedTimelines.set(sessionId, nextManagedTimeline)
      readTimelineOverlay(sessionId, nextManagedTimeline)
      broadcastEvent(
        'timeline.delta',
        {
          sessionId,
          entries: summarizeTimelineEntriesForTransport(entries),
        },
        { sessionId },
      )
    }

    if (interactionReset) {
      sessionInteractions.set(sessionId, interactionRequests)
      broadcastEvent(
        'interaction.reset',
        {
          sessionId,
          requests: interactionRequests,
        },
        { sessionId },
      )
    } else {
      if (interactionRequests.length > 0) {
        upsertSessionInteractions(sessionId, interactionRequests)
      }
      if (resolvedInteractionIds.length > 0) {
        resolveSessionInteractions(sessionId, resolvedInteractionIds)
      }
      if (interactionRequests.length > 0 || resolvedInteractionIds.length > 0) {
        broadcastEvent(
          'interaction.delta',
          {
            sessionId,
            requests: interactionRequests,
            resolvedRequestIds: resolvedInteractionIds,
          },
          { sessionId },
        )
      }
    }

    if (planReset) {
      sessionPlans.set(sessionId, null)
      broadcastEvent(
        'plan.reset',
        {
          sessionId,
          planSnapshot: null,
        },
        { sessionId },
      )
    } else if (planSnapshot) {
      sessionPlans.set(sessionId, planSnapshot)
      broadcastEvent(
        'plan.delta',
        {
          sessionId,
          planSnapshot,
        },
        { sessionId },
      )
    }

    if (changeSets.length > 0) {
      upsertSessionChangeSets(sessionId, changeSets)
      broadcastEvent(
        'changeset.delta',
        {
          sessionId,
          changeSets: summarizeChangeSets(changeSets),
        },
        { sessionId },
      )
    }

    maybeBroadcastTurnCompleted({
      sessionId,
      sessionPatch,
      entries: managedTimelines.get(sessionId) ?? [],
      completionReason: 'completed',
    })
  },
})

if (hubAgentRegistry) {
  await hubAgentRegistry.load()
  snapshot = hubAgentRegistry.buildSnapshot()
  activeSessionId = snapshot.active_session_id
  const offlineSweep = setInterval(() => {
    const expiredAgentIds = hubAgentRegistry.markOfflineExpired()
    if (expiredAgentIds.length > 0) {
      snapshot = hubAgentRegistry.buildSnapshot()
      activeSessionId = snapshot.active_session_id
      broadcastSnapshotChanged()
      for (const agentId of expiredAgentIds) {
        broadcastEvent('agent.offline', {
          agentId,
        })
      }
    }
  }, Math.max(5_000, Math.floor(HUB_AGENT_HEARTBEAT_TIMEOUT_MS / 3)))
  app.addHook('onClose', async () => {
    clearInterval(offlineSweep)
  })
} else {
  await liveSessionStream.start()
}

void buildSnapshot()

app.get('/ws', { websocket: true }, (socket: any) => {
  const client = {
    send: socket.send.bind(socket),
    subscribedSessionIds: new Set<string>(),
  }
  wsClients.add(client)
  sendSocketEvent(client, 'agent.online', {
    agentId: snapshot.agents[0]?.id ?? localAgentId,
    sessionId: snapshot.active_session_id,
  })

  socket.on('message', async (rawMessage: Buffer) => {
    let message: { type?: string; sessionId?: string } | null = null
    try {
      message = JSON.parse(rawMessage.toString())
    } catch {
      return
    }

    if (!message?.sessionId) {
      return
    }

    if (message.type === 'session.subscribe') {
      client.subscribedSessionIds.add(message.sessionId)
      if (mode === 'hub') {
        return
      }

      const subscribedSession = snapshot.sessions.find((item) => item.id === message.sessionId) ?? null
      const bootstrap = await buildSessionBootstrapSnapshot(message.sessionId, {
        session: subscribedSession,
        resumeLiveSession: true,
        timelineView: 'tail',
      }).catch(() => null)
      if (!bootstrap) {
        return
      }

      sendSocketEvent(client, 'timeline.reset', {
        sessionId: message.sessionId,
        entries: bootstrap.timeline.entries,
      })

      sendSocketEvent(client, 'interaction.reset', {
        sessionId: message.sessionId,
        requests: bootstrap.interactions,
      })
      sendSocketEvent(client, 'plan.reset', {
        sessionId: message.sessionId,
        planSnapshot: bootstrap.plan_snapshot,
      })
      sendSocketEvent(client, 'changeset.reset', {
        sessionId: message.sessionId,
        changeSets: bootstrap.change_sets,
      })
      sendSocketEvent(client, 'session.updated', {
        sessionId: message.sessionId,
        sessionPatch: bootstrap.session_patch,
      })

      if (bootstrap.run_workbench?.terminal_snapshot) {
        sendSocketEvent(client, 'terminal.snapshot', {
          sessionId: message.sessionId,
          snapshot: bootstrap.run_workbench.terminal_snapshot,
        })
      }
      return
    }

    if (message.type === 'session.unsubscribe') {
      client.subscribedSessionIds.delete(message.sessionId)
    }
  })

  socket.on('close', () => {
    wsClients.delete(client)
  })
})

if (mode === 'hub' && webUiDir) {
  app.get('/*', async (request, reply) => {
    const asset = await resolveWebUiAsset(webUiDir, request.url)
    if (!asset) {
      reply.code(404)
      return {
        error: 'Hub web asset not found.',
      }
    }

    reply.type(asset.contentType)
    reply.header('cache-control', asset.cacheControl)
    return reply.send(await fs.readFile(asset.filePath))
  })
}

await app.listen({
  port,
  host: '0.0.0.0',
})

return app
}
