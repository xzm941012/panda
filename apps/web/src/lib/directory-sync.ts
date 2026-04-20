import {
  keepPreviousData,
  queryOptions,
  type QueryClient,
} from '@tanstack/react-query'
import type {
  HubDirectorySnapshot,
  HubRecentSessionsSnapshot,
  WorkspaceDirectorySnapshot,
} from '@panda/protocol'
import {
  HUB_DIRECTORY_QUERY_KEY,
  HUB_RECENT_SESSIONS_QUERY_KEY,
  WORKSPACE_DIRECTORY_QUERY_KEY,
} from './bootstrap-query'
import { resolveConnectionTarget, type ConnectionTargetScope } from './client'
import { mergeHubDirectorySnapshot } from './hub-directory-cache'
import { mergeWorkspaceDirectorySnapshot } from './workspace-directory-cache'

type WorkspaceDirectoryOptions = {
  scope?: ConnectionTargetScope
  selectedSessionId?: string | null
  enabled?: boolean
}

const fetchHubDirectorySnapshot = async (): Promise<HubDirectorySnapshot> => {
  const target = await resolveConnectionTarget()
  if (target.mode === 'direct') {
    const snapshot = await target.client.getPhaseOneSnapshot({
      fallbackToMock: false,
    })
    return {
      generated_at: snapshot.generated_at,
      agents: snapshot.agents,
    } satisfies HubDirectorySnapshot
  }

  return target.client.getHubDirectory()
}

const fetchHubRecentSessionsSnapshot = async (): Promise<HubRecentSessionsSnapshot> => {
  const target = await resolveConnectionTarget()
  if (target.mode === 'direct') {
    const snapshot = await target.client.getPhaseOneSnapshot({
      fallbackToMock: false,
    })

    return {
      generated_at: snapshot.generated_at,
      recent_sessions: [...snapshot.sessions]
        .sort((left, right) => +new Date(right.last_event_at) - +new Date(left.last_event_at))
        .slice(0, 24)
        .map((session) => ({
          id: session.id,
          title: session.title,
          run_state: session.run_state,
          run_state_changed_at: session.run_state_changed_at,
          latest_assistant_message: session.latest_assistant_message,
        })),
    } satisfies HubRecentSessionsSnapshot
  }

  return target.client.getHubRecentSessions()
}

const fetchWorkspaceDirectorySnapshot = async (
  options?: WorkspaceDirectoryOptions,
): Promise<WorkspaceDirectorySnapshot> => {
  const target = await resolveConnectionTarget(options?.scope)
  return target.client.getWorkspaceDirectory({
    selectedSessionId: options?.selectedSessionId ?? null,
  })
}

const shareHubDirectorySnapshot = (oldData: unknown, newData: unknown) =>
  mergeHubDirectorySnapshot(
    oldData as HubDirectorySnapshot | undefined,
    newData as HubDirectorySnapshot,
  )

const shareWorkspaceDirectorySnapshot = (oldData: unknown, newData: unknown) =>
  mergeWorkspaceDirectorySnapshot(
    oldData as WorkspaceDirectorySnapshot | undefined,
    newData as WorkspaceDirectorySnapshot,
  )

export const getWorkspaceDirectoryQueryKey = (options?: WorkspaceDirectoryOptions) => [
  ...WORKSPACE_DIRECTORY_QUERY_KEY,
  options?.scope?.agentId ?? '',
  options?.scope?.agentId ? '' : (options?.scope?.sessionId ?? ''),
] as const

type WorkspaceDirectoryQueryKey = ReturnType<typeof getWorkspaceDirectoryQueryKey>

export const getHubDirectoryQueryOptions = (options?: { enabled?: boolean }) =>
  queryOptions<
    HubDirectorySnapshot,
    Error,
    HubDirectorySnapshot,
    typeof HUB_DIRECTORY_QUERY_KEY
  >({
    queryKey: HUB_DIRECTORY_QUERY_KEY,
    enabled: options?.enabled ?? true,
    queryFn: fetchHubDirectorySnapshot,
    structuralSharing: shareHubDirectorySnapshot,
    staleTime: 30_000,
    refetchInterval: 300_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: 1,
  })

export const getHubRecentSessionsQueryOptions = () =>
  queryOptions<
    HubRecentSessionsSnapshot,
    Error,
    HubRecentSessionsSnapshot,
    typeof HUB_RECENT_SESSIONS_QUERY_KEY
  >({
    queryKey: HUB_RECENT_SESSIONS_QUERY_KEY,
    queryFn: fetchHubRecentSessionsSnapshot,
    staleTime: 30_000,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: 1,
  })

export const getWorkspaceDirectoryQueryOptions = (
  options?: WorkspaceDirectoryOptions,
) =>
  queryOptions<
    WorkspaceDirectorySnapshot,
    Error,
    WorkspaceDirectorySnapshot,
    WorkspaceDirectoryQueryKey
  >({
    queryKey: getWorkspaceDirectoryQueryKey(options),
    enabled: options?.enabled ?? true,
    queryFn: () => fetchWorkspaceDirectorySnapshot(options),
    placeholderData: keepPreviousData,
    structuralSharing: shareWorkspaceDirectorySnapshot,
    staleTime: 10_000,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: 1,
  })

export const syncHubDirectory = async (queryClient: QueryClient) =>
  queryClient.fetchQuery(getHubDirectoryQueryOptions())

export const syncHubRecentSessions = async (queryClient: QueryClient) =>
  queryClient.fetchQuery(getHubRecentSessionsQueryOptions())

export const syncWorkspaceDirectory = async (
  queryClient: QueryClient,
  options?: WorkspaceDirectoryOptions,
) => queryClient.fetchQuery(getWorkspaceDirectoryQueryOptions(options))
