import { execFileSync } from 'node:child_process'

type LoggerLike = {
  info?: (message: string, ...args: unknown[]) => void
  warn?: (message: string, ...args: unknown[]) => void
}

export type TailscaleStatusJson = {
  BackendState?: string
  Self?: {
    DNSName?: string
    TailscaleIPs?: string[]
  }
}

export type ConfiguredTailscaleServe = {
  enabled: boolean
  active: boolean
  mode: TailscalePublicationMode
  servePort: number | null
  dnsName: string | null
  tailscaleIp: string | null
  baseUrl: string | null
  wsBaseUrl: string | null
  reason:
    | 'disabled'
    | 'unavailable'
    | 'offline'
    | 'missing-dns'
    | 'failed'
    | 'configured'
}

export type TailscalePublicationMode = 'disabled' | 'serve' | 'funnel'

const ENABLED_ARGS = new Set([
  'tailscareserv',
  '--tailscareserv',
  'tailscale-serve',
  '--tailscale-serve',
])

const PUBLIC_ARGS = new Set([
  'tailscareserv-pub',
  '--tailscareserv-pub',
  'tailscale-serve-pub',
  '--tailscale-serve-pub',
  'tailscalefunnel',
  '--tailscalefunnel',
  'tailscale-funnel',
  '--tailscale-funnel',
])

const DISABLED_ARGS = new Set([
  'no-tailscareserv',
  '--no-tailscareserv',
  'no-tailscale-serve',
  '--no-tailscale-serve',
  'no-tailscareserv-pub',
  '--no-tailscareserv-pub',
  'no-tailscale-serve-pub',
  '--no-tailscale-serve-pub',
  'no-tailscalefunnel',
  '--no-tailscalefunnel',
  'no-tailscale-funnel',
  '--no-tailscale-funnel',
])

const trimToNull = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  return normalized ? normalized : null
}

const normalizeDnsName = (value: string | null | undefined) => {
  const normalized = trimToNull(value)
  if (!normalized) {
    return null
  }

  return normalized.replace(/\.+$/, '')
}

export const buildTailscaleHttpsUrl = (options: {
  dnsName: string | null | undefined
  servePort: number
}) => {
  const dnsName = normalizeDnsName(options.dnsName)
  if (!dnsName) {
    return null
  }

  return `https://${dnsName}${options.servePort === 443 ? '' : `:${options.servePort}`}`
}

const toWsUrl = (baseUrl: string) => {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  return url.toString()
}

export const resolveCliOptionValue = (options: {
  argv?: string[]
  aliases: string[]
}) => {
  const argv = options.argv ?? []
  const aliases = options.aliases.map((alias) => alias.trim().toLowerCase()).filter(Boolean)

  for (let index = 0; index < argv.length; index += 1) {
    const candidate = argv[index]?.trim() ?? ''
    const normalized = candidate.toLowerCase()

    for (const alias of aliases) {
      if (normalized === alias) {
        return trimToNull(argv[index + 1])
      }

      if (normalized.startsWith(`${alias}=`)) {
        return trimToNull(candidate.slice(alias.length + 1))
      }
    }
  }

  return null
}

const parseBooleanLike = (value: string | null | undefined) => {
  const normalized = trimToNull(value)?.toLowerCase()
  if (!normalized) {
    return null
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return null
}

const parsePublicationModeLike = (value: string | null | undefined): TailscalePublicationMode | null => {
  const normalized = trimToNull(value)?.toLowerCase()
  if (!normalized) {
    return null
  }

  if (['serve', 'private', 'tailnet'].includes(normalized)) {
    return 'serve'
  }

  if (['funnel', 'public', 'pub'].includes(normalized)) {
    return 'funnel'
  }

  if (['disabled', 'none', 'off'].includes(normalized)) {
    return 'disabled'
  }

  return null
}

const parsePort = (value: string | null | undefined) => {
  const normalized = trimToNull(value)
  if (!normalized) {
    return null
  }

  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    return null
  }

  return parsed
}

const trimExecOutput = (value: string | Buffer | null | undefined) => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }

  if (Buffer.isBuffer(value)) {
    const trimmed = value.toString('utf8').trim()
    return trimmed || null
  }

  return null
}

const describeExecError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return 'tailscale serve failed'
  }

  const commandError = error as Error & {
    stdout?: string | Buffer | null
    stderr?: string | Buffer | null
  }
  const output = trimExecOutput(commandError.stderr) ?? trimExecOutput(commandError.stdout)

  return output ?? error.message
}

export const readTailscaleStatus = (): TailscaleStatusJson | null => {
  try {
    const stdout = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 2_500,
    })
    return JSON.parse(stdout) as TailscaleStatusJson
  } catch {
    return null
  }
}

export const isTailscaleRunning = (status: TailscaleStatusJson | null) => {
  if (!status?.Self) {
    return false
  }

  const backendState = trimToNull(status.BackendState)?.toLowerCase()
  if (backendState && backendState !== 'running') {
    return false
  }

  return Boolean(
    normalizeDnsName(status.Self.DNSName) ?? trimToNull(status.Self.TailscaleIPs?.[0]),
  )
}

export const resolveTailscaleServeEnabled = (options?: {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  envPrefix?: 'PANDA_HUB' | 'PANDA_AGENT'
}) => {
  return (
    resolveTailscalePublicationMode({
      argv: options?.argv,
      env: options?.env,
      envPrefix: options?.envPrefix,
    }) === 'serve'
  )
}

