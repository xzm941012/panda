import { useQuery } from '@tanstack/react-query'
import { resolveConnectionTarget } from './client'

export const useProjectSkills = (
  projectId: string | null | undefined,
  agentId?: string | null,
  options?: { enabled?: boolean },
) => {
  const enabled = (options?.enabled ?? true) && Boolean(projectId)

  return useQuery({
    queryKey: ['project-skills', agentId ?? '', projectId],
    enabled,
    queryFn: async () => {
      if (!projectId) {
        return []
      }

      const target = await resolveConnectionTarget({
        projectId,
        agentId: agentId ?? null,
      })
      return target.client.getProjectSkills(projectId)
    },
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  })
}
