import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  sessionRunCommandCatalogSchema,
  sessionRunCommandDraftSchema,
  sessionRunWebsiteCatalogSchema,
  sessionRunWebsiteDraftSchema,
  type SessionRunCommand,
  type SessionRunCommandCatalog,
  type SessionRunCommandDraft,
  type SessionRunNodeRuntime,
  type SessionRunCommandShell,
  type SessionRunCommandSource,
  type SessionRunWebsite,
  type SessionRunWebsiteCatalog,
  type SessionRunWebsiteDraft,
  type SessionRunWebsiteSource,
  type SessionTerminal,
  type SessionTerminalOutput,
  type SessionTerminalOutputChunk,
  type SessionTerminalSnapshot,
} from '@panda/protocol'

const PANDA_GLOBAL_DIRECTORY_NAME = 'Project Workbench Data'
const RUN_RESOURCES_DIRECTORY_NAME = 'run-workbench'
const RUN_RESOURCE_INDEX_FILE_NAME = 'index.json'
const RUN_COMMANDS_FILE_NAME = 'commands.json'
const RUN_WEBSITES_FILE_NAME = 'websites.json'
const RUN_COMMANDS_SCHEMA_VERSION = 1
const RUN_WEBSITES_SCHEMA_VERSION = 1
const MAX_TERMINAL_CHUNKS = 1200
const MAX_TERMINAL_PREVIEW_LINES = 5
const NODE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const PYTHON_COMMAND_PATTERN = /^\s*(?:py(?:\.exe)?|python(?:\d+(?:\.\d+)?)?(?:\.exe)?)\b/i

type StoredRunCommandCatalog = {
  version: 1
  updated_at: string
  commands: SessionRunCommand[]
}

type StoredRunWebsiteCatalog = {
  version: 1
  updated_at: string
  websites: SessionRunWebsite[]
}

type StoredRunResourceIndexEntry = {
  project_id: string
  project_path: string
  project_key: string
  resource_dir: string
  updated_at: string
}

type StoredRunResourceIndex = {
  version: 1
  updated_at: string
  projects: StoredRunResourceIndexEntry[]
}

type ManagedTerminal = {
  meta: SessionTerminal
  child: ChildProcessWithoutNullStreams | null
  chunks: SessionTerminalOutputChunk[]
  baseCursor: number
  stopRequested: boolean
  removeAfterExit: boolean
  hidden: boolean
}

type ManagedTerminalState = {
  sessionId: string
  projectId: string
  terminals: Map<string, ManagedTerminal>
  order: string[]
  activeTerminalId: string | null
  updatedAt: string
}

type TerminalDeltaEvent = {
  sessionId: string
  terminal: SessionTerminal
  activeTerminalId: string | null
  chunks: SessionTerminalOutputChunk[]
  nextCursor: number
}

type SessionRunWorkbenchManagerOptions = {
  onSnapshot: (snapshot: SessionTerminalSnapshot) => void
  onDelta: (event: TerminalDeltaEvent) => void
}

const isoNow = () => new Date().toISOString()

const normalizeProjectPathKey = (projectPath: string) => {
  const resolved = path.resolve(projectPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const buildProjectStorageKey = (projectPath: string) =>
  createHash('sha1').update(normalizeProjectPathKey(projectPath)).digest('hex').slice(0, 16)

const sanitizeStorageName = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)

const resolveUserDocumentsDirectory = () => {
  const home = os.homedir()
  const userProfile = process.env.USERPROFILE?.trim() || home
  if (process.platform === 'win32') {
    const documents = process.env.PUBLIC?.trim()
      ? path.join(userProfile, 'Documents')
      : path.join(userProfile, 'Documents')
    return documents
  }

  if (process.platform === 'darwin') {
    return path.join(home, 'Documents')
  }

  const xdgDocuments = process.env.XDG_DOCUMENTS_DIR?.trim()
  if (xdgDocuments) {
    return xdgDocuments.replace(/^\$HOME\b/, home)
  }

  return path.join(home, 'Documents')
}

const resolvePandaGlobalStorageRoot = () =>
  path.join(resolveUserDocumentsDirectory(), PANDA_GLOBAL_DIRECTORY_NAME, RUN_RESOURCES_DIRECTORY_NAME)

const normalizeStoredPort = (
  value: unknown,
): number | null => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null
  }
  return value
}

const normalizePort = (
  value: number | null | undefined,
): number | null => normalizeStoredPort(value)

const normalizeUrl = (
  value: string | null | undefined,
): string => {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    throw new Error('请输入网页地址。')
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('网页地址只支持 http 或 https。')
    }
    return parsed.toString()
  } catch {
    throw new Error('网页地址格式无效。')
  }
}

const readStoredJson = async <T>(
  filePath: string,
): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const writeStoredJson = async (
  filePath: string,
  payload: unknown,
) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

const normalizeRelativeCommandCwd = (
  projectPath: string,
  cwd: string | null | undefined,
): string | null => {
  const trimmed = cwd?.trim() ?? ''
  if (!trimmed) {
    return null
  }

  const absoluteCandidate = path.resolve(projectPath, trimmed)
  const relative = path.relative(projectPath, absoluteCandidate)
  if (!relative || relative === '.') {
    return null
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('命令工作目录必须位于当前项目内。')
  }

  return relative.split(path.sep).join('/')
}

