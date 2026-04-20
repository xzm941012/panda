import { useQuery } from '@tanstack/react-query'
import { getHubDirectoryQueryOptions } from './directory-sync'

type UseHubDirectoryOptions = {
  enabled?: boolean
}

export function useHubDirectory(options?: UseHubDirectoryOptions) {
  return useQuery(getHubDirectoryQueryOptions(options))
}
