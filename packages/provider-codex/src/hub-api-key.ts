import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type HubApiKeyLogger = {
  info?: (message: string, ...args: unknown[]) => void
  warn?: (message: string, ...args: unknown[]) => void
}

type ResolvePandaHubApiKeyOptions = {
  configuredApiKey?: string | null
  codexHome?: string | null
  logger?: HubApiKeyLogger
}

export type ResolvedPandaHubApiKey = {
  apiKey: string | null
  filePath: string
  source: 'env' | 'file' | 'generated' | 'missing'
}

const trimToNull = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  return normalized ? normalized : null
}

const defaultPandaHome = (codexHome?: string | null) =>
  trimToNull(codexHome) ??
  trimToNull(process.env.PANDA_CODEX_HOME) ??
  path.join(os.homedir(), '.panda')

export const getPandaHubApiKeyFilePath = (codexHome?: string | null) =>
  path.join(defaultPandaHome(codexHome), 'secrets', 'hub-api-key')

const readStoredHubApiKey = async (filePath: string) => {
  try {
    return trimToNull(await fs.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

const writeStoredHubApiKey = async (
  filePath: string,
  apiKey: string,
  options?: { exclusive?: boolean },
) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${apiKey}\n`, {
    encoding: 'utf8',
    flag: options?.exclusive ? 'wx' : 'w',
    mode: 0o600,
  })
}

export const resolvePandaHubApiKey = async (
  options?: ResolvePandaHubApiKeyOptions,
): Promise<ResolvedPandaHubApiKey> => {
  const apiKey = trimToNull(options?.configuredApiKey)
  const filePath = getPandaHubApiKeyFilePath(options?.codexHome)

  if (apiKey) {
    return {
      apiKey,
      filePath,
      source: 'env',
    }
  }

  const storedApiKey = await readStoredHubApiKey(filePath)
  if (storedApiKey) {
    return {
      apiKey: storedApiKey,
      filePath,
      source: 'file',
    }
  }

  return {
    apiKey: null,
    filePath,
    source: 'missing',
  }
}

export const ensurePandaHubApiKey = async (
  options?: ResolvePandaHubApiKeyOptions,
): Promise<ResolvedPandaHubApiKey> => {
  const resolved = await resolvePandaHubApiKey(options)
  if (resolved.source === 'env') {
    const configuredApiKey = resolved.apiKey
    if (!configuredApiKey) {
      throw new Error('Resolved Panda hub API key from env is empty.')
    }

    const storedApiKey = await readStoredHubApiKey(resolved.filePath)
    if (storedApiKey !== configuredApiKey) {
      await writeStoredHubApiKey(resolved.filePath, configuredApiKey)
      options?.logger?.info?.(
        storedApiKey
          ? `Updated Panda hub API key file at ${resolved.filePath} from PANDA_HUB_API_KEY.`
          : `Persisted Panda hub API key to ${resolved.filePath} from PANDA_HUB_API_KEY.`,
      )
    }

    return resolved
  }

  if (resolved.source === 'file') {
    return resolved
  }

  const generatedApiKey = randomBytes(32).toString('hex')
  try {
    await writeStoredHubApiKey(resolved.filePath, generatedApiKey, {
      exclusive: true,
    })
    options?.logger?.info?.(
      `Generated Panda hub API key at ${resolved.filePath}. Share this key with agents: ${generatedApiKey}`,
    )
    return {
      apiKey: generatedApiKey,
      filePath: resolved.filePath,
      source: 'generated',
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }

    const storedApiKey = await readStoredHubApiKey(resolved.filePath)
    if (!storedApiKey) {
      throw error
    }

    return {
      apiKey: storedApiKey,
      filePath: resolved.filePath,
      source: 'file',
    }
  }
}