const resolveCommandAbsoluteCwd = (
  projectPath: string,
  cwd: string | null | undefined,
) => {
  const relative = normalizeRelativeCommandCwd(projectPath, cwd)
  return relative ? path.resolve(projectPath, relative) : projectPath
}

const normalizeNodeVersion = (
  value: string | null | undefined,
): string | null => {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    return null
  }
  const normalized = trimmed.replace(/^v/i, '')
  if (!NODE_VERSION_PATTERN.test(normalized)) {
    throw new Error('Node 版本格式无效，请使用 x.y.z。')
  }
  return normalized
}

const normalizeOptionalCommand = (
  value: string | null | undefined,
): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed || null
}

const compareNodeVersionsDesc = (left: string, right: string) => {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10))
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (leftPart !== rightPart) {
      return rightPart - leftPart
    }
  }
  return 0
}

const dedupeNodeVersions = (versions: string[]) =>
  [
    ...new Set(
      versions
        .map((version) => normalizeNodeVersion(version))
        .filter((version): version is string => Boolean(version)),
    ),
  ].sort(compareNodeVersionsDesc)

const resolveNvmWindowsSettingsPath = () => {
  const configuredRoot = process.env.NVM_HOME?.trim()
  if (configuredRoot) {
    return path.join(configuredRoot, 'settings.txt')
  }
  const appData = process.env.AppData?.trim()
  if (appData) {
    return path.join(appData, 'nvm', 'settings.txt')
  }
  return path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'settings.txt')
}

const resolveNvmWindowsCandidateRoots = () =>
  [
    process.env.NVM_HOME?.trim() ?? '',
    process.env.LOCALAPPDATA?.trim()
      ? path.join(process.env.LOCALAPPDATA.trim(), 'nvm')
      : '',
    process.env.AppData?.trim() ? path.join(process.env.AppData.trim(), 'nvm') : '',
    path.join(os.homedir(), 'AppData', 'Local', 'nvm'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'nvm'),
  ].filter(Boolean)

const resolveExistingNvmWindowsRoot = async () => {
  for (const candidateRoot of resolveNvmWindowsCandidateRoots()) {
    try {
      const stat = await fs.stat(candidateRoot)
      if (stat.isDirectory()) {
        return candidateRoot
      }
    } catch {
      // Try the next common nvm-windows location.
    }
  }
  return null
}

const readNvmWindowsSettings = async (): Promise<{
  root: string | null
}> => {
  const configuredRoot = process.env.NVM_HOME?.trim()
  if (configuredRoot) {
    return { root: configuredRoot }
  }

  try {
    const raw = await fs.readFile(resolveNvmWindowsSettingsPath(), 'utf8')
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf(':')
        if (separatorIndex < 0) {
          return null
        }
        return {
          key: line.slice(0, separatorIndex).trim().toLowerCase(),
          value: line.slice(separatorIndex + 1).trim(),
        }
      })
      .filter((entry): entry is { key: string; value: string } => Boolean(entry))
    const root = entries.find((entry) => entry.key === 'root')?.value?.trim() ?? ''
    return {
      root: root || null,
    }
  } catch {
    return {
      root: await resolveExistingNvmWindowsRoot(),
    }
  }
}

const readNvmWindowsVersionsFromRoot = async (root: string | null): Promise<string[]> => {
  if (!root) {
    return []
  }

  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return dedupeNodeVersions(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name)),
    )
  } catch {
    return []
  }
}

const resolveProcessPathKey = (env: NodeJS.ProcessEnv) =>
  Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'

const prependProcessPath = (
  env: NodeJS.ProcessEnv,
  entry: string,
): NodeJS.ProcessEnv => {
  const pathKey = resolveProcessPathKey(env)
  const currentPath = env[pathKey] ?? ''
  return {
    ...env,
    [pathKey]: currentPath ? `${entry}${path.delimiter}${currentPath}` : entry,
  }
}

const applyCommandRuntimeEnv = (
  command: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  if (PYTHON_COMMAND_PATTERN.test(command)) {
    return {
      ...env,
      PYTHONUNBUFFERED: '1',
    }
  }
  return env
}

const normalizeStoredRunCommand = (
  value: unknown,
): SessionRunCommand | null => {
  const parsed = sessionRunCommandCatalogSchema.shape.commands.element.safeParse(value)
  if (!parsed.success) {
    return null
  }
  return parsed.data
}

const normalizeStoredRunWebsite = (
  value: unknown,
): SessionRunWebsite | null => {
  const parsed = sessionRunWebsiteCatalogSchema.shape.websites.element.safeParse(value)
  if (!parsed.success) {
    return null
  }
  return parsed.data
}

