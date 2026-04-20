import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installOrUpdateWindowsService,
  queryWindowsServiceStatus,
  restartWindowsService,
  startWindowsService,
  stopWindowsService,
  uninstallWindowsService,
} from '../../shared/src/windows-service'

type LoggerLike = Pick<typeof console, 'info' | 'warn'>

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(currentDirectory, '..')
const defaultServiceName = 'PandaAgent'

const trimToNull = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

const normalizeServiceName = (value: string | null | undefined) =>
  trimToNull(value) ?? defaultServiceName

const joinScriptOptions = (argv: string[]) =>
  argv
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' ')

const buildAgentServiceDefinition = (options?: {
  name?: string | null
  scriptOptions?: string | null
  env?: NodeJS.ProcessEnv
}) => ({
  name: normalizeServiceName(options?.name),
  description: 'Panda Agent Windows service',
  scriptPath: path.join(packageRoot, 'bin', 'panda-agent.cjs'),
  scriptOptions: trimToNull(options?.scriptOptions),
  workingDirectory: packageRoot,
  env: options?.env ?? process.env,
})

const parseAgentServiceCommand = (argv: string[]) => {
  let action: string | null = null
  let name: string | null = null
  let shouldStart = true
  const runtimeArgs: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const candidate = argv[index]?.trim() ?? ''
    if (!candidate) {
      continue
    }

    if (!action) {
      action = candidate.toLowerCase()
      continue
    }

    const normalized = candidate.toLowerCase()
    if (
      normalized === '--name' ||
      normalized === 'name' ||
      normalized === '--service-name' ||
      normalized === 'service-name'
    ) {
      name = trimToNull(argv[index + 1])
      index += 1
      continue
    }

    if (
      normalized.startsWith('--name=') ||
      normalized.startsWith('name=') ||
      normalized.startsWith('--service-name=') ||
      normalized.startsWith('service-name=')
    ) {
      name = trimToNull(candidate.slice(candidate.indexOf('=') + 1))
      continue
    }

    if (normalized === '--no-start') {
      shouldStart = false
      continue
    }

    runtimeArgs.push(candidate)
  }

  return {
    action: action ?? 'status',
    name,
    shouldStart,
    runtimeArgs,
  }
}

export const manageJamiexiongrAgentService = async (options?: {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  logger?: LoggerLike
}) => {
  const logger = options?.logger ?? console
  const parsed = parseAgentServiceCommand(options?.argv ?? [])
  const action = parsed.action
  const definition = buildAgentServiceDefinition({
    name: parsed.name,
    scriptOptions: joinScriptOptions(parsed.runtimeArgs),
    env: options?.env,
  })

  if (action === 'install' || action === 'update' || action === 'upsert' || action === 'sync') {
    const result = await installOrUpdateWindowsService(definition, {
      start: parsed.shouldStart,
    })
    if (result.startError) {
      logger.warn(
        `Windows 服务 ${definition.name} 已注册，但启动失败：${result.startError}`,
      )
      return result
    }

    logger.info(
      result.started
        ? `Windows 服务 ${definition.name} 已注册并启动。`
        : `Windows 服务 ${definition.name} 已注册。`,
    )
    return result
  }

  if (action === 'uninstall' || action === 'remove' || action === 'delete') {
    const status = await uninstallWindowsService(definition)
    logger.info(
      status.exists
        ? `Windows 服务 ${definition.name} 卸载后仍存在，请检查系统服务管理器。`
        : `Windows 服务 ${definition.name} 已卸载。`,
    )
    return {
      status,
      started: false,
      startError: null,
    }
  }

  if (action === 'start') {
    const status = await startWindowsService(definition.name)
    logger.info(`Windows 服务 ${definition.name} 当前状态：${status.state}`)
    return {
      status,
      started: status.state === 'running',
      startError: null,
    }
  }

  if (action === 'stop') {
    const status = await stopWindowsService(definition.name)
    logger.info(`Windows 服务 ${definition.name} 当前状态：${status.state}`)
    return {
      status,
      started: false,
      startError: null,
    }
  }

  if (action === 'restart') {
    const status = await restartWindowsService(definition.name)
    logger.info(`Windows 服务 ${definition.name} 当前状态：${status.state}`)
    return {
      status,
      started: status.state === 'running',
      startError: null,
    }
  }

  if (action === 'status') {
    const status = queryWindowsServiceStatus(definition.name)
    logger.info(
      status.exists
        ? `Windows 服务 ${definition.name} 当前状态：${status.state}`
        : `Windows 服务 ${definition.name} 尚未注册。`,
    )
    return {
      status,
      started: status.state === 'running',
      startError: null,
    }
  }

  throw new Error(`Unknown agent service action: ${action}`)
}
