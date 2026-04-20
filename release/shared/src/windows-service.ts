import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

export type WindowsServiceState = 'running' | 'stopped' | 'missing' | 'unknown'

export type WindowsServiceStatus = {
  name: string
  displayName: string
  controllerName: string
  exists: boolean
  state: WindowsServiceState
  rawOutput: string
}

export type WindowsServiceDefinition = {
  name: string
  id?: string | null
  description: string
  scriptPath: string
  scriptOptions?: string | null
  workingDirectory?: string | null
  execPath?: string | null
  env?: NodeJS.ProcessEnv
}

export type WindowsServiceInstallResult = {
  status: WindowsServiceStatus
  started: boolean
  startError: string | null
}

type NodeWindowsServiceInstance = NodeJS.EventEmitter & {
  install: () => void
  uninstall: () => void
  exists: boolean
}

type NodeWindowsServiceConstructor = new (config: {
  id?: string
  name: string
  description: string
  script: string
  scriptOptions?: string
  workingDirectory?: string
  execPath?: string
  env?: Array<{ name: string; value: string }>
}) => NodeWindowsServiceInstance

const require = createRequire(import.meta.url)
let cachedServiceConstructor: NodeWindowsServiceConstructor | null = null

const WINDOWS_SERVICE_TIMEOUT_MS = 20_000

const ensureWindows = () => {
  if (process.platform !== 'win32') {
    throw new Error('Windows 服务管理当前只支持 Windows。')
  }
}

const trimToNull = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

const escapePowerShellString = (value: string) => value.replace(/'/g, "''")

const quoteForSc = (value: string) => value.trim()

const sanitizeNodeWindowsServiceId = (value: string) =>
  `${value.replace(/[^\w]/g, '').toLowerCase()}.exe`

const resolveWindowsServiceReference = (input: string | WindowsServiceDefinition) => {
  const displayName = typeof input === 'string' ? input : input.name
  const controllerName =
    typeof input === 'string'
      ? sanitizeNodeWindowsServiceId(displayName)
      : trimToNull(input.id) ?? sanitizeNodeWindowsServiceId(displayName)
  return {
    displayName,
    controllerName,
  }
}

const describeCommandFailure = (output: string, fallback: string) => {
  const normalized = trimToNull(output)
  return normalized ?? fallback
}

const runPowerShell = (script: string) =>
  spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })

