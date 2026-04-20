import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  webPushDeviceSchema,
  webPushSubscriptionSchema,
  webPushSubscriptionSettingsSchema,
  type WebPushDevice,
  type WebPushSubscription,
  type WebPushSubscriptionResponse,
  type WebPushSubscriptionSettings,
} from '@panda/protocol'

type LoggerLike = {
  info?: (payload: Record<string, unknown>, message: string) => void
  warn?: (payload: Record<string, unknown>, message: string) => void
  error?: (payload: Record<string, unknown>, message: string) => void
}

const storedHubPushSubscriptionSchema = z.object({
  id: z.string(),
  subscription: webPushSubscriptionSchema,
  settings: webPushSubscriptionSettingsSchema,
  device: webPushDeviceSchema,
  created_at: z.string(),
  updated_at: z.string(),
  last_success_at: z.string().nullable().default(null),
  last_failure_at: z.string().nullable().default(null),
  failure_reason: z.string().nullable().default(null),
})

const pushSubscriptionPersistenceSchema = z.object({
  version: z.literal(1),
  saved_at: z.string(),
  subscriptions: z.array(storedHubPushSubscriptionSchema),
})

export type StoredHubPushSubscription = z.infer<typeof storedHubPushSubscriptionSchema>

export type HubPushSubscriptionStoreOptions = {
  storageFilePath: string
  logger?: LoggerLike
}

const PUSH_SUBSCRIPTION_PERSIST_DEBOUNCE_MS = 300

const isoNow = () => new Date().toISOString()

const buildSubscriptionId = (endpoint: string) =>
  `push-${createHash('sha1').update(endpoint).digest('hex').slice(0, 16)}`

const normalizeDevice = (
  device: Partial<WebPushDevice> | null | undefined,
): WebPushDevice => webPushDeviceSchema.parse(device ?? {})

export const createHubPushSubscriptionStore = ({
  storageFilePath,
  logger,
}: HubPushSubscriptionStoreOptions) => {
  const entries = new Map<string, StoredHubPushSubscription>()
  let persistTimer: NodeJS.Timeout | null = null

  const schedulePersist = () => {
    if (persistTimer) {
      return
    }

    persistTimer = setTimeout(() => {
      persistTimer = null
      void persist().catch((error) => {
        logger?.error?.(
          {
            error: error instanceof Error ? error.message : String(error),
            storageFilePath,
          },
          'Failed to persist Panda hub push subscriptions.',
        )
      })
    }, PUSH_SUBSCRIPTION_PERSIST_DEBOUNCE_MS)
  }

  const persist = async () => {
    const payload = pushSubscriptionPersistenceSchema.parse({
      version: 1,
      saved_at: isoNow(),
      subscriptions: [...entries.values()],
    })

    await fs.mkdir(path.dirname(storageFilePath), { recursive: true })
    await fs.writeFile(storageFilePath, JSON.stringify(payload, null, 2), 'utf8')
  }

  const load = async () => {
    try {
      const raw = await fs.readFile(storageFilePath, 'utf8')
      const parsed = pushSubscriptionPersistenceSchema.parse(JSON.parse(raw))
      for (const entry of parsed.subscriptions) {
        entries.set(entry.subscription.endpoint, entry)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return
      }

      logger?.warn?.(
        {
          error: error instanceof Error ? error.message : String(error),
          storageFilePath,
        },
        'Unable to load Panda hub push subscriptions.',
      )
    }
  }

  const toResponse = (
    entry: StoredHubPushSubscription,
  ): WebPushSubscriptionResponse => ({
    ok: true,
    subscription_id: entry.id,
    endpoint: entry.subscription.endpoint,
    settings: entry.settings,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  })

  const upsert = (input: {
    subscription: WebPushSubscription
    settings: WebPushSubscriptionSettings
    device?: Partial<WebPushDevice> | null
  }): WebPushSubscriptionResponse => {
    const now = isoNow()
    const existing = entries.get(input.subscription.endpoint)
    const nextEntry = storedHubPushSubscriptionSchema.parse({
      id: existing?.id ?? buildSubscriptionId(input.subscription.endpoint),
      subscription: input.subscription,
      settings: input.settings,
      device: normalizeDevice(input.device),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_success_at: existing?.last_success_at ?? null,
      last_failure_at: existing?.last_failure_at ?? null,
      failure_reason: existing?.failure_reason ?? null,
    })

    entries.set(input.subscription.endpoint, nextEntry)
    schedulePersist()
    return toResponse(nextEntry)
  }

  const remove = (endpoint: string) => {
    const removed = entries.delete(endpoint)
    if (removed) {
      schedulePersist()
    }
    return removed
  }

  const get = (endpoint: string) => entries.get(endpoint) ?? null

  const listEnabledForCompletionNotifications = () =>
    [...entries.values()].filter(
      (entry) => entry.settings.completion_notifications_enabled,
    )

  const markDeliveryResult = (
    endpoint: string,
    input: {
      success: boolean
      failureReason?: string | null
      remove?: boolean
    },
  ) => {
    const entry = entries.get(endpoint)
    if (!entry) {
      return
    }

    if (input.remove) {
      entries.delete(endpoint)
      schedulePersist()
      return
    }

    const now = isoNow()
    entries.set(
      endpoint,
      storedHubPushSubscriptionSchema.parse({
        ...entry,
        updated_at: now,
        last_success_at: input.success ? now : entry.last_success_at,
        last_failure_at: input.success ? entry.last_failure_at : now,
        failure_reason: input.success
          ? null
          : input.failureReason?.trim() || 'Push delivery failed.',
      }),
    )
    schedulePersist()
  }

  return {
    load,
    upsert,
    remove,
    get,
    listEnabledForCompletionNotifications,
    markDeliveryResult,
  }
}
