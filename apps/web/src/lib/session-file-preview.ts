import { queryOptions } from '@tanstack/react-query'
import type {
  SessionFilePreviewContentResponse,
  SessionFilePreviewTreeResponse,
} from '@panda/protocol'
import { resolveConnectionTarget } from './client'

type SessionFilePreviewQueryOptions = {
  agentId?: string | null
  sessionId: string
  enabled?: boolean
}

type SessionFilePreviewTreeQueryOptions = SessionFilePreviewQueryOptions & {
  path?: string | null
}

type SessionFilePreviewContentQueryOptions = SessionFilePreviewQueryOptions & {
  path: string
}

const fetchSessionFilePreviewTree = async (
  options: SessionFilePreviewTreeQueryOptions,
) => {
  const target = await resolveConnectionTarget({
    agentId: options.agentId ?? undefined,
    sessionId: options.agentId ? undefined : options.sessionId,
  })
  return target.client.getSessionFilePreviewTree(options.sessionId, {
    path: options.path ?? null,
  })
}

const fetchSessionFilePreviewContent = async (
  options: SessionFilePreviewContentQueryOptions,
) => {
  const target = await resolveConnectionTarget({
    agentId: options.agentId ?? undefined,
    sessionId: options.agentId ? undefined : options.sessionId,
  })
  return target.client.getSessionFilePreviewContent(options.sessionId, {
    path: options.path,
  })
}

export const getSessionFilePreviewTreeQueryKey = (
  options: Pick<SessionFilePreviewTreeQueryOptions, 'sessionId' | 'path'>,
) => [
  'session-file-preview',
  'tree',
  options.sessionId,
  options.path?.trim() ?? '',
] as const

export const getSessionFilePreviewContentQueryKey = (
  options: Pick<SessionFilePreviewContentQueryOptions, 'sessionId' | 'path'>,
) => [
  'session-file-preview',
  'content',
  options.sessionId,
  options.path.trim(),
] as const

export const getSessionFilePreviewTreeQueryOptions = (
  options: SessionFilePreviewTreeQueryOptions,
) =>
  queryOptions<
    SessionFilePreviewTreeResponse,
    Error,
    SessionFilePreviewTreeResponse,
    ReturnType<typeof getSessionFilePreviewTreeQueryKey>
  >({
    queryKey: getSessionFilePreviewTreeQueryKey(options),
    enabled: options.enabled ?? true,
    queryFn: () => fetchSessionFilePreviewTree(options),
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: 1,
  })

export const getSessionFilePreviewContentQueryOptions = (
  options: SessionFilePreviewContentQueryOptions,
) =>
  queryOptions<
    SessionFilePreviewContentResponse,
    Error,
    SessionFilePreviewContentResponse,
    ReturnType<typeof getSessionFilePreviewContentQueryKey>
  >({
    queryKey: getSessionFilePreviewContentQueryKey(options),
    enabled: options.enabled ?? true,
    queryFn: () => fetchSessionFilePreviewContent(options),
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: 1,
  })