export const resolveTailscalePublicationMode = (options?: {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  envPrefix?: 'PANDA_HUB' | 'PANDA_AGENT'
}): TailscalePublicationMode => {
  const argv = options?.argv ?? []
  for (const candidate of argv) {
    const normalized = candidate.trim().toLowerCase()
    if (PUBLIC_ARGS.has(normalized)) {
      return 'funnel'
    }

    if (ENABLED_ARGS.has(normalized)) {
      return 'serve'
    }

    if (DISABLED_ARGS.has(normalized)) {
      return 'disabled'
    }
  }

  const env = options?.env ?? process.env
  const scopedMode = options?.envPrefix
    ? parsePublicationModeLike(env[`${options.envPrefix}_TAILSCALE_PUBLISH_MODE`])
    : null
  if (scopedMode) {
    return scopedMode
  }

  const genericMode = parsePublicationModeLike(env.PANDA_TAILSCALE_PUBLISH_MODE)
  if (genericMode) {
    return genericMode
  }

  const scopedEnabled = options?.envPrefix
    ? parseBooleanLike(env[`${options.envPrefix}_TAILSCALE_SERVE`])
    : null
  if (scopedEnabled !== null) {
    return scopedEnabled ? 'serve' : 'disabled'
  }

  const envEnabled = parseBooleanLike(env.PANDA_TAILSCALE_SERVE)
  if (envEnabled !== null) {
    return envEnabled ? 'serve' : 'disabled'
  }

  return 'disabled'
}

export const resolveTailscaleServePort = (options: {
  defaultPort: number
  envPrefix?: 'PANDA_HUB' | 'PANDA_AGENT'
  env?: NodeJS.ProcessEnv
}) => {
  const env = options.env ?? process.env
  const scopedPort = options.envPrefix
    ? parsePort(env[`${options.envPrefix}_TAILSCALE_SERVE_PORT`])
    : null
  const genericPort = parsePort(env.PANDA_TAILSCALE_SERVE_PORT)
  return scopedPort ?? genericPort ?? options.defaultPort
}

export const configureTailscaleServe = (options: {
  enabled: boolean
  serviceName: string
  localPort: number
  servePort: number
  logger?: LoggerLike
  mode?: Exclude<TailscalePublicationMode, 'disabled'>
}): ConfiguredTailscaleServe => {
  const mode = options.enabled ? (options.mode ?? 'serve') : 'disabled'
  const publishCommand = mode === 'funnel' ? 'funnel' : 'serve'
  const publishLabel = mode === 'funnel' ? 'Tailscale Funnel' : 'Tailscale Serve'

  if (!options.enabled) {
    return {
      enabled: false,
      active: false,
      mode,
      servePort: null,
      dnsName: null,
      tailscaleIp: null,
      baseUrl: null,
      wsBaseUrl: null,
      reason: 'disabled',
    }
  }

  const status = readTailscaleStatus()
  if (!status) {
    options.logger?.warn?.(
      `Skipping ${publishLabel} for ${options.serviceName}: tailscale CLI is unavailable or not logged in.`,
    )
    return {
      enabled: true,
      active: false,
      mode,
      servePort: options.servePort,
      dnsName: null,
      tailscaleIp: null,
      baseUrl: null,
      wsBaseUrl: null,
      reason: 'unavailable',
    }
  }

  if (!isTailscaleRunning(status)) {
    options.logger?.warn?.(
      `Skipping ${publishLabel} for ${options.serviceName}: Tailscale is not running.`,
    )
    return {
      enabled: true,
      active: false,
      mode,
      servePort: options.servePort,
      dnsName: normalizeDnsName(status.Self?.DNSName),
      tailscaleIp: trimToNull(status.Self?.TailscaleIPs?.[0]),
      baseUrl: null,
      wsBaseUrl: null,
      reason: 'offline',
    }
  }

  const dnsName = normalizeDnsName(status.Self?.DNSName)
  const tailscaleIp = trimToNull(status.Self?.TailscaleIPs?.[0])
  if (!dnsName) {
    options.logger?.warn?.(
      `Skipping ${publishLabel} for ${options.serviceName}: MagicDNS name is unavailable.`,
    )
    return {
      enabled: true,
      active: false,
      mode,
      servePort: options.servePort,
      dnsName: null,
      tailscaleIp,
      baseUrl: null,
      wsBaseUrl: null,
      reason: 'missing-dns',
    }
  }

  try {
    execFileSync(
      'tailscale',
      [
        publishCommand,
        '--yes',
        '--bg',
        `--https=${options.servePort}`,
        `http://127.0.0.1:${options.localPort}`,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 5_000,
      },
    )
  } catch (error) {
    const message = describeExecError(error)
    options.logger?.warn?.(
      `Unable to publish ${options.serviceName} via ${publishLabel}: ${message}`,
    )
    return {
      enabled: true,
      active: false,
      mode,
      servePort: options.servePort,
      dnsName,
      tailscaleIp,
      baseUrl: null,
      wsBaseUrl: null,
      reason: 'failed',
    }
  }

  const baseUrl = buildTailscaleHttpsUrl({
    dnsName,
    servePort: options.servePort,
  })
  if (!baseUrl) {
    return {
      enabled: true,
      active: false,
      mode,
      servePort: options.servePort,
      dnsName,
      tailscaleIp,
      baseUrl: null,
      wsBaseUrl: null,
      reason: 'missing-dns',
    }
  }
  options.logger?.info?.(
    `Published ${options.serviceName} over ${publishLabel} at ${baseUrl}`,
  )

  return {
    enabled: true,
    active: true,
    mode,
    servePort: options.servePort,
    dnsName,
    tailscaleIp,
    baseUrl,
    wsBaseUrl: toWsUrl(baseUrl),
    reason: 'configured',
  }
}
