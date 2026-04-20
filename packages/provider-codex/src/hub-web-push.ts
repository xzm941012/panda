import fs from 'node:fs/promises'
import path from 'node:path'
import webpush from 'web-push'
import { z } from 'zod'
import type { WebPushPublicConfig, WebPushSubscription } from '@panda/protocol'

type LoggerLike = {
  info?: (payload: Record<string, unknown>, message: string) => void
  warn?: (payload: Record<string, unknown>, message: string) => void
  error?: (payload: Record<string, unknown>, message: string) => void
}

type StoredVapidConfig = {
  version: 1
  public_key: string
  private_key: string
  subject: string
  created_at: string
  updated_at: string
}

export type HubWebPushPayload = {
  title: string
  body: string
  url: string
  tag: string
  sessionId?: string | null
}

export type HubWebPushNotifierOptions = {
  storageFilePath: string
  publicKey?: string | null
  privateKey?: string | null
  subject?: string | null
  logger?: LoggerLike
}

const storedVapidConfigSchema = z.object({
  version: z.literal(1),
  public_key: z.string(),
  private_key: z.string(),
  subject: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
})

const isoNow = () => new Date().toISOString()

const normalizeSubject = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? ''
  if (trimmed) {
    return trimmed
  }

  return 'mailto:panda@localhost'
}

const loadStoredVapidConfig = async (storageFilePath: string) => {
  try {
    const raw = await fs.readFile(storageFilePath, 'utf8')
    return storedVapidConfigSchema.parse(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

const writeStoredVapidConfig = async (
  storageFilePath: string,
  config: StoredVapidConfig,
) => {
  await fs.mkdir(path.dirname(storageFilePath), { recursive: true })
  await fs.writeFile(storageFilePath, JSON.stringify(config, null, 2), 'utf8')
}

const resolveVapidConfig = async (
  options: HubWebPushNotifierOptions,
): Promise<{
  publicConfig: WebPushPublicConfig
  privateKey: string | null
}> => {
  const configuredPublicKey = options.publicKey?.trim() ?? ''
  const configuredPrivateKey = options.privateKey?.trim() ?? ''
  const subject = normalizeSubject(options.subject)

  if (configuredPublicKey || configuredPrivateKey) {
    if (!configuredPublicKey || !configuredPrivateKey) {
      return {
        publicConfig: {
          supported: false,
          vapid_public_key: null,
          subject: subject ?? null,
          reason: 'PANDA_WEB_PUSH_PUBLIC_KEY and PANDA_WEB_PUSH_PRIVATE_KEY must both be set.',
        },
        privateKey: null,
      }
    }

    return {
      publicConfig: {
        supported: true,
        vapid_public_key: configuredPublicKey,
        subject,
        reason: null,
      },
      privateKey: configuredPrivateKey,
    }
  }

  const stored = await loadStoredVapidConfig(options.storageFilePath)
  if (stored) {
    return {
      publicConfig: {
        supported: true,
        vapid_public_key: stored.public_key,
        subject: stored.subject,
        reason: null,
      },
      privateKey: stored.private_key,
    }
  }

  const generated = webpush.generateVAPIDKeys()
  const now = isoNow()
  const persisted = storedVapidConfigSchema.parse({
    version: 1,
    public_key: generated.publicKey,
    private_key: generated.privateKey,
    subject,
    created_at: now,
    updated_at: now,
  })
  await writeStoredVapidConfig(options.storageFilePath, persisted)
  options.logger?.info?.(
    { storageFilePath: options.storageFilePath },
    'Generated persistent Panda Web Push VAPID keys.',
  )

  return {
    publicConfig: {
      supported: true,
      vapid_public_key: persisted.public_key,
      subject: persisted.subject,
      reason: null,
    },
    privateKey: persisted.private_key,
  }
}

export const createHubWebPushNotifier = async (
  options: HubWebPushNotifierOptions,
) => {
  const resolved = await resolveVapidConfig(options)
  if (
    !resolved.publicConfig.supported ||
    !resolved.publicConfig.vapid_public_key ||
    !resolved.privateKey
  ) {
    return {
      publicConfig: resolved.publicConfig,
      async sendNotification() {
        return {
          ok: false as const,
          statusCode: null,
          shouldRemove: false,
          message: 'Hub Web Push is not configured.',
        }
      },
    }
  }

  webpush.setVapidDetails(
    resolved.publicConfig.subject ?? normalizeSubject(options.subject),
    resolved.publicConfig.vapid_public_key,
    resolved.privateKey,
  )

  return {
    publicConfig: resolved.publicConfig,
    async sendNotification(
      subscription: WebPushSubscription,
      payload: HubWebPushPayload,
    ) {
      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({
            title: payload.title,
            body: payload.body,
            url: payload.url,
            tag: payload.tag,
            sessionId: payload.sessionId ?? null,
          }),
          {
            TTL: 60,
            urgency: 'high',
            topic: payload.tag.slice(0, 32),
          },
        )
        return { ok: true as const, statusCode: 201, shouldRemove: false }
      } catch (error) {
        const statusCode =
          typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          typeof (error as { statusCode?: unknown }).statusCode === 'number'
            ? (error as { statusCode: number }).statusCode
            : null

        return {
          ok: false as const,
          statusCode,
          shouldRemove: statusCode === 404 || statusCode === 410,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