const readStoredRunResourceIndex = async (
  storageRoot: string,
): Promise<StoredRunResourceIndex> => {
  const indexPath = path.join(storageRoot, RUN_RESOURCE_INDEX_FILE_NAME)
  const parsed = await readStoredJson<{
    version?: unknown
    updated_at?: unknown
    projects?: unknown
  }>(indexPath)
  const projects = Array.isArray(parsed?.projects)
    ? parsed.projects
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null
          }
          const candidate = entry as Partial<StoredRunResourceIndexEntry>
          const projectPath = candidate.project_path?.trim()
          const resourceDir = candidate.resource_dir?.trim()
          const projectId = candidate.project_id?.trim()
          const projectKey = candidate.project_key?.trim()
          if (!projectPath || !resourceDir || !projectId || !projectKey) {
            return null
          }
          return {
            project_id: projectId,
            project_path: path.resolve(projectPath),
            project_key: projectKey,
            resource_dir: resourceDir,
            updated_at:
              typeof candidate.updated_at === 'string' && candidate.updated_at.trim()
                ? candidate.updated_at
                : isoNow(),
          } satisfies StoredRunResourceIndexEntry
        })
        .filter((entry): entry is StoredRunResourceIndexEntry => Boolean(entry))
    : []

  return {
    version: 1,
    updated_at:
      typeof parsed?.updated_at === 'string' && parsed.updated_at.trim()
        ? parsed.updated_at
        : isoNow(),
    projects,
  }
}

const writeStoredRunResourceIndex = async (
  storageRoot: string,
  index: StoredRunResourceIndex,
) => {
  await writeStoredJson(path.join(storageRoot, RUN_RESOURCE_INDEX_FILE_NAME), index)
}

const resolveProjectRunResourcePaths = async (input: {
  projectId: string
  projectPath: string
}) => {
  const storageRoot = resolvePandaGlobalStorageRoot()
  const index = await readStoredRunResourceIndex(storageRoot)
  const normalizedProjectPath = path.resolve(input.projectPath)
  const projectKey = buildProjectStorageKey(normalizedProjectPath)
  const existingEntry = index.projects.find(
    (entry) => normalizeProjectPathKey(entry.project_path) === normalizeProjectPathKey(normalizedProjectPath),
  )
  const projectName = sanitizeStorageName(path.basename(normalizedProjectPath) || input.projectId) || input.projectId
  const resourceDir =
    existingEntry?.resource_dir?.trim() || `${projectName}-${projectKey}`
  const nextEntry: StoredRunResourceIndexEntry = {
    project_id: input.projectId,
    project_path: normalizedProjectPath,
    project_key: projectKey,
    resource_dir: resourceDir,
    updated_at: isoNow(),
  }
  const nextProjects = [
    ...index.projects.filter(
      (entry) => normalizeProjectPathKey(entry.project_path) !== normalizeProjectPathKey(normalizedProjectPath),
    ),
    nextEntry,
  ].sort((left, right) => left.project_path.localeCompare(right.project_path, 'zh-CN'))
  await writeStoredRunResourceIndex(storageRoot, {
    version: 1,
    updated_at: isoNow(),
    projects: nextProjects,
  })

  const resourceRoot = path.join(storageRoot, resourceDir)
  return {
    storageRoot,
    resourceRoot,
    commandsPath: path.join(resourceRoot, RUN_COMMANDS_FILE_NAME),
    websitesPath: path.join(resourceRoot, RUN_WEBSITES_FILE_NAME),
  }
}

const readStoredCatalog = async (
  configPath: string,
): Promise<StoredRunCommandCatalog | null> => {
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      version?: unknown
      updated_at?: unknown
      commands?: unknown
    }
    const rawCommands = Array.isArray(parsed.commands) ? parsed.commands : []
    const commands = rawCommands
      .map((entry) => normalizeStoredRunCommand(entry))
      .filter((entry): entry is SessionRunCommand => Boolean(entry))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    return {
      version: RUN_COMMANDS_SCHEMA_VERSION,
      updated_at:
        typeof parsed.updated_at === 'string' && parsed.updated_at.trim()
          ? parsed.updated_at
          : isoNow(),
      commands,
    }
  } catch {
    return null
  }
}

const readStoredWebsiteCatalog = async (
  configPath: string,
): Promise<StoredRunWebsiteCatalog | null> => {
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      version?: unknown
      updated_at?: unknown
      websites?: unknown
    }
    const rawWebsites = Array.isArray(parsed.websites) ? parsed.websites : []
    const websites = rawWebsites
      .map((entry) => normalizeStoredRunWebsite(entry))
      .filter((entry): entry is SessionRunWebsite => Boolean(entry))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    return {
      version: RUN_WEBSITES_SCHEMA_VERSION,
      updated_at:
        typeof parsed.updated_at === 'string' && parsed.updated_at.trim()
          ? parsed.updated_at
          : isoNow(),
      websites,
    }
  } catch {
    return null
  }
}

