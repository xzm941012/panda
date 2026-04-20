import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  devManagerConfigSchema,
  devManagerJobSchema,
  type DevManagerActionResponse,
  type DevManagerConfig,
  type DevManagerConfigUpdate,
  type DevManagerJob,
  type DevManagerJobKind,
  type DevManagerLogLevel,
  type DevManagerSnapshot,
} from '@panda/protocol'
import {
  readSessionRunNodeRuntime,
  resolveRunCommandExecution,
} from './session-run-workbench'

type DevManagerLogger = {
  info: (payload: Record<string, unknown>, message: string) => void
  warn: (payload: Record<string, unknown>, message: string) => void
  error: (payload: Record<string, unknown>, message: string) => void
}

type DevManagerOptions = {
  codexHome: string
  logger: DevManagerLogger
}

type StoredCredentials = {
  npm_token: string | null
}

type ManagedCommandSpec = {
  title: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  shell: boolean | string
  launchError: string | null
  runtimeNodeVersion: string | null
}

const MANAGED_ENV_PASSTHROUGH_KEYS = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMPUTERNAME',
  'ComSpec',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PUBLIC',
  'SYSTEMDRIVE',
  'SystemDrive',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const

const MANAGED_ENV_STRIP_PREFIXES = [
  'npm_config_',
  'NPM_CONFIG_',
  'TSX_',
  'VSCODE_',
  'ELECTRON_',
] as const

const MANAGED_ENV_STRIP_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_INSPECT_RESUME_ON_START',
  'npm_config_userconfig',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_registry',
  'NPM_CONFIG_REGISTRY',
])

type ServiceRuntimeSpec = {
  key: 'dev-hub' | 'dev-agent' | 'dev-web' | 'release-hub' | 'release-agent'
  label: string
  port: number | null
  probeUrl: string | null
  probePath: '/' | '/health'
  serviceName?: string | null
  start?: () => Promise<ManagedCommandSpec>
}

type JobController = {
  append: (level: DevManagerLogLevel, message: string) => Promise<void>
  succeed: (summary: string) => Promise<DevManagerJob>
  fail: (error: string) => Promise<DevManagerJob>
  readCurrent: () => DevManagerJob
}

type ManagedServiceProcessState = Partial<
  Record<
    ServiceRuntimeSpec['key'],
    {
      root_pid: number
      started_at: string
      command: string
    }
  >
>

const DEV_MANAGER_RELATIVE_ROOT = path.join('state', 'panda', 'dev-manager')
const CONFIG_FILE_NAME = 'config.json'
const CREDENTIALS_FILE_NAME = 'credentials.json'
const SERVICE_PIDS_FILE_NAME = 'service-pids.json'
const JOBS_DIRECTORY_NAME = 'jobs'
const HELPERS_DIRECTORY_NAME = 'helpers'
const MAX_JOB_LOGS = 320
const MAX_VISIBLE_JOBS = 8
const LOCALHOST = '127.0.0.1'
const RELEASE_PACKAGE_NAME = '@jamiexiongr/panda'
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/'
const GLOBAL_COMMAND_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_MS = 2_500
const PORT_PROBE_TIMEOUT_MS = 900
const START_PROBE_TIMEOUT_MS = 18_000
const RELEASE_RESTART_PROBE_TIMEOUT_MS = 24_000
const RELEASE_RESTART_DELAY_MS = 1_500
const SNAPSHOT_NODE_RUNTIME_CACHE_MS = 30_000
const SNAPSHOT_PACKAGE_VERSION_CACHE_MS = 30_000
const SNAPSHOT_APK_ARTIFACT_CACHE_MS = 10_000

const isoNow = () => new Date().toISOString()

const defaultConfig = (): DevManagerConfig => ({
  repo_path: null,
  nvm_version: null,
  dev_hub_port: 4344,
  dev_hub_args: '',
  dev_agent_port: 4243,
  dev_agent_hub_url: `http://${LOCALHOST}:4344`,
  dev_agent_direct_base_url: `http://${LOCALHOST}:4243`,
  dev_agent_ws_base_url: `ws://${LOCALHOST}:4243/ws`,
  dev_agent_name: '',
  dev_agent_args: '',
  dev_web_port: 4173,
  dev_web_hub_url: `http://${LOCALHOST}:4344`,
  dev_web_args: '',
  release_hub_port: 4343,
  release_hub_service_name: 'PandaHub',
  release_hub_args: '',
  release_agent_port: 4242,
  release_agent_service_name: 'PandaAgent',
  release_agent_hub_url: `http://${LOCALHOST}:4343`,
  release_agent_direct_base_url: `http://${LOCALHOST}:4242`,
  release_agent_ws_base_url: `ws://${LOCALHOST}:4242/ws`,
  release_agent_name: '',
  release_agent_args: '',
  updated_at: null,
})

const resolveStateRoot = (codexHome: string) =>
  path.join(codexHome, DEV_MANAGER_RELATIVE_ROOT)

const resolveConfigPath = (codexHome: string) =>
  path.join(resolveStateRoot(codexHome), CONFIG_FILE_NAME)

const resolveCredentialsPath = (codexHome: string) =>
  path.join(resolveStateRoot(codexHome), CREDENTIALS_FILE_NAME)

const resolveServicePidsPath = (codexHome: string) =>
  path.join(resolveStateRoot(codexHome), SERVICE_PIDS_FILE_NAME)

const resolveJobsDirectory = (codexHome: string) =>
  path.join(resolveStateRoot(codexHome), JOBS_DIRECTORY_NAME)

const resolveHelperDirectory = (codexHome: string) =>
  path.join(resolveStateRoot(codexHome), HELPERS_DIRECTORY_NAME)

const normalizePort = (
  value: number | null | undefined,
  fallback: number | null,
) => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }
  return fallback
}

const normalizeText = (value: string | null | undefined) => value?.trim() ?? ''

const normalizeNullableText = (value: string | null | undefined) => {
  const normalized = normalizeText(value)
  return normalized || null
}

const buildHttpBaseUrl = (port: number | null, fallback: string) =>
  port ? `http://${LOCALHOST}:${port}` : fallback

const buildWsBaseUrl = (port: number | null, fallback: string) =>
  port ? `ws://${LOCALHOST}:${port}/ws` : fallback

const normalizeConfig = (
  input: Partial<DevManagerConfig> | null | undefined,
): DevManagerConfig => {
  const defaults = defaultConfig()
  const devHubPort = normalizePort(input?.dev_hub_port, defaults.dev_hub_port)
  const devAgentPort = normalizePort(input?.dev_agent_port, defaults.dev_agent_port)
  const devWebPort = normalizePort(input?.dev_web_port, defaults.dev_web_port)
  const releaseHubPort = normalizePort(input?.release_hub_port, defaults.release_hub_port)
  const releaseAgentPort = normalizePort(input?.release_agent_port, defaults.release_agent_port)
  const repoPath = normalizeNullableText(input?.repo_path)
  const updatedAt = normalizeNullableText(input?.updated_at)

  return devManagerConfigSchema.parse({
    repo_path: repoPath ? path.resolve(repoPath) : null,
    nvm_version: normalizeNullableText(input?.nvm_version),
    dev_hub_port: devHubPort,
    dev_hub_args: normalizeText(input?.dev_hub_args),
    dev_agent_port: devAgentPort,
    dev_agent_hub_url:
      normalizeText(input?.dev_agent_hub_url) ||
      buildHttpBaseUrl(devHubPort, defaults.dev_agent_hub_url),
    dev_agent_direct_base_url:
      normalizeText(input?.dev_agent_direct_base_url) ||
      buildHttpBaseUrl(devAgentPort, defaults.dev_agent_direct_base_url),
    dev_agent_ws_base_url:
      normalizeText(input?.dev_agent_ws_base_url) ||
      buildWsBaseUrl(devAgentPort, defaults.dev_agent_ws_base_url),
    dev_agent_name: normalizeText(input?.dev_agent_name),
    dev_agent_args: normalizeText(input?.dev_agent_args),
    dev_web_port: devWebPort,
    dev_web_hub_url:
      normalizeText(input?.dev_web_hub_url) ||
      buildHttpBaseUrl(devHubPort, defaults.dev_web_hub_url),
    dev_web_args: normalizeText(input?.dev_web_args),
    release_hub_port: releaseHubPort,
    release_hub_service_name:
      normalizeText(input?.release_hub_service_name) || defaults.release_hub_service_name,
    release_hub_args: normalizeText(input?.release_hub_args),
    release_agent_port: releaseAgentPort,
    release_agent_service_name:
      normalizeText(input?.release_agent_service_name) || defaults.release_agent_service_name,
    release_agent_hub_url:
      normalizeText(input?.release_agent_hub_url) ||
      buildHttpBaseUrl(releaseHubPort, defaults.release_agent_hub_url),
    release_agent_direct_base_url:
      normalizeText(input?.release_agent_direct_base_url) ||
      buildHttpBaseUrl(releaseAgentPort, defaults.release_agent_direct_base_url),
    release_agent_ws_base_url:
      normalizeText(input?.release_agent_ws_base_url) ||
      buildWsBaseUrl(releaseAgentPort, defaults.release_agent_ws_base_url),
    release_agent_name: normalizeText(input?.release_agent_name),
    release_agent_args: normalizeText(input?.release_agent_args),
    updated_at: updatedAt,
  })
}

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const writeJsonFile = async (filePath: string, payload: unknown) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

