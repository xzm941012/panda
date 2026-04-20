import { useQuery } from '@tanstack/react-query'
import {
  resolveConnectionTarget,
  type ConnectionTargetScope,
} from './client'

export const getCodexCommandsQueryKey = (scope?: ConnectionTargetScope) => [
  'codex-commands',
  scope?.agentId?.trim() ?? '',
  scope?.projectId?.trim() ?? '',
  scope?.sessionId?.trim() ?? '',
] as const

export const useCodexCommands = (options?: {
  enabled?: boolean
  scope?: ConnectionTargetScope
}) => {
  const enabled = options?.enabled ?? true

  return useQuery({
    queryKey: getCodexCommandsQueryKey(options?.scope),
    enabled,
    queryFn: async () => {
      const target = await resolveConnectionTarget(options?.scope)
      return target.client.getCodexCommands()
    },
    staleTime: 0,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  })
}
