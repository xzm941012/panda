import type { QueryClient } from '@tanstack/react-query'
import { resetConnectionTargetCaches } from './client'
import { clearPersistedQueryCache } from './query-persistence'
import { clearStoredSessionSelection } from './session-selection'

export const resetRuntimeConnectionState = async (
  queryClient: QueryClient,
) => {
  resetConnectionTargetCaches()
  clearStoredSessionSelection()
  await clearPersistedQueryCache().catch(() => {})
  queryClient.removeQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' &&
      query.queryKey[0] !== 'pwa-install-diagnostics',
  })
}