const ensureDirectory = async (targetPath: string) => {
  await fs.mkdir(targetPath, { recursive: true })
}

const validateRepoPath = async (repoPath: string | null) => {
  if (!repoPath) {
    return
  }

  const stat = await fs.stat(repoPath).catch(() => null)
  if (!stat?.isDirectory()) {
    throw new Error('开发版代码路径不存在，或不是一个目录。')
  }
}

const maskTokenHint = (token: string | null) => {
  const normalized = normalizeText(token)
  if (!normalized) {
    return null
  }
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}***${normalized.slice(-1)}`
  }
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`
}

const buildJobFilePath = (codexHome: string, jobId: string) =>
  path.join(resolveJobsDirectory(codexHome), `${jobId}.json`)

const readStoredJob = async (filePath: string): Promise<DevManagerJob | null> => {
  const payload = await readJsonFile<unknown>(filePath)
  const parsed = devManagerJobSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

const readAllJobs = async (codexHome: string) => {
  const jobsDirectory = resolveJobsDirectory(codexHome)
  const entries = await fs.readdir(jobsDirectory, { withFileTypes: true }).catch(() => [])
  const jobs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readStoredJob(path.join(jobsDirectory, entry.name))),
  )
  return jobs
    .filter((job): job is DevManagerJob => Boolean(job))
    .sort((left, right) => +new Date(right.created_at) - +new Date(left.created_at))
}

const createJobLogEntry = (level: DevManagerLogLevel, message: string) => ({
  id: `dev-manager-log-${randomUUID()}`,
  timestamp: isoNow(),
  level,
  message,
})

const createManagedJob = (
  kind: DevManagerJobKind,
  title: string,
  options?: { disconnectExpected?: boolean },
): DevManagerJob =>
  devManagerJobSchema.parse({
    id: `dev-manager-job-${randomUUID()}`,
    kind,
    title,
    status: 'running',
    created_at: isoNow(),
    started_at: isoNow(),
    finished_at: null,
    summary: null,
    error: null,
    disconnect_expected: options?.disconnectExpected === true,
    logs: [],
  })

const buildShellCommand = (
  baseCommand: string,
  extraArgs: string | null | undefined,
  options?: { pnpmScript?: boolean },
) => {
  const normalizedExtraArgs = normalizeText(extraArgs)
  if (!normalizedExtraArgs) {
    return baseCommand.trim()
  }
  if (options?.pnpmScript) {
    return `${baseCommand.trim()} -- ${normalizedExtraArgs}`
  }
  return `${baseCommand.trim()} ${normalizedExtraArgs}`
}

const withProbePath = (baseUrl: string | null, probePath: '/' | '/health') => {
  const normalizedBaseUrl = normalizeText(baseUrl)
  if (!normalizedBaseUrl) {
    return null
  }
  try {
    return new URL(
      probePath,
      normalizedBaseUrl.endsWith('/') ? normalizedBaseUrl : `${normalizedBaseUrl}/`,
    ).toString()
  } catch {
    return probePath === '/'
      ? normalizedBaseUrl
      : `${normalizedBaseUrl.replace(/\/+$/, '')}${probePath}`
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const readListeningPids = async (port: number | null) => {
  if (!port) {
    return [] as number[]
  }

  if (process.platform === 'win32') {
    const command = [
      '$pids = @(Get-NetTCPConnection -LocalPort',
      String(port),
      "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique);",
      '$pids | ForEach-Object { $_ }',
    ].join(' ')
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', command],
      {
        encoding: 'utf8',
        timeout: GLOBAL_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
    )
    const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    return [
      ...new Set(
        raw
          .split(/\r?\n/)
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    ]
  }

  const result = spawnSync(
    'lsof',
    ['-ti', `tcp:${String(port)}`],
    {
      encoding: 'utf8',
      timeout: GLOBAL_COMMAND_TIMEOUT_MS,
    },
  )
  const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return [
    ...new Set(
      raw
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ]
}

const killPidTree = async (pid: number) => {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        'taskkill',
        ['/pid', String(pid), '/t', '/f'],
        {
          windowsHide: true,
          stdio: 'ignore',
        },
      )
      killer.once('error', reject)
      killer.once('close', () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Ignore best-effort termination failures.
    }
  }
}

const killByPort = async (port: number | null) => {
  const pids = await readListeningPids(port)
  for (const pid of pids) {
    await killPidTree(pid).catch(() => undefined)
  }
  return pids
}

const resolveWindowsServiceControllerName = (serviceName: string | null | undefined) => {
  const normalizedName = normalizeNullableText(serviceName)
  if (!normalizedName) {
    return null
  }
  return `${normalizedName.replace(/[^\w]/g, '').toLowerCase()}.exe`
}

const queryWindowsServiceStatus = (serviceName: string | null | undefined) => {
  const normalizedName = normalizeNullableText(serviceName)
  if (process.platform !== 'win32' || !normalizedName) {
    return null as {
      name: string
      displayName: string
      controllerName: string
      installed: boolean
      status: 'missing' | 'running' | 'stopped' | 'unknown'
      rawOutput: string
    } | null
  }

  const controllerName = resolveWindowsServiceControllerName(normalizedName)
  const escapedName = normalizedName.replace(/'/g, "''")
  const escapedControllerName = (controllerName ?? normalizedName).replace(/'/g, "''")
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      [
        `$service = Get-Service -Name '${escapedControllerName}' -ErrorAction SilentlyContinue`,
        `if ($null -eq $service) { $service = Get-Service -DisplayName '${escapedName}' -ErrorAction SilentlyContinue }`,
        `if ($null -eq $service) { '__MISSING__' } else { @{ Name = $service.Name; DisplayName = $service.DisplayName; Status = $service.Status.ToString() } | ConvertTo-Json -Compress }`,
      ].join('; '),
    ],
    {
      encoding: 'utf8',
      timeout: GLOBAL_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    },
  )
  const rawOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  let resolvedDisplayName = normalizedName
  let resolvedControllerName = controllerName ?? normalizedName
  let normalizedOutput = rawOutput.trim().toLowerCase()

  try {
    const parsed = JSON.parse(rawOutput) as {
      Name?: string
      DisplayName?: string
      Status?: string
    }
    resolvedDisplayName = normalizeNullableText(parsed.DisplayName) ?? resolvedDisplayName
    resolvedControllerName = normalizeNullableText(parsed.Name) ?? resolvedControllerName
    normalizedOutput = (normalizeNullableText(parsed.Status) ?? rawOutput).trim().toLowerCase()
  } catch {
    // Keep raw fallback parsing for unexpected output.
  }

  const status: 'missing' | 'running' | 'stopped' | 'unknown' =
    normalizedOutput === '__missing__'
      ? 'missing'
      : normalizedOutput === 'running'
        ? 'running'
        : normalizedOutput === 'stopped'
          ? 'stopped'
          : 'unknown'

  return {
    name: normalizedName,
    displayName: resolvedDisplayName,
    controllerName: resolvedControllerName,
    installed: status !== 'missing',
    status,
    rawOutput,
  }
}

const probeUrl = async (
  url: string | null,
  options?: { probePath?: '/' | '/health'; timeoutMs?: number },
) => {
  const resolvedUrl = withProbePath(url, options?.probePath ?? '/health')
  if (!resolvedUrl) {
    return {
      checked_at: isoNow(),
      url: null,
      ok: false,
      status_code: null,
      duration_ms: null,
      message: '未配置可探测地址。',
    }
  }

  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? PROBE_TIMEOUT_MS)

  try {
    const response = await fetch(resolvedUrl, {
      signal: controller.signal,
      cache: 'no-store',
    })
    const durationMs = Date.now() - startedAt
    const body = await response.text().catch(() => '')
    return {
      checked_at: isoNow(),
      url: resolvedUrl,
      ok: response.ok,
      status_code: response.status,
      duration_ms: durationMs,
      message: response.ok
        ? body.trim() || '请求成功。'
        : body.trim() || `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      checked_at: isoNow(),
      url: resolvedUrl,
      ok: false,
      status_code: null,
      duration_ms: Date.now() - startedAt,
      message: error instanceof Error ? error.message : '探测失败。',
    }
  } finally {
    clearTimeout(timeout)
  }
}

const probeLocalPort = async (
  port: number | null,
  options?: { timeoutMs?: number },
) => {
  if (!port) {
    return {
      checked_at: isoNow(),
      url: null,
      ok: false,
      status_code: null,
      duration_ms: null,
      message: '未配置可探测端口。',
    }
  }

  const startedAt = Date.now()
  return await new Promise<{
    checked_at: string
    url: string | null
    ok: boolean
    status_code: number | null
    duration_ms: number | null
    message: string | null
  }>((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const finish = (payload: {
      checked_at: string
      url: string | null
      ok: boolean
      status_code: number | null
      duration_ms: number | null
      message: string | null
    }) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve(payload)
    }

    socket.setTimeout(options?.timeoutMs ?? PORT_PROBE_TIMEOUT_MS)
    socket.once('connect', () => {
      finish({
        checked_at: isoNow(),
        url: `tcp://${LOCALHOST}:${String(port)}`,
        ok: true,
        status_code: null,
        duration_ms: Date.now() - startedAt,
        message: `端口 ${String(port)} 可达。`,
      })
    })
    socket.once('timeout', () => {
      finish({
        checked_at: isoNow(),
        url: `tcp://${LOCALHOST}:${String(port)}`,
        ok: false,
        status_code: null,
        duration_ms: Date.now() - startedAt,
        message: `端口 ${String(port)} 连接超时。`,
      })
    })
    socket.once('error', (error) => {
      finish({
        checked_at: isoNow(),
        url: `tcp://${LOCALHOST}:${String(port)}`,
        ok: false,
        status_code: null,
        duration_ms: Date.now() - startedAt,
        message: error instanceof Error ? error.message : `端口 ${String(port)} 不可达。`,
      })
    })
    socket.connect(port, LOCALHOST)
  })
}