const writeStoredCatalog = async (
  configPath: string,
  commands: SessionRunCommand[],
) => {
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const payload: StoredRunCommandCatalog = {
    version: RUN_COMMANDS_SCHEMA_VERSION,
    updated_at: isoNow(),
    commands,
  }
  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

const writeStoredWebsiteCatalog = async (
  configPath: string,
  websites: SessionRunWebsite[],
) => {
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const payload: StoredRunWebsiteCatalog = {
    version: RUN_WEBSITES_SCHEMA_VERSION,
    updated_at: isoNow(),
    websites,
  }
  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

const sanitizeRunCommandDraft = (
  projectPath: string,
  draft: SessionRunCommandDraft,
): SessionRunCommandDraft => {
  const parsed = sessionRunCommandDraftSchema.parse(draft)
  const name = parsed.name.trim()
  const command = parsed.command.trim()
  if (!name) {
    throw new Error('请输入命令名称。')
  }
  if (!command) {
    throw new Error('请输入要执行的命令。')
  }

  return {
    ...parsed,
    name,
    command,
    kill_command: normalizeOptionalCommand(parsed.kill_command),
    description: parsed.description?.trim() || null,
    cwd: normalizeRelativeCommandCwd(projectPath, parsed.cwd),
    node_version: normalizeNodeVersion(parsed.node_version),
    port: normalizePort(parsed.port),
  }
}

const sanitizeRunWebsiteDraft = (
  draft: SessionRunWebsiteDraft,
): SessionRunWebsiteDraft => {
  const parsed = sessionRunWebsiteDraftSchema.parse(draft)
  const name = parsed.name.trim()
  if (!name) {
    throw new Error('请输入网页名称。')
  }

  return {
    ...parsed,
    name,
    description: parsed.description?.trim() || null,
    url: normalizeUrl(parsed.url),
  }
}

const createRunCommand = (
  projectPath: string,
  draft: SessionRunCommandDraft,
  source: SessionRunCommandSource,
): SessionRunCommand => {
  const now = isoNow()
  const sanitized = sanitizeRunCommandDraft(projectPath, draft)
  return {
    id: `run-command-${randomUUID()}`,
    name: sanitized.name,
    description: sanitized.description,
    command: sanitized.command,
    kill_command: sanitized.kill_command,
    cwd: sanitized.cwd,
    shell: sanitized.shell,
    node_version: sanitized.node_version,
    port: sanitized.port,
    source,
    created_at: now,
    updated_at: now,
  }
}

const updateRunCommand = (
  current: SessionRunCommand,
  projectPath: string,
  draft: SessionRunCommandDraft,
): SessionRunCommand => {
  const sanitized = sanitizeRunCommandDraft(projectPath, draft)
  return {
    ...current,
    name: sanitized.name,
    description: sanitized.description,
    command: sanitized.command,
    kill_command: sanitized.kill_command,
    cwd: sanitized.cwd,
    shell: sanitized.shell,
    node_version: sanitized.node_version,
    port: sanitized.port,
    updated_at: isoNow(),
  }
}

const createRunWebsite = (
  draft: SessionRunWebsiteDraft,
  source: SessionRunWebsiteSource,
): SessionRunWebsite => {
  const now = isoNow()
  const sanitized = sanitizeRunWebsiteDraft(draft)
  return {
    id: `run-website-${randomUUID()}`,
    name: sanitized.name,
    description: sanitized.description,
    url: sanitized.url,
    source,
    created_at: now,
    updated_at: now,
  }
}

const updateRunWebsite = (
  current: SessionRunWebsite,
  draft: SessionRunWebsiteDraft,
): SessionRunWebsite => {
  const sanitized = sanitizeRunWebsiteDraft(draft)
  return {
    ...current,
    name: sanitized.name,
    description: sanitized.description,
    url: sanitized.url,
    updated_at: isoNow(),
  }
}

export const readProjectRunCommandCatalog = async (input: {
  sessionId: string
  projectId: string
  projectPath: string
}): Promise<SessionRunCommandCatalog> => {
  const { commandsPath } = await resolveProjectRunResourcePaths({
    projectId: input.projectId,
    projectPath: input.projectPath,
  })
  const configPath = commandsPath
  const stored = await readStoredCatalog(configPath)
  const payload = stored ?? {
    version: RUN_COMMANDS_SCHEMA_VERSION,
    updated_at: isoNow(),
    commands: [],
  }
  return {
    session_id: input.sessionId,
    project_id: input.projectId,
    config_path: configPath,
    commands: payload.commands,
    updated_at: payload.updated_at,
  }
}

export const readProjectRunWebsiteCatalog = async (input: {
  sessionId: string
  projectId: string
  projectPath: string
}): Promise<SessionRunWebsiteCatalog> => {
  const { websitesPath } = await resolveProjectRunResourcePaths({
    projectId: input.projectId,
    projectPath: input.projectPath,
  })
  const configPath = websitesPath
  const stored = await readStoredWebsiteCatalog(configPath)
  const payload = stored ?? {
    version: RUN_WEBSITES_SCHEMA_VERSION,
    updated_at: isoNow(),
    websites: [],
  }
  return {
    session_id: input.sessionId,
    project_id: input.projectId,
    config_path: configPath,
    websites: payload.websites,
    updated_at: payload.updated_at,
  }
}

export const readSessionRunNodeRuntime = async (): Promise<SessionRunNodeRuntime> => {
  const currentVersion = normalizeNodeVersion(process.version) ?? null
  if (process.platform !== 'win32') {
    return {
      manager: 'none',
      versions: currentVersion ? [currentVersion] : [],
      error: null,
    }
  }

  const settings = await readNvmWindowsSettings()
  const versionsFromRoot = await readNvmWindowsVersionsFromRoot(settings.root)
  const versions = dedupeNodeVersions(
    currentVersion ? [currentVersion, ...versionsFromRoot] : versionsFromRoot,
  )
  return {
    manager: settings.root ? 'nvm-windows' : 'none',
    versions,
    error: null,
  }
}

export const saveProjectRunCommand = async (input: {
  sessionId: string
  projectId: string
  projectPath: string
  action: 'create' | 'update' | 'delete'
  commandId?: string | null
  command?: SessionRunCommandDraft | null
  source?: SessionRunCommandSource
}): Promise<SessionRunCommandCatalog> => {
  const { commandsPath } = await resolveProjectRunResourcePaths({
    projectId: input.projectId,
    projectPath: input.projectPath,
  })
  const configPath = commandsPath
  const stored = await readStoredCatalog(configPath)
  const currentCommands = [...(stored?.commands ?? [])]

  if (input.action === 'create') {
    if (!input.command) {
      throw new Error('缺少命令内容。')
    }
    currentCommands.push(
      createRunCommand(input.projectPath, input.command, input.source ?? 'user'),
    )
  } else if (input.action === 'update') {
    const commandId = input.commandId?.trim() ?? ''
    if (!commandId) {
      throw new Error('缺少要更新的命令 ID。')
    }
    if (!input.command) {
      throw new Error('缺少命令内容。')
    }
    const commandIndex = currentCommands.findIndex((item) => item.id === commandId)
    if (commandIndex < 0) {
      throw new Error('目标命令不存在。')
    }
    currentCommands[commandIndex] = updateRunCommand(
      currentCommands[commandIndex]!,
      input.projectPath,
      input.command,
    )
  } else {
    const commandId = input.commandId?.trim() ?? ''
    if (!commandId) {
      throw new Error('缺少要删除的命令 ID。')
    }
    const nextCommands = currentCommands.filter((item) => item.id !== commandId)
    if (nextCommands.length === currentCommands.length) {
      throw new Error('目标命令不存在。')
    }
    currentCommands.length = 0
    currentCommands.push(...nextCommands)
  }

  const nextStored = await writeStoredCatalog(
    configPath,
    currentCommands.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
  )
  return {
    session_id: input.sessionId,
    project_id: input.projectId,
    config_path: configPath,
    commands: nextStored.commands,
    updated_at: nextStored.updated_at,
  }
}

export const replaceGeneratedProjectRunCommands = async (input: {
  sessionId: string
  projectId: string
  projectPath: string
  commands: SessionRunCommandDraft[]
}): Promise<SessionRunCommandCatalog> => {
  const { commandsPath } = await resolveProjectRunResourcePaths({
    projectId: input.projectId,
    projectPath: input.projectPath,
  })
  const configPath = commandsPath
  const stored = await readStoredCatalog(configPath)
  const preservedCommands = (stored?.commands ?? []).filter((item) => item.source !== 'codex')
  const generatedCommands = input.commands.map((command) =>
    createRunCommand(input.projectPath, command, 'codex'))
  const nextStored = await writeStoredCatalog(
    configPath,
    [...preservedCommands, ...generatedCommands].sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-CN')),
  )
  return {
    session_id: input.sessionId,
    project_id: input.projectId,
    config_path: configPath,
    commands: nextStored.commands,
    updated_at: nextStored.updated_at,
  }
}

export const saveProjectRunWebsite = async (input: {
  sessionId: string
  projectId: string
  projectPath: string
  action: 'create' | 'update' | 'delete'
  websiteId?: string | null
  website?: SessionRunWebsiteDraft | null
  source?: SessionRunWebsiteSource
}): Promise<SessionRunWebsiteCatalog> => {
  const { websitesPath } = await resolveProjectRunResourcePaths({
    projectId: input.projectId,
    projectPath: input.projectPath,
  })
  const configPath = websitesPath
  const stored = await readStoredWebsiteCatalog(configPath)
  const currentWebsites = [...(stored?.websites ?? [])]

  if (input.action === 'create') {
    if (!input.website) {
      throw new Error('缺少网页内容。')
    }
    currentWebsites.push(
      createRunWebsite(input.website, input.source ?? 'user'),
    )
  } else if (input.action === 'update') {
    const websiteId = input.websiteId?.trim() ?? ''
    if (!websiteId) {
      throw new Error('缺少要更新的网页 ID。')
    }
    if (!input.website) {
      throw new Error('缺少网页内容。')
    }
    const websiteIndex = currentWebsites.findIndex((item) => item.id === websiteId)
    if (websiteIndex < 0) {
      throw new Error('目标网页不存在。')
    }
    currentWebsites[websiteIndex] = updateRunWebsite(
      currentWebsites[websiteIndex]!,
      input.website,
    )
  } else {
    const websiteId = input.websiteId?.trim() ?? ''
    if (!websiteId) {
      throw new Error('缺少要删除的网页 ID。')
    }
    const nextWebsites = currentWebsites.filter((item) => item.id !== websiteId)
    if (nextWebsites.length === currentWebsites.length) {
      throw new Error('目标网页不存在。')
    }
    currentWebsites.length = 0
    currentWebsites.push(...nextWebsites)
  }

  const nextStored = await writeStoredWebsiteCatalog(
    configPath,
    currentWebsites.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
  )
  return {
    session_id: input.sessionId,
    project_id: input.projectId,
    config_path: configPath,
    websites: nextStored.websites,
    updated_at: nextStored.updated_at,
  }
}

export const replaceGeneratedProjectRunWebsites = async (input: {
  sessionId: string
  projectId: string
  projectPath: string
  websites: SessionRunWebsiteDraft[]
}): Promise<SessionRunWebsiteCatalog> => {
  const { websitesPath } = await resolveProjectRunResourcePaths({
    projectId: input.projectId,
    projectPath: input.projectPath,
  })
  const configPath = websitesPath
  const stored = await readStoredWebsiteCatalog(configPath)
  const preservedWebsites = (stored?.websites ?? []).filter((item) => item.source !== 'codex')
  const generatedWebsites = input.websites.map((website) =>
    createRunWebsite(website, 'codex'))
  const nextStored = await writeStoredWebsiteCatalog(
    configPath,
    [...preservedWebsites, ...generatedWebsites].sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-CN')),
  )
  return {
    session_id: input.sessionId,
    project_id: input.projectId,
    config_path: configPath,
    websites: nextStored.websites,
    updated_at: nextStored.updated_at,
  }
}

export const resolveRunCommandExecution = async (
  projectPath: string,
  command: SessionRunCommand,
  options?: {
    overrideCommand?: string | null
  },
): Promise<{
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  launch_error: string | null
  runtime_node_version: string | null
  shell: boolean | string
}> => {
  const resolvedCommand = options?.overrideCommand?.trim() || command.command.trim()
  if (!resolvedCommand) {
    throw new Error('缺少要执行的命令。')
  }
  const cwd = resolveCommandAbsoluteCwd(projectPath, command.cwd)
  const shell = resolveTerminalShell(command.shell)
  const baseEnv = applyCommandRuntimeEnv(resolvedCommand, process.env)
  let nodeVersion: string | null
  try {
    nodeVersion = normalizeNodeVersion(command.node_version)
  } catch (error) {
    return {
      command: resolvedCommand,
      cwd,
      env: baseEnv,
      launch_error: error instanceof Error ? error.message : 'Node 环境配置无效。',
      runtime_node_version: command.node_version?.trim() || null,
      shell,
    }
  }

  if (!nodeVersion) {
    return {
      command: resolvedCommand,
      cwd,
      env: baseEnv,
      launch_error: null,
      runtime_node_version: null,
      shell,
    }
  }

  if (process.platform !== 'win32') {
    return {
      command: resolvedCommand,
      cwd,
      env: baseEnv,
      launch_error: `Node ${nodeVersion} 环境注入当前仅支持 Windows + nvm-windows。已保持全局 PATH 不变。`,
      runtime_node_version: nodeVersion,
      shell,
    }
  }

  const settings = await readNvmWindowsSettings()
  if (!settings.root) {
    return {
      command: resolvedCommand,
      cwd,
      env: baseEnv,
      launch_error: `Node ${nodeVersion} 环境注入失败：未检测到 nvm-windows 根目录。已保持全局 PATH 不变。`,
      runtime_node_version: nodeVersion,
      shell,
    }
  }

  const nodeDirectory = path.join(settings.root, `v${nodeVersion}`)
  try {
    await fs.access(path.join(nodeDirectory, 'node.exe'))
  } catch {
    return {
      command: resolvedCommand,
      cwd,
      env: baseEnv,
      launch_error: `Node ${nodeVersion} 环境注入失败：未在 nvm 中找到该版本。已保持全局 PATH 不变。`,
      runtime_node_version: nodeVersion,
      shell,
    }
  }

  return {
    command: resolvedCommand,
    cwd,
    env: prependProcessPath(baseEnv, nodeDirectory),
    launch_error: null,
    runtime_node_version: nodeVersion,
    shell,
  }
}

const resolveTerminalShell = (shell: SessionRunCommandShell): boolean | string => {
  if (shell === 'powershell') {
    return process.env.PANDA_POWERSHELL_PATH?.trim() || 'pwsh.exe'
  }
  if (shell === 'cmd') {
    return process.env.ComSpec?.trim() || 'cmd.exe'
  }
  if (shell === 'bash') {
    return process.platform === 'win32'
      ? (process.env.PANDA_BASH_PATH?.trim() || 'bash.exe')
      : (process.env.SHELL?.trim() || '/bin/bash')
  }
  return true
}

const getSessionStateSnapshot = (state: ManagedTerminalState): SessionTerminalSnapshot => ({
  session_id: state.sessionId,
  project_id: state.projectId,
  active_terminal_id: state.activeTerminalId,
  terminals: state.order
    .map((terminalId) => {
      const terminal = state.terminals.get(terminalId)
      if (!terminal || terminal.hidden) {
        return null
      }
      return terminal.meta
    })
    .filter((terminal): terminal is SessionTerminal => Boolean(terminal)),
  updated_at: state.updatedAt,
})

const buildTerminalPreview = (chunks: SessionTerminalOutputChunk[]) => {
  const lines = chunks
    .flatMap((chunk) => chunk.text.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return null
  }
  return lines.slice(-MAX_TERMINAL_PREVIEW_LINES).join('\n')
}

const terminateChildProcess = (child: ChildProcessWithoutNullStreams | null) => {
  if (!child?.pid) {
    return
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.unref()
    return
  }

  try {
    child.kill('SIGTERM')
  } catch {
    // Ignore process termination errors.
  }
}

export const createSessionRunWorkbenchManager = (
  options: SessionRunWorkbenchManagerOptions,
) => {
  const states = new Map<string, ManagedTerminalState>()

  const ensureState = (sessionId: string, projectId: string) => {
    const existing = states.get(sessionId)
    if (existing) {
      return existing
    }
    const created: ManagedTerminalState = {
      sessionId,
      projectId,
      terminals: new Map(),
      order: [],
      activeTerminalId: null,
      updatedAt: isoNow(),
    }
    states.set(sessionId, created)
    return created
  }

  const emitSnapshot = (state: ManagedTerminalState) => {
    state.updatedAt = isoNow()
    options.onSnapshot(getSessionStateSnapshot(state))
  }

  const emitDelta = (
    state: ManagedTerminalState,
    terminal: ManagedTerminal,
    chunks: SessionTerminalOutputChunk[],
  ) => {
    if (terminal.hidden) {
      return
    }

    options.onDelta({
      sessionId: state.sessionId,
      terminal: terminal.meta,
      activeTerminalId: state.activeTerminalId,
      chunks,
      nextCursor: terminal.meta.output_cursor,
    })
  }

  const removeTerminal = (
    state: ManagedTerminalState,
    terminalId: string,
  ) => {
    state.terminals.delete(terminalId)
    state.order = state.order.filter((item) => item !== terminalId)
    if (state.activeTerminalId === terminalId) {
      state.activeTerminalId = state.order[0] ?? null
    }
    emitSnapshot(state)
  }

  const hideTerminal = (
    state: ManagedTerminalState,
    terminalId: string,
  ) => {
    state.order = state.order.filter((item) => item !== terminalId)
    if (state.activeTerminalId === terminalId) {
      state.activeTerminalId = state.order[0] ?? null
    }
    emitSnapshot(state)
  }

  const appendChunks = (
    state: ManagedTerminalState,
    terminal: ManagedTerminal,
    stream: SessionTerminalOutputChunk['stream'],
    text: string,
  ) => {
    if (!text) {
      return
    }

    const timestamp = isoNow()
    const chunk: SessionTerminalOutputChunk = {
      cursor: terminal.baseCursor + terminal.chunks.length,
      stream,
      text,
      timestamp,
    }
    terminal.chunks.push(chunk)
    while (terminal.chunks.length > MAX_TERMINAL_CHUNKS) {
      terminal.chunks.shift()
      terminal.baseCursor += 1
    }

    terminal.meta.last_output_at = timestamp
    terminal.meta.updated_at = timestamp
    terminal.meta.output_cursor = terminal.baseCursor + terminal.chunks.length
    terminal.meta.preview = buildTerminalPreview(terminal.chunks)
    emitDelta(state, terminal, [chunk])
  }

  const finalizeTerminal = (
    state: ManagedTerminalState,
    terminal: ManagedTerminal,
    nextStatus: SessionTerminal['status'],
    exitCode: number | null,
  ) => {
    const timestamp = isoNow()
    terminal.child = null
    terminal.meta.status = nextStatus
    terminal.meta.exit_code = exitCode
    terminal.meta.completed_at = timestamp
    terminal.meta.updated_at = timestamp
    terminal.meta.output_cursor = terminal.baseCursor + terminal.chunks.length
    emitDelta(state, terminal, [])
    if (terminal.removeAfterExit) {
      removeTerminal(state, terminal.meta.id)
      return
    }
    emitSnapshot(state)
  }

  return {
    getSnapshot: (input: { sessionId: string; projectId: string }): SessionTerminalSnapshot =>
      getSessionStateSnapshot(ensureState(input.sessionId, input.projectId)),
    getOutput: (input: {
      sessionId: string
      projectId: string
      terminalId: string
      cursor?: number
    }): SessionTerminalOutput => {
      const state = ensureState(input.sessionId, input.projectId)
      const terminal = state.terminals.get(input.terminalId)
      if (!terminal) {
        throw new Error('终端会话不存在。')
      }

      const requestedCursor =
        typeof input.cursor === 'number' && Number.isFinite(input.cursor)
          ? Math.max(0, Math.floor(input.cursor))
          : 0
      const truncated = requestedCursor < terminal.baseCursor
      const chunks = truncated
        ? terminal.chunks
        : terminal.chunks.filter((chunk) => chunk.cursor >= requestedCursor)

      return {
        session_id: state.sessionId,
        project_id: state.projectId,
        terminal: terminal.meta,
        chunks,
        next_cursor: terminal.meta.output_cursor,
        truncated,
      }
    },
    focusTerminal: (input: {
      sessionId: string
      projectId: string
      terminalId: string
    }): SessionTerminalSnapshot => {
      const state = ensureState(input.sessionId, input.projectId)
      if (!state.terminals.has(input.terminalId)) {
        throw new Error('目标终端不存在。')
      }
      state.activeTerminalId = input.terminalId
      emitSnapshot(state)
      return getSessionStateSnapshot(state)
    },
    stopTerminal: (input: {
      sessionId: string
      projectId: string
      terminalId: string
    }): SessionTerminalSnapshot => {
      const state = ensureState(input.sessionId, input.projectId)
      const terminal = state.terminals.get(input.terminalId)
      if (!terminal) {
        throw new Error('目标终端不存在。')
      }
      if (terminal.child) {
        terminal.stopRequested = true
        appendChunks(state, terminal, 'system', '\n[system] 正在停止进程…\n')
        terminateChildProcess(terminal.child)
      }
      emitSnapshot(state)
      return getSessionStateSnapshot(state)
    },
    closeTerminal: (input: {
      sessionId: string
      projectId: string
      terminalId: string
    }): SessionTerminalSnapshot => {
      const state = ensureState(input.sessionId, input.projectId)
      const terminal = state.terminals.get(input.terminalId)
      if (!terminal) {
        throw new Error('目标终端不存在。')
      }
      if (terminal.child) {
        terminal.stopRequested = true
        terminal.removeAfterExit = true
        terminal.hidden = true
        terminateChildProcess(terminal.child)
        hideTerminal(state, input.terminalId)
      } else {
        removeTerminal(state, input.terminalId)
      }
      return getSessionStateSnapshot(state)
    },
    runCommand: (input: {
      sessionId: string
      projectId: string
      commandId: string | null
      title: string
      command: string
      cwd: string
      env?: NodeJS.ProcessEnv
      launchError?: string | null
      runtimeNodeVersion?: string | null
      shell: boolean | string
    }): {
      snapshot: SessionTerminalSnapshot
      terminal: SessionTerminal
    } => {
      const state = ensureState(input.sessionId, input.projectId)
      const timestamp = isoNow()
      const terminalId = `terminal-${randomUUID()}`
      const managed: ManagedTerminal = {
        meta: {
          id: terminalId,
          session_id: input.sessionId,
          project_id: input.projectId,
          command_id: input.commandId,
          title: input.title,
          command: input.command,
          cwd: input.cwd,
          status: 'queued',
          exit_code: null,
          created_at: timestamp,
          started_at: null,
          completed_at: null,
          updated_at: timestamp,
          last_output_at: null,
          output_cursor: 0,
          preview: null,
        },
        child: null,
        chunks: [],
        baseCursor: 0,
        stopRequested: false,
        removeAfterExit: false,
        hidden: false,
      }

      state.terminals.set(terminalId, managed)
      state.order = [terminalId, ...state.order]
      state.activeTerminalId = terminalId
      emitSnapshot(state)

      appendChunks(state, managed, 'system', `$ ${input.command}\n`)
      if (input.runtimeNodeVersion && !input.launchError) {
        appendChunks(
          state,
          managed,
          'system',
          `[system] 已注入 Node ${input.runtimeNodeVersion} 临时环境，仅当前命令生效，不修改全局 PATH。\n`,
        )
      }

      if (input.launchError) {
        appendChunks(state, managed, 'system', `\n[error] ${input.launchError}\n`)
        finalizeTerminal(state, managed, 'failed', null)
        return {
          snapshot: getSessionStateSnapshot(state),
          terminal: managed.meta,
        }
      }

      const child = spawn(input.command, {
        cwd: input.cwd,
        env: input.env ?? process.env,
        shell: input.shell,
        stdio: 'pipe',
        windowsHide: true,
      })
      managed.child = child
      managed.meta.status = 'running'
      managed.meta.started_at = isoNow()
      managed.meta.updated_at = managed.meta.started_at
      emitSnapshot(state)

      let hasFinalized = false
      let hasRuntimeRestoreMessage = false
      const appendRuntimeRestoreMessage = () => {
        if (!input.runtimeNodeVersion || hasRuntimeRestoreMessage) {
          return
        }
        hasRuntimeRestoreMessage = true
        appendChunks(
          state,
          managed,
          'system',
          `[system] Node ${input.runtimeNodeVersion} 临时环境已结束，全局 PATH 未被修改。\n`,
        )
      }
      const finalizeOnce = (
        nextStatus: SessionTerminal['status'],
        exitCode: number | null,
      ) => {
        if (hasFinalized) {
          return
        }
        hasFinalized = true
        finalizeTerminal(state, managed, nextStatus, exitCode)
      }

      child.stdout.on('data', (chunk) => {
        appendChunks(state, managed, 'stdout', chunk.toString('utf8'))
      })
      child.stderr.on('data', (chunk) => {
        appendChunks(state, managed, 'stderr', chunk.toString('utf8'))
      })
      child.on('error', (error) => {
        appendChunks(
          state,
          managed,
          'system',
          `\n[error] ${error instanceof Error ? error.message : '命令启动失败。'}\n`,
        )
        appendRuntimeRestoreMessage()
        finalizeOnce(managed.stopRequested ? 'stopped' : 'failed', null)
      })
      child.on('close', (code) => {
        const nextStatus = managed.stopRequested
          ? 'stopped'
          : code === 0
            ? 'completed'
            : 'failed'
        if (managed.stopRequested) {
          appendChunks(state, managed, 'system', '\n[system] 终端已停止。\n')
        } else if (code === 0) {
          appendChunks(state, managed, 'system', '\n[system] 运行完成。\n')
        } else {
          appendChunks(
            state,
            managed,
            'system',
            `\n[system] 进程退出，退出码 ${code ?? 'unknown'}。\n`,
          )
        }
        appendRuntimeRestoreMessage()
        finalizeOnce(nextStatus, code ?? null)
      })

      return {
        snapshot: getSessionStateSnapshot(state),
        terminal: managed.meta,
      }
    },
  }
}
