import { useQuery } from '@tanstack/react-query'
import type { WorkspaceSessionDetailResponse } from '@panda/protocol'
import { resolveConnectionTarget, type ConnectionTargetScope } from './client'

type UseWorkspaceSessionDetailOptions = {
  sessionId?: string | null
  scope?: ConnectionTargetScope
  enabled?: boolean
}

export const getWorkspaceSessionDetailQueryKey = (
  options?: UseWorkspaceSessionDetailOptions,
) => [
  'workspace-session-detail',
  options?.scope?.sessionId ?? '',
  options?.scope?.sessionId ? '' : (options?.scope?.agentId ?? ''),
  options?.sessionId ?? '',
] as const

export function useWorkspaceSessionDetail(options?: UseWorkspaceSessionDetailOptions) {
  return useQuery<WorkspaceSessionDetailResponse | null>({
    queryKey: getWorkspaceSessionDetailQueryKey(options),
    enabled: Boolean(options?.enabled ?? true) && Boolean(options?.sessionId),
    queryFn: async () => {
      if (!options?.sessionId) {
        return null
      }

      const target = await resolveConnectionTarget(options.scope)
      return target.client.getWorkspaceSessionDetail(options.sessionId)
    },
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: 1,
  })
}
