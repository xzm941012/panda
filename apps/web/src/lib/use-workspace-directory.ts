import { useQuery } from '@tanstack/react-query'
import type { ConnectionTargetScope } from './client'
import { getWorkspaceDirectoryQueryOptions } from './directory-sync'

type UseWorkspaceDirectoryOptions = {
  scope?: ConnectionTargetScope
  selectedSessionId?: string | null
  enabled?: boolean
}

export function useWorkspaceDirectory(options?: UseWorkspaceDirectoryOptions) {
  return useQuery(getWorkspaceDirectoryQueryOptions(options))
}
