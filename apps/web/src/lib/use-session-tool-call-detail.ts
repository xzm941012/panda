import { useQuery } from '@tanstack/react-query'
import type { SessionToolCallDetail } from '@panda/protocol'
import { resolveConnectionTarget, type ConnectionTargetScope } from './client'

type UseSessionToolCallDetailOptions = {
  sessionId?: string | null
  entryId?: string | null
  scope?: ConnectionTargetScope
  enabled?: boolean
}

export const getSessionToolCallDetailQueryKey = (
  options?: UseSessionToolCallDetailOptions,
) => [
  'session-tool-detail',
  options?.scope?.sessionId ?? '',
  options?.scope?.sessionId ? '' : (options?.scope?.agentId ?? ''),
  options?.sessionId ?? '',
  options?.entryId ?? '',
] as const

export function useSessionToolCallDetail(options?: UseSessionToolCallDetailOptions) {
  return useQuery<SessionToolCallDetail | null>({
    queryKey: getSessionToolCallDetailQueryKey(options),
    enabled:
      Boolean(options?.enabled ?? true) &&
      Boolean(options?.sessionId) &&
      Boolean(options?.entryId),
    queryFn: async () => {
      if (!options?.sessionId || !options?.entryId) {
        return null
      }

      const target = await resolveConnectionTarget(options.scope)
      return target.client.getSessionToolCallDetail(options.sessionId, options.entryId)
    },
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: 1,
  })
}