const runSc = (args: string[]) => {
  ensureWindows()
  const command = ['sc.exe', ...args.map((value) => (/[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value))].join(' ')
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

const parseWindowsServiceState = (output: string): WindowsServiceState => {
  const normalized = output.trim().toLowerCase()
  if (normalized === '__missing__') {
    return 'missing'
  }

  if (normalized === 'running') {
    return 'running'
  }

  if (normalized === 'stopped') {
    return 'stopped'
  }

  return 'unknown'
}

export const queryWindowsServiceStatus = (
  input: string | WindowsServiceDefinition,
): WindowsServiceStatus => {
  ensureWindows()
  const reference = resolveWindowsServiceReference(input)
  const result = runPowerShell(
    [
      `$service = Get-Service -Name '${escapePowerShellString(reference.controllerName)}' -ErrorAction SilentlyContinue`,
      `if ($null -eq $service) { $service = Get-Service -DisplayName '${escapePowerShellString(reference.displayName)}' -ErrorAction SilentlyContinue }`,
      `if ($null -eq $service) { '__MISSING__' } else { @{ Name = $service.Name; DisplayName = $service.DisplayName; Status = $service.Status.ToString() } | ConvertTo-Json -Compress }`,
    ].join('; '),
  )
  const rawOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  let controllerName = reference.controllerName
  let displayName = reference.displayName
  let state = parseWindowsServiceState(rawOutput)

  if (state !== 'missing') {
    try {
      const parsed = JSON.parse(rawOutput) as {
        Name?: string
        DisplayName?: string
        Status?: string
      }
      controllerName = trimToNull(parsed.Name) ?? controllerName
      displayName = trimToNull(parsed.DisplayName) ?? displayName
      state = parseWindowsServiceState(trimToNull(parsed.Status) ?? rawOutput)
    } catch {
      // Keep raw fallback parsing for unexpected output.
    }
  }

  return {
    name: displayName,
    displayName,
    controllerName,
    exists: state !== 'missing',
    state,
    rawOutput,
  }
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const waitForWindowsServiceState = async (
  input: string | WindowsServiceDefinition,
  desiredState: Exclude<WindowsServiceState, 'unknown'>,
  timeoutMs = WINDOWS_SERVICE_TIMEOUT_MS,
) => {
  const startedAt = Date.now()
  let latest = queryWindowsServiceStatus(input)
  while (latest.state !== desiredState && Date.now() - startedAt < timeoutMs) {
    await wait(750)
    latest = queryWindowsServiceStatus(input)
  }
  return latest
}

const waitForWindowsServicePresence = async (
  input: string | WindowsServiceDefinition,
  timeoutMs = WINDOWS_SERVICE_TIMEOUT_MS,
) => {
  const startedAt = Date.now()
  let latest = queryWindowsServiceStatus(input)
  while (!latest.exists && Date.now() - startedAt < timeoutMs) {
    await wait(750)
    latest = queryWindowsServiceStatus(input)
  }
  return latest
}

export const startWindowsService = async (input: string | WindowsServiceDefinition) => {
  ensureWindows()
  const current = queryWindowsServiceStatus(input)
  if (!current.exists) {
    throw new Error(`Windows 服务 ${current.displayName} 不存在。`)
  }
  if (current.state === 'running') {
    return current
  }

  const result = runPowerShell(
    `Start-Service -Name '${escapePowerShellString(current.controllerName)}' -ErrorAction Stop`,
  )
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  const latest = await waitForWindowsServiceState(input, 'running')
  if (latest.state !== 'running') {
    throw new Error(
      describeCommandFailure(output || latest.rawOutput, `启动服务 ${current.displayName} 失败。`),
    )
  }
  return latest
}

export const stopWindowsService = async (input: string | WindowsServiceDefinition) => {
  ensureWindows()
  const current = queryWindowsServiceStatus(input)
  if (!current.exists || current.state === 'stopped') {
    return current
  }

  const result = runPowerShell(
    `Stop-Service -Name '${escapePowerShellString(current.controllerName)}' -Force -ErrorAction Stop`,
  )
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  const latest = await waitForWindowsServiceState(input, 'stopped')
  if (latest.state !== 'stopped') {
    throw new Error(
      describeCommandFailure(output || latest.rawOutput, `停止服务 ${current.displayName} 失败。`),
    )
  }
  return latest
}

export const restartWindowsService = async (input: string | WindowsServiceDefinition) => {
  await stopWindowsService(input)
  return await startWindowsService(input)
}

const resolveDefaultPandaCodexHome = (env?: NodeJS.ProcessEnv) =>
  trimToNull(env?.PANDA_CODEX_HOME) ?? path.join(os.homedir(), '.codex')

const collectServiceEnvironment = (env?: NodeJS.ProcessEnv) => {
  const collected = new Map<string, string>()
  const defaultCodexHome = resolveDefaultPandaCodexHome(env)
  collected.set('PANDA_CODEX_HOME', defaultCodexHome)
  collected.set('CODEX_HOME', trimToNull(env?.CODEX_HOME) ?? defaultCodexHome)

  for (const [key, value] of Object.entries(env ?? process.env)) {
    if (
      (!key.startsWith('PANDA_') && key !== 'CODEX_HOME') ||
      typeof value !== 'string' ||
      !value.trim()
    ) {
      continue
    }
    collected.set(key, value.trim())
  }

  return [...collected.entries()].map(([name, value]) => ({
    name,
    value,
  }))
}

const getNodeWindowsServiceConstructor = () => {
  if (cachedServiceConstructor) {
    return cachedServiceConstructor
  }

  const mod = require('node-windows') as {
    Service?: NodeWindowsServiceConstructor
  }
  if (!mod.Service) {
    throw new Error('缺少 node-windows 依赖，无法注册 Windows 服务。')
  }
  cachedServiceConstructor = mod.Service
  return cachedServiceConstructor
}

const createNodeWindowsService = (definition: WindowsServiceDefinition) => {
  ensureWindows()
  const Service = getNodeWindowsServiceConstructor()
  return new Service({
    id: resolveWindowsServiceReference(definition).controllerName,
    name: definition.name,
    description: definition.description,
    script: definition.scriptPath,
    scriptOptions: trimToNull(definition.scriptOptions) ?? undefined,
    workingDirectory: trimToNull(definition.workingDirectory) ?? undefined,
    execPath: trimToNull(definition.execPath) ?? process.execPath,
    env: collectServiceEnvironment(definition.env),
  })
}

const waitForNodeWindowsAction = async (
  service: NodeWindowsServiceInstance,
  action: 'install' | 'uninstall',
) =>
  await new Promise<void>((resolve, reject) => {
    let settled = false

    const finish = (error?: Error) => {
      if (settled) {
        return
      }
      settled = true
      if (error) {
        reject(error)
        return
      }
      resolve()
    }

    const fail = (error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    }

    service.once(action, () => finish())
    service.once(action === 'install' ? 'alreadyinstalled' : 'alreadyuninstalled', () => finish())
    service.once('invalidinstallation', () =>
      fail(new Error(`Windows 服务 ${service.exists ? '安装' : '卸载'}状态无效。`)),
    )
    service.once('error', fail)

    try {
      service[action]()
    } catch (error) {
      fail(error)
    }
  })

export const uninstallWindowsService = async (definition: WindowsServiceDefinition) => {
  ensureWindows()
  const current = queryWindowsServiceStatus(definition)
  if (!current.exists) {
    return current
  }

  if (current.state === 'running') {
    await stopWindowsService(definition)
  }

  const service = createNodeWindowsService(definition)
  await waitForNodeWindowsAction(service, 'uninstall')
  return queryWindowsServiceStatus(definition)
}

export const installOrUpdateWindowsService = async (
  definition: WindowsServiceDefinition,
  options?: {
    start?: boolean
  },
): Promise<WindowsServiceInstallResult> => {
  ensureWindows()
  const reference = resolveWindowsServiceReference(definition)
  const existing = queryWindowsServiceStatus(definition)
  if (existing.exists) {
    await uninstallWindowsService(definition)
  }

  const service = createNodeWindowsService(definition)
  await waitForNodeWindowsAction(service, 'install')
  const installed = await waitForWindowsServicePresence(definition)
  if (!installed.exists) {
    throw new Error(`Windows 服务 ${reference.displayName} 注册后仍不可见，请稍后重试。`)
  }

  runSc(['config', quoteForSc(installed.controllerName), 'start=', 'auto'])

  let started = false
  let startError: string | null = null
  if (options?.start !== false) {
    try {
      const startedStatus = await startWindowsService(definition)
      started = startedStatus.state === 'running'
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    status: queryWindowsServiceStatus(definition),
    started,
    startError,
  }
}
