import type { QueryClient } from '@tanstack/react-query'
import type {
  CreateDirectoryResponse,
  DirectoryNode,
  ProjectRef,
  WorkspaceProjectDirectory,
} from '@panda/protocol'
import { resolveConnectionTarget } from './client'

type ExistingThreadProject = WorkspaceProjectDirectory

const trimTrailingSeparators = (value: string) => value.replace(/[\\/]+$/, '')
export const normalizeDirectoryPath = (value: string) =>
  trimTrailingSeparators(value).replace(/\\/g, '/').toLowerCase()

export const getDirectoryBaseName = (path: string) => {
  const trimmed = trimTrailingSeparators(path.trim())
  if (!trimmed) {
    return '新线程'
  }

  const segments = trimmed.split(/[\\/]+/).filter(Boolean)
  const lastSegment = segments[segments.length - 1]
  if (!lastSegment) {
    return trimmed
  }

  return lastSegment.endsWith(':') ? trimmed : lastSegment
}

export const getParentDirectoryPath = (path: string | null) => {
  if (!path) {
    return null
  }

  const trimmed = path.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed === '/' || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return null
  }

  const normalized = trimTrailingSeparators(trimmed)
  const separatorIndex = Math.max(
    normalized.lastIndexOf('/'),
    normalized.lastIndexOf('\\'),
  )

  if (separatorIndex < 0) {
    return null
  }

  const parent = normalized.slice(0, separatorIndex)
  if (!parent) {
    return normalized.startsWith('/') ? '/' : null
  }

  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

export const listThreadDirectories = async (input: {
  agentId: string
  path?: string | null
}) => {
  const target = await resolveConnectionTarget({
    agentId: input.agentId,
  })
  return target.client.listDirectories(input) as Promise<DirectoryNode[]>
}

export const createThreadDirectory = async (input: {
  agentId: string
  parentPath: string
  name: string
}) => {
  const target = await resolveConnectionTarget({
    agentId: input.agentId,
  })
  return target.client.createDirectory(input) as Promise<CreateDirectoryResponse>
}

export const createProjectFromDirectory = async (input: {
  agentId: string
  path: string
  projects: ExistingThreadProject[]
  queryClient: QueryClient
  bootstrapQueryKey?: readonly string[]
}) => {
  const bootstrapQueryKey = input.bootstrapQueryKey ?? ['bootstrap']
  const existingProject = input.projects.find(
    (project) =>
      project.agent_id === input.agentId &&
      normalizeDirectoryPath(project.path) === normalizeDirectoryPath(input.path),
  )

  if (existingProject) {
    return existingProject
  }

  const target = await resolveConnectionTarget({
    agentId: input.agentId,
  })
  const response = (await target.client.createProject({
    agentId: input.agentId,
    name: getDirectoryBaseName(input.path),
    path: input.path,
  })) as { project: ProjectRef }

  void input.queryClient.invalidateQueries({ queryKey: bootstrapQueryKey })
  return response.project
}