const waitForProbe = async (
  url: string | null,
  probePath: '/' | '/health',
  timeoutMs: number,
) => {
  const startedAt = Date.now()
  let latestProbe = await probeUrl(url, {
    probePath,
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  while (!latestProbe.ok && Date.now() - startedAt < timeoutMs) {
    await wait(1_000)
    latestProbe = await probeUrl(url, {
      probePath,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
  }
  return latestProbe
}

const buildSyntheticCommand = (
  command: string,
  nodeVersion: string | null,
): {
  id: string
  name: string
  description: string | null
  command: string
  kill_command: string | null
  cwd: string | null
  shell: 'auto'
  node_version: string | null
  port: null
  source: 'user'
  created_at: string
  updated_at: string
} => ({
  id: 'dev-manager-synthetic-command',
  name: 'dev-manager-synthetic-command',
  description: null,
  command,
  kill_command: null,
  cwd: null,
  shell: 'auto',
  node_version: nodeVersion,
  port: null,
  source: 'user',
  created_at: isoNow(),
  updated_at: isoNow(),
})

const resolveManagedCommand = async (input: {
  projectPath: string
  command: string
  nodeVersion: string | null
  env?: Record<string, string | null | undefined>
}): Promise<ManagedCommandSpec> => {
  const execution = await resolveRunCommandExecution(
    input.projectPath,
    buildSyntheticCommand(input.command, input.nodeVersion),
  )
  const env = {
    ...execution.env,
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    env[key] = value ?? ''
  }
  return {
    title: input.command,
    command: execution.command,
    cwd: execution.cwd,
    env,
    shell: execution.shell,
    launchError: execution.launch_error,
    runtimeNodeVersion: execution.runtime_node_version,
  }
}

const buildIsolatedManagedEnv = (
  baseEnv: NodeJS.ProcessEnv,
  overrides?: Record<string, string | null | undefined>,
): NodeJS.ProcessEnv => {
  const nextEnv: NodeJS.ProcessEnv = {}

  for (const key of MANAGED_ENV_PASSTHROUGH_KEYS) {
    const value = baseEnv[key]
    if (typeof value === 'string' && value.length > 0) {
      nextEnv[key] = value
    }
  }

  for (const [key, value] of Object.entries(baseEnv)) {
    if (!key || MANAGED_ENV_STRIP_KEYS.has(key)) {
      continue
    }
    if (MANAGED_ENV_STRIP_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue
    }
    if (key in nextEnv) {
      continue
    }
    if (typeof value === 'string' && value.length > 0) {
      nextEnv[key] = value
    }
  }

  nextEnv.NODE_OPTIONS = ''
  nextEnv.NODE_INSPECT_RESUME_ON_START = ''
  nextEnv.ELECTRON_RUN_AS_NODE = ''
  nextEnv.VSCODE_INSPECTOR_OPTIONS = ''

  for (const [key, value] of Object.entries(overrides ?? {})) {
    nextEnv[key] = value ?? ''
  }

  return nextEnv
}

const createTempNpmPublishUserConfig = async (token: string) => {
  const filePath = path.join(
    os.tmpdir(),
    `panda-dev-manager-${process.pid}-${Date.now()}.npmrc`,
  )
  const content = `//registry.npmjs.org/:_authToken=${token}\nregistry=${NPM_REGISTRY_URL}\n`
  await fs.writeFile(filePath, content, 'utf8')
  return filePath
}

const readStoredConfig = async (codexHome: string) => {
  const storedConfig = await readJsonFile<unknown>(resolveConfigPath(codexHome))
  const parsedConfig = devManagerConfigSchema.safeParse(storedConfig)
  const config = normalizeConfig(parsedConfig.success ? parsedConfig.data : null)
  const storedCredentials = await readJsonFile<StoredCredentials>(resolveCredentialsPath(codexHome))
  const credentials: StoredCredentials = {
    npm_token: normalizeNullableText(storedCredentials?.npm_token),
  }
  return {
    config,
    credentials,
  }
}

const readServiceProcessState = async (
  codexHome: string,
): Promise<ManagedServiceProcessState> => {
  const stored = await readJsonFile<ManagedServiceProcessState>(
    resolveServicePidsPath(codexHome),
  )
  if (!stored || typeof stored !== 'object') {
    return {}
  }
  return Object.fromEntries(
    Object.entries(stored).filter((entry) => {
      const value = entry[1]
      return (
        value &&
        typeof value.root_pid === 'number' &&
        Number.isInteger(value.root_pid) &&
        value.root_pid > 0
      )
    }),
  ) as ManagedServiceProcessState
}

const writeServiceProcessState = async (
  codexHome: string,
  state: ManagedServiceProcessState,
) => {
  await writeJsonFile(resolveServicePidsPath(codexHome), state)
}

const readInstalledPackageVersion = async () => {
  const result = spawnSync(
    'npm',
    ['list', '-g', RELEASE_PACKAGE_NAME, '--depth=0', '--json'],
    {
      encoding: 'utf8',
      timeout: GLOBAL_COMMAND_TIMEOUT_MS,
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  )
  if (result.status !== 0) {
    return normalizeNullableText(process.env.npm_package_version)
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      dependencies?: Record<string, { version?: string }>
    }
    return normalizeNullableText(parsed.dependencies?.[RELEASE_PACKAGE_NAME]?.version)
      ?? normalizeNullableText(process.env.npm_package_version)
  } catch {
    return normalizeNullableText(process.env.npm_package_version)
  }
}

const readApkArtifact = async (config: DevManagerConfig) => {
  const repoPath = config.repo_path
  if (!repoPath) {
    return null
  }

  const apkPath = path.join(repoPath, 'release', 'android', 'panda-android-release.apk')
  const latestJsonPath = path.join(repoPath, 'release', 'android', 'latest.json')
  const apkStat = await fs.stat(apkPath).catch(() => null)
  if (!apkStat?.isFile()) {
    return null
  }

  const manifest = await readJsonFile<{
    version_name?: string
    version_code?: number
    published_at?: string
  }>(latestJsonPath)
  const artifactId = createHash('sha1')
    .update([apkPath, String(apkStat.size), apkStat.mtime.toISOString()].join('::'))
    .digest('hex')
    .slice(0, 16)

  return {
    artifact_id: artifactId,
    file_name: path.basename(apkPath),
    size_bytes: Math.max(0, Math.round(apkStat.size)),
    built_at: apkStat.mtime.toISOString(),
    published_at: normalizeNullableText(manifest?.published_at),
    version_name: normalizeNullableText(manifest?.version_name),
    version_code:
      typeof manifest?.version_code === 'number' && Number.isFinite(manifest.version_code)
        ? Math.round(manifest.version_code)
        : null,
    download_path: `/api/dev-manager/apk/download?artifactId=${artifactId}`,
  }
}

const createUpgradeHelperSource = () => String.raw`
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const isoNow = () => new Date().toISOString()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'))

const writeJson = async (filePath, payload) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

const appendLog = async (jobPath, level, message) => {
  const job = await readJson(jobPath)
  job.logs = Array.isArray(job.logs) ? job.logs : []
  job.logs.push({
    id: 'dev-manager-log-' + Math.random().toString(36).slice(2),
    timestamp: isoNow(),
    level,
    message,
  })
  if (job.logs.length > 320) {
    job.logs = job.logs.slice(-320)
  }
  await writeJson(jobPath, job)
}

const finishJob = async (jobPath, status, summary, error) => {
  const job = await readJson(jobPath)
  job.status = status
  job.summary = summary || null
  job.error = error || null
  job.finished_at = isoNow()
  await writeJson(jobPath, job)
}

const readListeningPids = (port) => {
  if (!port) {
    return []
  }
  if (process.platform === 'win32') {
    const command = [
      '$pids = @(Get-NetTCPConnection -LocalPort',
      String(port),
      "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique);",
      '$pids | ForEach-Object { $_ }',
    ].join(' ')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    return [...new Set(String(result.stdout || '').split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((value) => Number.isInteger(value) && value > 0))]
  }
  const result = spawnSync('lsof', ['-ti', 'tcp:' + String(port)], {
    encoding: 'utf8',
    timeout: 5000,
  })
  return [...new Set(String(result.stdout || '').split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((value) => Number.isInteger(value) && value > 0))]
}

const killByPort = async (port) => {
  const pids = readListeningPids(port)
  for (const pid of pids) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const child = spawn('taskkill', ['/pid', String(pid), '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        child.once('close', () => resolve())
        child.once('error', () => resolve())
      })
      continue
    }
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  return pids
}

const resolveWindowsServiceControllerName = (serviceName) => {
  const normalizedName = String(serviceName || '').trim()
  if (!normalizedName) {
    return null
  }
  return normalizedName.replace(/[^\w]/g, '').toLowerCase() + '.exe'
}

const queryWindowsServiceStatus = (serviceName) => {
  if (process.platform !== 'win32' || !serviceName) {
    return null
  }
  const normalizedName = String(serviceName).trim()
  const controllerName = resolveWindowsServiceControllerName(normalizedName) || normalizedName
  const escapedName = normalizedName.replace(/'/g, "''")
  const escapedControllerName = controllerName.replace(/'/g, "''")
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', [
    "$service = Get-Service -Name '" + escapedControllerName + "' -ErrorAction SilentlyContinue",
    "if ($null -eq $service) { $service = Get-Service -DisplayName '" + escapedName + "' -ErrorAction SilentlyContinue }",
    "if ($null -eq $service) { '__MISSING__' } else { @{ Name = $service.Name; DisplayName = $service.DisplayName; Status = $service.Status.ToString() } | ConvertTo-Json -Compress }",
  ].join('; ')], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  })
  const rawOutput = (String(result.stdout || '') + '\n' + String(result.stderr || '')).trim()
  let resolvedDisplayName = normalizedName
  let resolvedControllerName = controllerName
  let normalizedOutput = rawOutput.trim().toLowerCase()
  try {
    const parsed = JSON.parse(rawOutput)
    resolvedDisplayName = String(parsed.DisplayName || '').trim() || resolvedDisplayName
    resolvedControllerName = String(parsed.Name || '').trim() || resolvedControllerName
    normalizedOutput = (String(parsed.Status || '').trim() || rawOutput).trim().toLowerCase()
  } catch {}
  const status =
    normalizedOutput === '__missing__'
      ? 'missing'
      : normalizedOutput === 'running'
        ? 'running'
        : normalizedOutput === 'stopped'
          ? 'stopped'
          : 'unknown'
  return {
    displayName: resolvedDisplayName,
    controllerName: resolvedControllerName,
    installed: status !== 'missing',
    status,
    rawOutput,
  }
}

const waitForWindowsServiceStatus = async (serviceName, desiredStatus, timeoutMs) => {
  const startedAt = Date.now()
  let latest = queryWindowsServiceStatus(serviceName)
  while (latest && latest.status !== desiredStatus && Date.now() - startedAt < timeoutMs) {
    await wait(750)
    latest = queryWindowsServiceStatus(serviceName)
  }
  return latest
}

const stopWindowsService = async (serviceName) => {
  const current = queryWindowsServiceStatus(serviceName)
  if (!current || !current.installed || current.status === 'stopped') {
    return current
  }
  const escapedName = String(current.controllerName || serviceName).replace(/'/g, "''")
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Stop-Service -Name '" + escapedName + "' -Force -ErrorAction Stop"], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  })
  const output = (String(result.stdout || '') + '\n' + String(result.stderr || '')).trim()
  const latest = await waitForWindowsServiceStatus(serviceName, 'stopped', 20000)
  if (!latest || latest.status !== 'stopped') {
    throw new Error(output || '停止 Windows 服务失败。')
  }
  return latest
}

const startWindowsService = async (serviceName) => {
  const current = queryWindowsServiceStatus(serviceName)
  if (!current || !current.installed) {
    throw new Error('Windows 服务不存在。')
  }
  if (current.status === 'running') {
    return current
  }
  const escapedName = String(current.controllerName || serviceName).replace(/'/g, "''")
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Start-Service -Name '" + escapedName + "' -ErrorAction Stop"], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  })
  const output = (String(result.stdout || '') + '\n' + String(result.stderr || '')).trim()
  const latest = await waitForWindowsServiceStatus(serviceName, 'running', 20000)
  if (!latest || latest.status !== 'running') {
    throw new Error(output || '启动 Windows 服务失败。')
  }
  return latest
}

const probe = async (url, probePath) => {
  if (!url) {
    return { ok: false, message: '未配置地址。' }
  }
  const target = new URL(probePath, url.endsWith('/') ? url : url + '/').toString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      cache: 'no-store',
    })
    const text = await response.text().catch(() => '')
    return {
      ok: response.ok,
      message: text.trim() || 'HTTP ' + String(response.status),
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '探测失败。',
    }
  } finally {
    clearTimeout(timeout)
  }
}

const waitForProbe = async (url, probePath, timeoutMs) => {
  const startedAt = Date.now()
  let latest = await probe(url, probePath)
  while (!latest.ok && Date.now() - startedAt < timeoutMs) {
    await wait(1000)
    latest = await probe(url, probePath)
  }
  return latest
}

const runCommandWithLogs = async (jobPath, spec, title) => {
  await appendLog(jobPath, 'info', title + '：' + spec.command)
  if (spec.runtimeNodeVersion) {
    await appendLog(
      jobPath,
      'info',
      '已注入 Node ' + spec.runtimeNodeVersion + ' 临时环境，仅当前命令生效。',
    )
  }
  if (spec.launchError) {
    throw new Error(spec.launchError)
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      windowsHide: true,
      stdio: 'pipe',
    })
    child.stdout.on('data', (chunk) => {
      void appendLog(jobPath, 'info', String(chunk).trimEnd())
    })
    child.stderr.on('data', (chunk) => {
      void appendLog(jobPath, 'warn', String(chunk).trimEnd())
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(title + '失败，退出码 ' + String(code ?? 'unknown')))
    })
  })
}

const startDetached = async (jobPath, spec, label) => {
  await appendLog(jobPath, 'info', '启动 ' + label + '：' + spec.command)
  if (spec.runtimeNodeVersion) {
    await appendLog(
      jobPath,
      'info',
      '已注入 Node ' + spec.runtimeNodeVersion + ' 临时环境，仅当前命令生效。',
    )
  }
  if (spec.launchError) {
    throw new Error(spec.launchError)
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve(child.pid || null)
    })
  })
}

const main = async () => {
  const payloadPath = process.argv[2]
  const payload = await readJson(payloadPath)
  const jobPath = payload.jobPath
  const workflowLabel = String(payload.workflowLabel || '正式版恢复')
  const stopServices = Array.isArray(payload.stopServices) ? payload.stopServices : []
  const startServices = Array.isArray(payload.startServices) ? payload.startServices : []
  try {
    await appendLog(jobPath, 'info', '后台升级助手已接管当前任务。')
    await appendLog(jobPath, 'info', workflowLabel + '：准备停止当前正式版进程。')
    await wait(payload.stopDelayMs || 1500)

    for (const service of stopServices) {
      await appendLog(jobPath, 'info', '正在停止 ' + service.label + '。')
      if (service.serviceName) {
        const status = await stopWindowsService(service.serviceName)
        await appendLog(
          jobPath,
          'info',
          status && status.installed
            ? '已停止 Windows 服务 ' + service.label + '（' + service.serviceName + '）。'
            : service.label + ' 对应的 Windows 服务未安装，回退到端口停止。',
        )
        if (!status || !status.installed) {
          const pids = await killByPort(service.port)
          if (pids.length > 0) {
            await appendLog(jobPath, 'info', '已停止 ' + service.label + '，PID: ' + pids.join(', '))
          } else {
            await appendLog(jobPath, 'info', service.label + ' 当前没有监听中的端口进程。')
          }
        }
      } else {
        const pids = await killByPort(service.port)
        if (pids.length > 0) {
          await appendLog(jobPath, 'info', '已停止 ' + service.label + '，PID: ' + pids.join(', '))
        } else {
          await appendLog(jobPath, 'info', service.label + ' 当前没有监听中的端口进程。')
        }
      }
    }

    let installError = null
    if (payload.installCommand) {
      await appendLog(jobPath, 'info', workflowLabel + '：开始执行 npm 安装阶段。')
      try {
        await runCommandWithLogs(jobPath, payload.installCommand, '安装最新正式版')
        await appendLog(jobPath, 'success', '最新正式版安装完成。')
      } catch (error) {
        installError = error instanceof Error ? error.message : String(error)
        await appendLog(jobPath, 'error', '安装最新正式版失败：' + installError)
      }
    } else {
      await appendLog(jobPath, 'info', workflowLabel + '：跳过 npm 安装阶段。')
    }

    const probeResults = []
    await appendLog(jobPath, 'info', workflowLabel + '：开始恢复正式版服务。')
    for (const service of startServices) {
      await appendLog(jobPath, 'info', '正在启动 ' + service.label + '。')
      if (service.serviceName) {
        try {
          await startWindowsService(service.serviceName)
          await appendLog(
            jobPath,
            'info',
            '已启动 Windows 服务 ' + service.label + '（' + service.serviceName + '）。',
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await appendLog(jobPath, 'error', '启动 ' + service.label + ' 失败：' + message)
          probeResults.push({ label: service.label, ok: false, message })
          continue
        }
      } else {
        try {
          await startDetached(jobPath, service.command, service.label)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await appendLog(jobPath, 'error', '启动 ' + service.label + ' 失败：' + message)
          probeResults.push({ label: service.label, ok: false, message })
          continue
        }
      }

      const probeResult = await waitForProbe(service.probeUrl, service.probePath, service.timeoutMs)
      probeResults.push({
        label: service.label,
        ok: probeResult.ok,
        message: probeResult.message,
      })
      await appendLog(
        jobPath,
        probeResult.ok ? 'success' : 'warn',
        service.label + (probeResult.ok ? ' 已恢复可用。' : ' 仍未通过探测：' + probeResult.message),
      )
    }

    const allHealthy = probeResults.every((entry) => entry.ok)
    if (allHealthy) {
      await finishJob(
        jobPath,
        'succeeded',
        installError
          ? workflowLabel + '已完成，但安装阶段曾报错，请核对日志。'
          : '正式版 Hub + Agent 已恢复可用。',
        installError,
      )
      return
    }

    const failedLabels = probeResults.filter((entry) => !entry.ok).map((entry) => entry.label)
    await finishJob(
      jobPath,
      'failed',
      failedLabels.length > 0
        ? '升级流程结束，但以下服务未恢复：' + failedLabels.join('、')
        : '升级流程结束，但恢复状态异常。',
      installError || failedLabels.join(', '),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendLog(jobPath, 'error', workflowLabel + '失败：' + message)
    await finishJob(jobPath, 'failed', workflowLabel + '失败。', message)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`

export const createDevManager = ({
  codexHome,
  logger,
}: DevManagerOptions) => {
  const activeJobs = new Map<string, Promise<void>>()
  let cachedNodeRuntime:
    | {
        value: Awaited<ReturnType<typeof readSessionRunNodeRuntime>>
        cachedAt: number
      }
    | null = null
  let cachedInstalledPackageVersion:
    | {
        value: string | null
        cachedAt: number
      }
    | null = null
  let cachedApkArtifact:
    | {
        repoPath: string | null
        value: Awaited<ReturnType<typeof readApkArtifact>>
        cachedAt: number
      }
    | null = null

  const getCachedNodeRuntime = async () => {
    const now = Date.now()
    if (
      cachedNodeRuntime &&
      now - cachedNodeRuntime.cachedAt < SNAPSHOT_NODE_RUNTIME_CACHE_MS
    ) {
      return cachedNodeRuntime.value
    }

    const value = await readSessionRunNodeRuntime()
    cachedNodeRuntime = {
      value,
      cachedAt: Date.now(),
    }
    return value
  }

  const refreshInstalledPackageVersion = async () => {
    const value = await readInstalledPackageVersion()
    cachedInstalledPackageVersion = {
      value,
      cachedAt: Date.now(),
    }
    return value
  }

  const getCachedInstalledPackageVersion = async (
    options?: { allowStale?: boolean },
  ) => {
    const now = Date.now()
    if (
      cachedInstalledPackageVersion &&
      now - cachedInstalledPackageVersion.cachedAt < SNAPSHOT_PACKAGE_VERSION_CACHE_MS
    ) {
      return cachedInstalledPackageVersion.value
    }

    if (options?.allowStale) {
      void refreshInstalledPackageVersion().catch(() => undefined)
      return cachedInstalledPackageVersion?.value ?? normalizeNullableText(process.env.npm_package_version)
    }

    return await refreshInstalledPackageVersion()
  }

  const getCachedApkArtifact = async (config: DevManagerConfig) => {
    const repoPath = normalizeNullableText(config.repo_path)
    const now = Date.now()
    if (
      cachedApkArtifact &&
      cachedApkArtifact.repoPath === repoPath &&
      now - cachedApkArtifact.cachedAt < SNAPSHOT_APK_ARTIFACT_CACHE_MS
    ) {
      return cachedApkArtifact.value
    }

    const value = await readApkArtifact(config)
    cachedApkArtifact = {
      repoPath,
      value,
      cachedAt: Date.now(),
    }
    return value
  }

  const rememberServiceRootPid = async (
    serviceKey: ServiceRuntimeSpec['key'],
    rootPid: number,
    command: string,
  ) => {
    const current = await readServiceProcessState(codexHome)
    current[serviceKey] = {
      root_pid: rootPid,
      started_at: isoNow(),
      command,
    }
    await writeServiceProcessState(codexHome, current)
  }

  const forgetServiceRootPid = async (
    serviceKey: ServiceRuntimeSpec['key'],
  ) => {
    const current = await readServiceProcessState(codexHome)
    if (!(serviceKey in current)) {
      return
    }
    delete current[serviceKey]
    await writeServiceProcessState(codexHome, current)
  }

  const readServiceRootPid = async (
    serviceKey: ServiceRuntimeSpec['key'],
  ) => {
    const current = await readServiceProcessState(codexHome)
    return current[serviceKey]?.root_pid ?? null
  }

  const getExecutionRoot = (config: DevManagerConfig) =>
    config.repo_path ?? os.homedir()

  const buildHubDevCommand = (config: DevManagerConfig) =>
    buildShellCommand('corepack pnpm dev:hub', config.dev_hub_args, {
      pnpmScript: true,
    })

  const buildAgentDevCommand = (config: DevManagerConfig) =>
    buildShellCommand('corepack pnpm dev:agent', config.dev_agent_args, {
      pnpmScript: true,
    })

  const buildWebDevCommand = (config: DevManagerConfig) =>
    buildShellCommand(
      [
        'corepack pnpm --dir apps/web exec vite',
        '--host',
        '0.0.0.0',
        '--port',
        String(config.dev_web_port ?? defaultConfig().dev_web_port),
      ].join(' '),
      config.dev_web_args,
    )

  const buildReleaseHubCommand = (config: DevManagerConfig) =>
    buildShellCommand('panda hub', config.release_hub_args)

  const buildReleaseAgentCommand = (config: DevManagerConfig) =>
    buildShellCommand('panda agent', config.release_agent_args)

  const buildReleaseHubEnvOverrides = (config: DevManagerConfig) => ({
    PANDA_HUB_PORT: config.release_hub_port ? String(config.release_hub_port) : null,
  })

  const buildReleaseAgentEnvOverrides = (config: DevManagerConfig) => ({
    PANDA_AGENT_PORT: config.release_agent_port ? String(config.release_agent_port) : null,
    PANDA_HUB_URL: config.release_agent_hub_url,
    PANDA_AGENT_DIRECT_BASE_URL: config.release_agent_direct_base_url,
    PANDA_AGENT_WS_BASE_URL: config.release_agent_ws_base_url,
    PANDA_AGENT_NAME: normalizeNullableText(config.release_agent_name),
  })

  const validateWindowsServiceName = (value: string, label: string) => {
    if (!/^[A-Za-z0-9._() \-]+$/.test(value)) {
      throw new Error(`${label} 只能包含字母、数字、空格、点、下划线、圆括号和连字符。`)
    }
  }

  const quoteCommandArg = (value: string) => {
    const normalized = value.trim()
    if (!normalized) {
      return '""'
    }
    return `"${normalized.replace(/"/g, '\\"')}"`
  }

  const buildReleaseHubServiceInstallCommand = (config: DevManagerConfig) => {
    validateWindowsServiceName(config.release_hub_service_name, '正式版 Hub 服务名')
    const command = `panda hub service install --name=${quoteCommandArg(
      config.release_hub_service_name,
    )}`
    return buildShellCommand(command, config.release_hub_args)
  }

  const buildReleaseAgentServiceInstallCommand = (config: DevManagerConfig) => {
    validateWindowsServiceName(config.release_agent_service_name, '正式版 Agent 服务名')
    const command = `panda agent service install --name=${quoteCommandArg(
      config.release_agent_service_name,
    )}`
    return buildShellCommand(command, config.release_agent_args)
  }

  const buildReleaseHubServiceUninstallCommand = (config: DevManagerConfig) => {
    validateWindowsServiceName(config.release_hub_service_name, '正式版 Hub 服务名')
    return `panda hub service uninstall --name=${quoteCommandArg(config.release_hub_service_name)}`
  }

  const buildReleaseAgentServiceUninstallCommand = (config: DevManagerConfig) => {
    validateWindowsServiceName(config.release_agent_service_name, '正式版 Agent 服务名')
    return `panda agent service uninstall --name=${quoteCommandArg(config.release_agent_service_name)}`
  }

  const resolveServiceCommand = async (
    config: DevManagerConfig,
    key: ServiceRuntimeSpec['key'],
  ) => {
    const projectPath = getExecutionRoot(config)
    if (key.startsWith('dev-')) {
      await validateRepoPath(config.repo_path)
    }

    if (key === 'dev-hub') {
      return resolveManagedCommand({
        projectPath,
        command: buildHubDevCommand(config),
        nodeVersion: config.nvm_version,
        env: {
          PANDA_HUB_PORT: config.dev_hub_port ? String(config.dev_hub_port) : null,
          PANDA_HUB_API_KEY: '',
        },
      })
    }

    if (key === 'dev-agent') {
      return resolveManagedCommand({
        projectPath,
        command: buildAgentDevCommand(config),
        nodeVersion: config.nvm_version,
        env: {
          PANDA_AGENT_PORT: config.dev_agent_port ? String(config.dev_agent_port) : null,
          PANDA_HUB_URL: config.dev_agent_hub_url,
          PANDA_AGENT_DIRECT_BASE_URL: config.dev_agent_direct_base_url,
          PANDA_AGENT_WS_BASE_URL: config.dev_agent_ws_base_url,
          PANDA_AGENT_NAME: normalizeNullableText(config.dev_agent_name),
          PANDA_HUB_API_KEY: '',
        },
      })
    }

    if (key === 'dev-web') {
      return resolveManagedCommand({
        projectPath,
        command: buildWebDevCommand(config),
        nodeVersion: config.nvm_version,
        env: {
          VITE_PANDA_HUB_URL: config.dev_web_hub_url,
        },
      })
    }

    if (key === 'release-hub') {
      return resolveManagedCommand({
        projectPath,
        command: buildReleaseHubCommand(config),
        nodeVersion: config.nvm_version,
        env: buildReleaseHubEnvOverrides(config),
      })
    }

    return resolveManagedCommand({
      projectPath,
      command: buildReleaseAgentCommand(config),
      nodeVersion: config.nvm_version,
      env: buildReleaseAgentEnvOverrides(config),
    })
  }

  const getServiceSpecs = (config: DevManagerConfig): ServiceRuntimeSpec[] => [
    {
      key: 'dev-hub',
      label: '开发版 Hub',
      port: config.dev_hub_port,
      probeUrl: buildHttpBaseUrl(config.dev_hub_port, ''),
      probePath: '/health',
      start: () => resolveServiceCommand(config, 'dev-hub'),
    },
    {
      key: 'dev-agent',
      label: '开发版 Agent',
      port: config.dev_agent_port,
      probeUrl: config.dev_agent_direct_base_url,
      probePath: '/health',
      start: () => resolveServiceCommand(config, 'dev-agent'),
    },
    {
      key: 'dev-web',
      label: '开发版 Web',
      port: config.dev_web_port,
      probeUrl: buildHttpBaseUrl(config.dev_web_port, ''),
      probePath: '/',
      start: () => resolveServiceCommand(config, 'dev-web'),
    },
    {
      key: 'release-hub',
      label: '正式版 Hub',
      port: config.release_hub_port,
      probeUrl: buildHttpBaseUrl(config.release_hub_port, ''),
      probePath: '/health',
      serviceName: config.release_hub_service_name,
      start: () => resolveServiceCommand(config, 'release-hub'),
    },
    {
      key: 'release-agent',
      label: '正式版 Agent',
      port: config.release_agent_port,
      probeUrl: config.release_agent_direct_base_url,
      probePath: '/health',
      serviceName: config.release_agent_service_name,
      start: () => resolveServiceCommand(config, 'release-agent'),
    },
  ]

  const buildServiceSnapshots = async (
    config: DevManagerConfig,
    options?: { includeProbe?: boolean },
  ) =>
    await Promise.all(
      getServiceSpecs(config).map(async (service) => {
        const quickProbe = await probeLocalPort(service.port)
        const controllerStatus = queryWindowsServiceStatus(service.serviceName)
        const usesWindowsService = Boolean(
          service.key.startsWith('release-') && controllerStatus?.installed,
        )
        const manager = usesWindowsService ? ('windows-service' as const) : ('process' as const)

        const status: 'running' | 'stopped' | 'unknown' | 'degraded' =
          usesWindowsService
            ? controllerStatus?.status === 'running'
              ? quickProbe.ok
                ? 'running'
                : 'degraded'
              : controllerStatus?.status === 'stopped'
                ? quickProbe.ok
                  ? 'degraded'
                  : 'stopped'
                : controllerStatus?.status === 'missing'
                  ? quickProbe.ok
                    ? 'running'
                    : service.port || service.probeUrl
                      ? 'stopped'
                      : 'unknown'
                  : quickProbe.ok
                    ? 'running'
                    : 'unknown'
            : quickProbe.ok
              ? 'running'
              : service.port || service.probeUrl
                ? 'stopped'
                : 'unknown'

        if (options?.includeProbe !== true) {
          return {
            key: service.key,
            label: service.label,
            status,
            manager,
            service_name: service.serviceName ?? null,
            service_registered: controllerStatus?.installed ?? false,
            service_status: controllerStatus?.status ?? null,
            configured_port: service.port,
            detected_pids: [],
            probe: null,
          }
        }

          return {
          key: service.key,
          label: service.label,
          status,
          manager,
          service_name: service.serviceName ?? null,
          service_registered: controllerStatus?.installed ?? false,
          service_status: controllerStatus?.status ?? null,
            configured_port: service.port,
            detected_pids: [],
            probe: quickProbe,
          }
      }),
    )

  const createJobController = async (
    kind: DevManagerJobKind,
    title: string,
    options?: { disconnectExpected?: boolean },
  ): Promise<JobController> => {
    const job = createManagedJob(kind, title, options)
    const filePath = buildJobFilePath(codexHome, job.id)
    let currentJob = job
    await writeJsonFile(filePath, currentJob)

    return {
      append: async (level, message) => {
        currentJob = {
          ...currentJob,
          logs: [...currentJob.logs, createJobLogEntry(level, message)].slice(-MAX_JOB_LOGS),
        }
        await writeJsonFile(filePath, currentJob)
      },
      succeed: async (summary) => {
        currentJob = {
          ...currentJob,
          status: 'succeeded',
          summary,
          error: null,
          finished_at: isoNow(),
        }
        await writeJsonFile(filePath, currentJob)
        return currentJob
      },
      fail: async (error) => {
        currentJob = {
          ...currentJob,
          status: 'failed',
          summary: currentJob.summary ?? '执行失败。',
          error,
          finished_at: isoNow(),
        }
        await writeJsonFile(filePath, currentJob)
        return currentJob
      },
      readCurrent: () => currentJob,
    }
  }

  const runManagedJob = async (
    kind: DevManagerJobKind,
    title: string,
    worker: (job: JobController) => Promise<void>,
  ): Promise<DevManagerJob> => {
    const existingRunningJob = (await readAllJobs(codexHome)).find(
      (job) => job.kind === kind && job.status === 'running',
    )
    if (existingRunningJob) {
      return existingRunningJob
    }

    const controller = await createJobController(kind, title)
    const currentJob = controller.readCurrent()
    const jobPromise = (async () => {
      try {
        await worker(controller)
      } catch (error) {
        const message = error instanceof Error ? error.message : '任务执行失败。'
        await controller.append('error', message)
        await controller.fail(message)
        logger.error({
          jobId: currentJob.id,
          kind,
          error: message,
        }, 'Dev manager job failed.')
      } finally {
        activeJobs.delete(currentJob.id)
      }
    })()
    activeJobs.set(currentJob.id, jobPromise)
    return currentJob
  }

  const startDetachedService = async (
    service: ServiceRuntimeSpec,
    job: JobController,
  ) => {
    if (!service.start) {
      throw new Error(`${service.label} 没有可执行的启动命令。`)
    }
    const command = await service.start()
    await job.append('info', `${service.label} 启动命令：${command.command}`)
    if (command.runtimeNodeVersion) {
      await job.append(
        'info',
        `${service.label} 已注入 Node ${command.runtimeNodeVersion} 临时环境，仅当前命令生效。`,
      )
    }
    if (command.launchError) {
      throw new Error(command.launchError)
    }
    const rootPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(command.command, {
        cwd: command.cwd,
        env: command.env,
        shell: command.shell,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        if (!child.pid) {
          reject(new Error(`${service.label} 启动后未返回有效 PID。`))
          return
        }
        resolve(child.pid)
      })
    })
    await rememberServiceRootPid(service.key, rootPid, command.command)
    const readiness = await waitForProbe(
      service.probeUrl,
      service.probePath,
      START_PROBE_TIMEOUT_MS,
    )
    await job.append(
      readiness.ok ? 'success' : 'warn',
      readiness.ok
        ? `${service.label} 已通过探测。`
        : `${service.label} 已拉起命令，但暂未通过探测：${readiness.message ?? 'unknown'}`,
    )
  }

  const stopServiceByPort = async (
    service: ServiceRuntimeSpec,
    job: JobController,
  ) => {
    const rootPid = await readServiceRootPid(service.key)
    const stoppedRootPids: number[] = []
    if (rootPid) {
      await job.append('info', `正在停止 ${service.label} 的启动根进程（PID ${String(rootPid)}）。`)
      await killPidTree(rootPid).catch(() => undefined)
      stoppedRootPids.push(rootPid)
      await forgetServiceRootPid(service.key)
    }

    if (!service.port) {
      await job.append(
        stoppedRootPids.length > 0 ? 'success' : 'warn',
        stoppedRootPids.length > 0
          ? `${service.label} 已停止根进程。`
          : `${service.label} 未配置端口，且没有记录到可停止的根进程。`,
      )
      return
    }

    await job.append('info', `正在停止 ${service.label}（端口 ${String(service.port)}）。`)
    const pids = await killByPort(service.port)
    const stoppedPids = [...new Set([...stoppedRootPids, ...pids])]
    await job.append(
      stoppedPids.length > 0 ? 'success' : 'info',
      stoppedPids.length > 0
        ? `${service.label} 已停止，PID: ${stoppedPids.join(', ')}`
        : `${service.label} 当前没有监听中的端口进程，也没有残留的启动根进程。`,
    )
  }

  const runCommandWithLogs = async (
    command: ManagedCommandSpec,
    job: JobController,
    label: string,
  ) => {
    if (command.runtimeNodeVersion) {
      await job.append(
        'info',
        `${label} 已注入 Node ${command.runtimeNodeVersion} 临时环境，仅当前命令生效。`,
      )
    }
    if (command.launchError) {
      throw new Error(command.launchError)
    }
    return await new Promise<void>((resolve, reject) => {
      const child = spawn(command.command, {
        cwd: command.cwd,
        env: command.env,
        shell: command.shell,
        windowsHide: true,
        stdio: 'pipe',
      })
      child.stdout.on('data', (chunk) => {
        void job.append('info', String(chunk).trimEnd())
      })
      child.stderr.on('data', (chunk) => {
        void job.append('warn', String(chunk).trimEnd())
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) {
          resolve()
          return
        }
        reject(new Error(`${label} 失败，退出码 ${String(code ?? 'unknown')}`))
      })
    })
  }

  const readSnapshot = async (
    options?: { includeServiceProbe?: boolean },
  ): Promise<DevManagerSnapshot> => {
    const { config, credentials } = await readStoredConfig(codexHome)
    const [
      nodeRuntime,
      jobs,
      currentVersion,
      apkArtifact,
      services,
    ] = await Promise.all([
      getCachedNodeRuntime(),
      readAllJobs(codexHome).then((items) => items.slice(0, MAX_VISIBLE_JOBS)),
      getCachedInstalledPackageVersion({ allowStale: true }),
      getCachedApkArtifact(config),
      buildServiceSnapshots(config, {
        includeProbe: options?.includeServiceProbe === true,
      }),
    ])

    return {
      generated_at: isoNow(),
      config,
      credentials: {
        has_npm_token: Boolean(credentials.npm_token),
        npm_token_hint: maskTokenHint(credentials.npm_token),
      },
      node_runtime: nodeRuntime,
      services,
      current_version: currentVersion,
      apk_artifact: apkArtifact,
      jobs,
    }
  }

  const saveConfig = async (input: DevManagerConfigUpdate) => {
    const current = await readStoredConfig(codexHome)
    const normalized = normalizeConfig({
      ...current.config,
      ...input,
      updated_at: isoNow(),
    })
    await validateRepoPath(normalized.repo_path)

    const nextCredentials: StoredCredentials = {
      npm_token: input.clear_npm_token
        ? null
        : normalizeNullableText(input.npm_token) ?? current.credentials.npm_token,
    }

    await ensureDirectory(resolveStateRoot(codexHome))
    await writeJsonFile(resolveConfigPath(codexHome), normalized)
    await writeJsonFile(resolveCredentialsPath(codexHome), nextCredentials)
    cachedApkArtifact = null
    return readSnapshot()
  }

  const runDevelopmentLifecycle = async (
    mode: 'start' | 'restart' | 'stop' | 'probe',
  ) => {
    const { config } = await readStoredConfig(codexHome)
    if (mode !== 'probe') {
      await validateRepoPath(config.repo_path)
    }

    const titleByMode = {
      start: '启动开发版',
      restart: '重启开发版',
      stop: '停止开发版',
      probe: '测试开发版状态',
    } as const
    const kindByMode = {
      start: 'dev-start',
      restart: 'dev-restart',
      stop: 'dev-stop',
      probe: 'dev-probe',
    } as const

    const devServices = getServiceSpecs(config).filter((service) => service.key.startsWith('dev-'))
    return runManagedJob(kindByMode[mode], titleByMode[mode], async (job) => {
      if (mode === 'restart' || mode === 'stop') {
        for (const service of [...devServices].reverse()) {
          await stopServiceByPort(service, job)
        }
      }

      if (mode === 'start' || mode === 'restart') {
        for (const service of devServices) {
          const probe = await probeUrl(service.probeUrl, {
            probePath: service.probePath,
          })
          if (probe.ok && mode === 'start') {
            await job.append('info', `${service.label} 已在运行，跳过重复启动。`)
            continue
          }
          if (mode === 'start' && !probe.ok) {
            const stalePids = await readListeningPids(service.port)
            if (stalePids.length > 0) {
              await job.append(
                'warn',
                `${service.label} 端口已被占用但探测失败，先尝试清理旧进程后再启动。`,
              )
              await stopServiceByPort(service, job)
            }
          }
          await startDetachedService(service, job)
        }
      }

      if (mode === 'probe') {
        for (const service of devServices) {
          const probe = await probeLocalPort(service.port)
          const summary = `${service.label}：${probe.ok ? '正常' : '异常'}${probe.message ? `，${probe.message}` : ''}`
          await job.append(probe.ok ? 'success' : 'warn', summary)
        }
      }

      const summaryByMode = {
        start: '开发版启动流程已完成。',
        restart: '开发版重启流程已完成。',
        stop: '开发版停止流程已完成。',
        probe: '开发版状态测试已完成。',
      } as const
      await job.succeed(summaryByMode[mode])
    })
  }

  const runNpmPublish = async () => {
    const { config, credentials } = await readStoredConfig(codexHome)
    const npmToken = credentials.npm_token
    await validateRepoPath(config.repo_path)
    if (!config.repo_path) {
      throw new Error('请先配置开发版代码路径。')
    }
    if (!npmToken) {
      throw new Error('请先在设置页保存 npm 令牌。')
    }

    return runManagedJob('npm-publish', '发布 npm 正式包', async (job) => {
      await job.append('info', '准备执行 release-publish 脚本。')
      const userConfigPath = await createTempNpmPublishUserConfig(npmToken)
      try {
        const command = await resolveManagedCommand({
          projectPath: config.repo_path!,
          command: 'node ./scripts/release-publish.mjs',
          nodeVersion: config.nvm_version,
        })
        command.env = buildIsolatedManagedEnv(command.env, {
          NODE_AUTH_TOKEN: npmToken,
          NPM_CONFIG_USERCONFIG: userConfigPath,
          PANDA_NPM_PUBLISH_USERCONFIG: userConfigPath,
        })
        await runCommandWithLogs(command, job, 'npm 发布')
        await job.succeed('npm 发布完成。')
      } finally {
        await fs.rm(userConfigPath, { force: true }).catch(() => undefined)
      }
    })
  }

  const runApkBuild = async () => {
    const { config } = await readStoredConfig(codexHome)
    await validateRepoPath(config.repo_path)
    if (!config.repo_path) {
      throw new Error('请先配置开发版代码路径。')
    }

    return runManagedJob('apk-build', '编译开发版 APK', async (job) => {
      await job.append('info', '准备执行 Android release 构建。')
      const command = await resolveManagedCommand({
        projectPath: config.repo_path!,
        command: 'node ./scripts/android-build.mjs release --publish',
        nodeVersion: config.nvm_version,
      })
      await runCommandWithLogs(command, job, 'APK 编译')
      const artifact = await readApkArtifact(config)
      cachedApkArtifact = null
      if (artifact) {
        await job.append(
          'success',
          `APK 已生成：${artifact.file_name}，${Math.round(artifact.size_bytes / 1024 / 1024 * 10) / 10} MB`,
        )
      }
      await job.succeed('APK 编译完成。')
    })
  }

  const installReleaseServices = async () => {
    const { config } = await readStoredConfig(codexHome)
    const executionRoot = getExecutionRoot(config)

    return runManagedJob('release-service-install', '注册或更新正式版服务', async (job) => {
      if (process.platform !== 'win32') {
        throw new Error('正式版服务注册当前只支持 Windows。')
      }

      await job.append('info', '准备注册或更新正式版 Hub Windows 服务。')
      const hubCommand = await resolveManagedCommand({
        projectPath: executionRoot,
        command: buildReleaseHubServiceInstallCommand(config),
        nodeVersion: config.nvm_version,
        env: buildReleaseHubEnvOverrides(config),
      })
      await runCommandWithLogs(hubCommand, job, '注册正式版 Hub 服务')

      await job.append('info', '准备注册或更新正式版 Agent Windows 服务。')
      const agentCommand = await resolveManagedCommand({
        projectPath: executionRoot,
        command: buildReleaseAgentServiceInstallCommand(config),
        nodeVersion: config.nvm_version,
        env: buildReleaseAgentEnvOverrides(config),
      })
      await runCommandWithLogs(agentCommand, job, '注册正式版 Agent 服务')

      await job.succeed('正式版 Hub 与 Agent 服务已注册或更新。')
    })
  }

  const uninstallReleaseServices = async () => {
    const { config } = await readStoredConfig(codexHome)
    const executionRoot = getExecutionRoot(config)

    return runManagedJob('release-service-uninstall', '移除正式版服务', async (job) => {
      if (process.platform !== 'win32') {
        throw new Error('正式版服务移除当前只支持 Windows。')
      }

      await job.append('info', '准备移除正式版 Agent Windows 服务。')
      const agentCommand = await resolveManagedCommand({
        projectPath: executionRoot,
        command: buildReleaseAgentServiceUninstallCommand(config),
        nodeVersion: config.nvm_version,
      })
      await runCommandWithLogs(agentCommand, job, '移除正式版 Agent 服务')

      await job.append('info', '准备移除正式版 Hub Windows 服务。')
      const hubCommand = await resolveManagedCommand({
        projectPath: executionRoot,
        command: buildReleaseHubServiceUninstallCommand(config),
        nodeVersion: config.nvm_version,
      })
      await runCommandWithLogs(hubCommand, job, '移除正式版 Hub 服务')

      await job.succeed('正式版 Hub 与 Agent 服务已移除。')
    })
  }

  const launchDetachedHelper = async (
    helperSourcePath: string,
    helperPayloadPath: string,
  ): Promise<{ mode: 'direct-spawn'; pid: number | null }> =>
    await new Promise((resolve, reject) => {
      const helper = spawn(
        process.execPath,
        [helperSourcePath, helperPayloadPath],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      helper.once('error', reject)
      helper.once('spawn', () => {
        helper.unref()
        resolve({
          mode: 'direct-spawn',
          pid: helper.pid ?? null,
        })
      })
    })

  const spawnReleaseRecoveryHelper = async (input: {
    kind: DevManagerJobKind
    title: string
    workflowLabel: string
    installCommand?: ManagedCommandSpec | null
  }) => {
    const { config } = await readStoredConfig(codexHome)
    const releaseHubServiceStatus = queryWindowsServiceStatus(config.release_hub_service_name)
    const releaseAgentServiceStatus = queryWindowsServiceStatus(config.release_agent_service_name)
    const releaseHubCommand = await resolveServiceCommand(config, 'release-hub')
    const releaseAgentCommand = await resolveServiceCommand(config, 'release-agent')
    const helperDirectory = resolveHelperDirectory(codexHome)
    await ensureDirectory(helperDirectory)

    const job = createManagedJob(input.kind, input.title, {
      disconnectExpected: true,
    })
    const jobPath = buildJobFilePath(codexHome, job.id)
    await writeJsonFile(jobPath, {
      ...job,
      logs: [
        createJobLogEntry(
          'info',
          `${input.workflowLabel}即将由后台升级助手接管。当前 Hub 会短时中断，请等待自动恢复。`,
        ),
      ],
    })

    const helperSourcePath = path.join(helperDirectory, 'release-install-helper.cjs')
    const helperPayloadPath = path.join(helperDirectory, `${job.id}.json`)
    await fs.writeFile(helperSourcePath, createUpgradeHelperSource(), 'utf8')
    await writeJsonFile(helperPayloadPath, {
      jobPath,
      workflowLabel: input.workflowLabel,
      stopDelayMs: RELEASE_RESTART_DELAY_MS,
      stopServices: [
        {
          label: '正式版 Agent',
          port: config.release_agent_port,
          serviceName: releaseAgentServiceStatus?.installed
            ? config.release_agent_service_name
            : null,
        },
        {
          label: '正式版 Hub',
          port: config.release_hub_port,
          serviceName: releaseHubServiceStatus?.installed
            ? config.release_hub_service_name
            : null,
        },
      ],
      installCommand: input.installCommand ?? null,
      startServices: [
        {
          label: '正式版 Hub',
          serviceName: releaseHubServiceStatus?.installed
            ? config.release_hub_service_name
            : null,
          command: releaseHubCommand,
          probeUrl: buildHttpBaseUrl(config.release_hub_port, ''),
          probePath: '/health',
          timeoutMs: RELEASE_RESTART_PROBE_TIMEOUT_MS,
        },
        {
          label: '正式版 Agent',
          serviceName: releaseAgentServiceStatus?.installed
            ? config.release_agent_service_name
            : null,
          command: releaseAgentCommand,
          probeUrl: config.release_agent_direct_base_url,
          probePath: '/health',
          timeoutMs: RELEASE_RESTART_PROBE_TIMEOUT_MS,
        },
      ],
    })

    const helperLaunch = await launchDetachedHelper(helperSourcePath, helperPayloadPath)

    logger.info({
      jobId: job.id,
      helperSourcePath,
      helperPayloadPath,
      helperLaunchMode: helperLaunch.mode,
      helperPid: helperLaunch.pid,
    }, 'Spawned detached release install helper.')

    return job
  }

  const installLatestReleasePackage = async () => {
    const { config } = await readStoredConfig(codexHome)
    const executionRoot = getExecutionRoot(config)

    return runManagedJob('release-install-package', '安装最新正式版 npm 包', async (job) => {
      await job.append('info', '准备安装最新正式版 npm 包。')
      const command = await resolveManagedCommand({
        projectPath: executionRoot,
        command: `npm install -g ${RELEASE_PACKAGE_NAME}@latest --registry=${NPM_REGISTRY_URL}`,
        nodeVersion: config.nvm_version,
      })
      await runCommandWithLogs(command, job, '安装最新正式版 npm 包')

      let installedVersion: string | null = null
      try {
        installedVersion = await refreshInstalledPackageVersion()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await job.append('warn', `安装完成，但刷新本地版本缓存失败：${message}`)
      }

      await job.succeed(
        installedVersion
          ? `最新正式版 npm 包安装完成，当前版本 ${installedVersion}。`
          : '最新正式版 npm 包安装完成。',
      )
    })
  }

  const restartReleaseServices = async () =>
    await spawnReleaseRecoveryHelper({
      kind: 'release-restart',
      title: '重启正式版 Hub + Agent',
      workflowLabel: '正式版重启',
    })

  const installLatestRelease = async () => {
    const { config } = await readStoredConfig(codexHome)
    const executionRoot = getExecutionRoot(config)
    const installCommand = await resolveManagedCommand({
      projectPath: executionRoot,
      command: `npm install -g ${RELEASE_PACKAGE_NAME}@latest --registry=${NPM_REGISTRY_URL}`,
      nodeVersion: config.nvm_version,
    })

    return await spawnReleaseRecoveryHelper({
      kind: 'release-install-run',
      title: '安装并运行最新正式版',
      workflowLabel: '正式版升级',
      installCommand,
    })
  }

  const readApkDownload = async (expectedArtifactId?: string | null) => {
    const { config } = await readStoredConfig(codexHome)
    const artifact = await readApkArtifact(config)
    if (!artifact || !config.repo_path) {
      return null
    }
    if (normalizeNullableText(expectedArtifactId) && artifact.artifact_id !== expectedArtifactId) {
      return null
    }

    return {
      artifact,
      filePath: path.join(config.repo_path, 'release', 'android', 'panda-android-release.apk'),
    }
  }

  const executeAction = async (
    action:
      | 'start-development'
      | 'restart-development'
      | 'stop-development'
      | 'probe-development'
      | 'publish-npm'
      | 'install-release-services'
      | 'uninstall-release-services'
      | 'install-latest-release-package'
      | 'restart-release-services'
      | 'install-latest-release'
      | 'build-apk',
  ): Promise<DevManagerActionResponse> => {
    const job =
      action === 'start-development'
        ? await runDevelopmentLifecycle('start')
        : action === 'restart-development'
          ? await runDevelopmentLifecycle('restart')
          : action === 'stop-development'
          ? await runDevelopmentLifecycle('stop')
          : action === 'probe-development'
            ? await runDevelopmentLifecycle('probe')
            : action === 'publish-npm'
              ? await runNpmPublish()
              : action === 'install-release-services'
                ? await installReleaseServices()
                : action === 'uninstall-release-services'
                  ? await uninstallReleaseServices()
                  : action === 'install-latest-release-package'
                    ? await installLatestReleasePackage()
                    : action === 'restart-release-services'
                      ? await restartReleaseServices()
                      : action === 'build-apk'
                        ? await runApkBuild()
                        : await installLatestRelease()

    return {
      ok: true,
      job,
      snapshot: await readSnapshot({
        includeServiceProbe: action === 'probe-development',
      }),
    }
  }

  return {
    readSnapshot,
    saveConfig,
    executeAction,
    readApkDownload,
  }
}
