import { useQuery } from '@tanstack/react-query'
import type { ConnectionTargetScope } from './client'
import { resolveConnectionTarget } from './client'
import { HUB_BOOTSTRAP_QUERY_KEY } from './bootstrap-query'

type UseSnapshotOptions = {
  scope?: ConnectionTargetScope
  queryKey?: readonly string[]
}

export function useSnapshot(options?: UseSnapshotOptions) {
  return useQuery({
    queryKey: options?.queryKey ?? HUB_BOOTSTRAP_QUERY_KEY,
    queryFn: async () => {
      const target = await resolveConnectionTarget(options?.scope)
      return target.client.getPhaseOneSnapshot({
        fallbackToMock: false,
      })
    },
    refetchInterval: 300000,
    refetchOnWindowFocus: false,
    retry: 1,
  })
}
