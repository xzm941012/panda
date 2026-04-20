import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const defaultCodexHome = () => path.join(os.homedir(), '.codex')

const normalizePathKey = (value: string) => {
  const normalized = path.normalize(value.trim())
  return process.platform === 'win32'
    ? normalized.replace(/\//g, '\\').toLowerCase()
    : normalized
}

type CodexGlobalState = {
  ['electron-saved-workspace-roots']?: string[]
  ['active-workspace-roots']?: string[]
  ['electron-workspace-root-labels']?: Record<string, string>
  ['pinned-thread-ids']?: string[]
  [key: string]: unknown
}

type PandaThreadPrefs = {
  pinned_workspace_roots?: string[]
  ordered_workspace_roots?: string[]
}

type PandaSessionPrefs = {
  pinned_session_ids?: string[]
}

const globalStatePath = (codexHome?: string) =>
  path.join(codexHome ?? defaultCodexHome(), '.codex-global-state.json')

const pandaThreadPrefsPath = (codexHome?: string) =>
  path.join(codexHome ?? defaultCodexHome(), 'panda-thread-prefs.json')

const pandaSessionPrefsPath = (codexHome?: string) =>
  path.join(codexHome ?? defaultCodexHome(), 'panda-session-prefs.json')

const sessionIndexPath = (codexHome?: string) =>
  path.join(codexHome ?? defaultCodexHome(), 'session_index.jsonl')

export const readCodexGlobalState = async (
  codexHome?: string,
): Promise<CodexGlobalState> => {
  try {
    const raw = await fs.readFile(globalStatePath(codexHome), 'utf8')
    const parsed = JSON.parse(raw) as CodexGlobalState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export const writeCodexGlobalState = async (
  state: CodexGlobalState,
  codexHome?: string,
) => {
  await fs.writeFile(
    globalStatePath(codexHome),
    JSON.stringify(state),
    'utf8',
  )
}

export const getSavedWorkspaceRoots = (state: CodexGlobalState) =>
  Array.isArray(state['electron-saved-workspace-roots'])
    ? state['electron-saved-workspace-roots']!
    : []

export const getWorkspaceRootLabels = (state: CodexGlobalState) => {
  const labels = state['electron-workspace-root-labels']
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    return {} as Record<string, string>
  }

  return Object.fromEntries(
    Object.entries(labels).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === 'string' && typeof entry[1] === 'string',
    ),
  )
}

export const readPandaThreadPrefs = async (
  codexHome?: string,
): Promise<PandaThreadPrefs> => {
  try {
    const raw = await fs.readFile(pandaThreadPrefsPath(codexHome), 'utf8')
    const parsed = JSON.parse(raw) as PandaThreadPrefs
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export const writePandaThreadPrefs = async (
  prefs: PandaThreadPrefs,
  codexHome?: string,
) => {
  await fs.writeFile(
    pandaThreadPrefsPath(codexHome),
    JSON.stringify(prefs),
    'utf8',
  )
}

export const getPinnedWorkspaceRoots = (prefs: PandaThreadPrefs) =>
  Array.isArray(prefs.pinned_workspace_roots)
    ? prefs.pinned_workspace_roots
    : []

export const getOrderedWorkspaceRoots = (prefs: PandaThreadPrefs) =>
  Array.isArray(prefs.ordered_workspace_roots)
    ? prefs.ordered_workspace_roots
    : []

export const readPandaSessionPrefs = async (
  codexHome?: string,
): Promise<PandaSessionPrefs> => {
  try {
    const raw = await fs.readFile(pandaSessionPrefsPath(codexHome), 'utf8')
    const parsed = JSON.parse(raw) as PandaSessionPrefs
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export const writePandaSessionPrefs = async (
  prefs: PandaSessionPrefs,
  codexHome?: string,
) => {
  await fs.writeFile(
    pandaSessionPrefsPath(codexHome),
    JSON.stringify(prefs),
    'utf8',
  )
}

export const getPinnedSessionIds = (prefs: PandaSessionPrefs) =>
  Array.isArray(prefs.pinned_session_ids) ? prefs.pinned_session_ids : []

export const setSessionPinned = async (
  sessionId: string,
  pinned: boolean,
  codexHome?: string,
) => {
  const prefs = await readPandaSessionPrefs(codexHome)
  const pinnedIds = new Set(getPinnedSessionIds(prefs))

  if (pinned) {
    pinnedIds.add(sessionId)
  } else {
    pinnedIds.delete(sessionId)
  }

  await writePandaSessionPrefs(
    {
      ...prefs,
      pinned_session_ids: [...pinnedIds],
    },
    codexHome,
  )
}

export const appendSessionIndexUpdate = async (
  sessionId: string,
  patch: {
    thread_name?: string
    updated_at?: string
  },
  codexHome?: string,
) => {
  const entry = {
    id: sessionId,
    ...patch,
    updated_at: patch.updated_at ?? new Date().toISOString(),
  }

  await fs.appendFile(
    sessionIndexPath(codexHome),
    `${JSON.stringify(entry)}\n`,
    'utf8',
  )
}

export const moveRolloutFileToArchived = async (
  filePath: string,
  codexHome?: string,
) => {
  const resolvedCodexHome = codexHome ?? defaultCodexHome()
  const archivedRoot = path.join(resolvedCodexHome, 'archived_sessions')
  const normalizedFilePath = path.normalize(filePath)
  const normalizedArchivedRoot = path.normalize(archivedRoot)
  if (normalizedFilePath.startsWith(normalizedArchivedRoot)) {
    return normalizedFilePath
  }

  await fs.mkdir(archivedRoot, { recursive: true })
  const targetPath = path.join(archivedRoot, path.basename(filePath))
  await fs.rename(filePath, targetPath)
  return targetPath
}

export const moveRolloutFileFromArchived = async (
  filePath: string,
  codexHome?: string,
) => {
  const resolvedCodexHome = codexHome ?? defaultCodexHome()
  const sessionsRoot = path.join(resolvedCodexHome, 'sessions')
  const normalizedFilePath = path.normalize(filePath)
  const normalizedSessionsRoot = path.normalize(sessionsRoot)
  if (normalizedFilePath.startsWith(normalizedSessionsRoot)) {
    return normalizedFilePath
  }

  await fs.mkdir(sessionsRoot, { recursive: true })
  const targetPath = path.join(sessionsRoot, path.basename(filePath))
  await fs.rename(filePath, targetPath)
  return targetPath
}

export const deleteRolloutFile = async (filePath: string) => {
  await fs.unlink(filePath)
}

export const setWorkspaceRootPinned = async (
  workspaceRoot: string,
  pinned: boolean,
  codexHome?: string,
) => {
  const prefs = await readPandaThreadPrefs(codexHome)
  const pinnedRoots = new Set(
    getPinnedWorkspaceRoots(prefs).map((entry) => normalizePathKey(entry)),
  )
  const normalizedRoot = normalizePathKey(workspaceRoot)

  if (pinned) {
    pinnedRoots.add(normalizedRoot)
  } else {
    pinnedRoots.delete(normalizedRoot)
  }

  await writePandaThreadPrefs(
    {
      ...prefs,
      pinned_workspace_roots: [...pinnedRoots],
    },
    codexHome,
  )
}

export const setWorkspaceRootOrder = async (
  workspaceRoots: string[],
  codexHome?: string,
) => {
  const prefs = await readPandaThreadPrefs(codexHome)
  const orderedRoots = [...new Set(
    workspaceRoots
      .map((entry) => normalizePathKey(entry))
      .filter((entry) => entry.length > 0),
  )]

  await writePandaThreadPrefs(
    {
      ...prefs,
      ordered_workspace_roots: orderedRoots,
    },
    codexHome,
  )
}

export const setWorkspaceRootLabel = async (
  workspaceRoot: string,
  label: string | null,
  codexHome?: string,
) => {
  const state = await readCodexGlobalState(codexHome)
  const currentLabels = getWorkspaceRootLabels(state)
  const normalizedRoot = normalizePathKey(workspaceRoot)
  const nextLabels = { ...currentLabels }

  if (label && label.trim()) {
    nextLabels[normalizedRoot] = label.trim()
  } else {
    delete nextLabels[normalizedRoot]
  }

  await writeCodexGlobalState(
    {
      ...state,
      'electron-workspace-root-labels': nextLabels,
    },
    codexHome,
  )
}

export const setWorkspaceRootVisibility = async (
  workspaceRoot: string,
  visible: boolean,
  codexHome?: string,
) => {
  const state = await readCodexGlobalState(codexHome)
  const normalizedRoot = normalizePathKey(workspaceRoot)
  const savedRoots = getSavedWorkspaceRoots(state).map(normalizePathKey)
  const activeRoots = Array.isArray(state['active-workspace-roots'])
    ? state['active-workspace-roots']!.map(normalizePathKey)
    : []

  const nextSavedRoots = visible
    ? savedRoots.includes(normalizedRoot)
      ? savedRoots
      : [...savedRoots, normalizedRoot]
    : savedRoots.filter((entry) => entry !== normalizedRoot)
  const nextActiveRoots = visible
    ? activeRoots
    : activeRoots.filter((entry) => entry !== normalizedRoot)

  await writeCodexGlobalState(
    {
      ...state,
      'electron-saved-workspace-roots': nextSavedRoots,
      'active-workspace-roots': nextActiveRoots,
    },
    codexHome,
  )
}

export const isWithinWorkspaceRoot = (
  targetPath: string,
  workspaceRoot: string,
) => {
  const normalizedPath = normalizePathKey(targetPath)
  const normalizedRoot = normalizePathKey(workspaceRoot)
  if (normalizedPath === normalizedRoot) {
    return true
  }

  const separator = process.platform === 'win32' ? '\\' : '/'
  return normalizedPath.startsWith(`${normalizedRoot}${separator}`)
}

export const normalizeWorkspacePathKey = normalizePathKey

export const sortByStoredWorkspaceOrder = <T extends { path: string }>(
  items: T[],
  orderedWorkspaceRoots: string[],
) => {
  if (items.length <= 1 || orderedWorkspaceRoots.length === 0) {
    return items
  }

  const orderIndex = new Map(
    orderedWorkspaceRoots.map((entry, index) => [normalizePathKey(entry), index]),
  )

  return [...items]
    .map((item, index) => ({
      item,
      index,
      order: orderIndex.get(normalizePathKey(item.path)),
    }))
    .sort((a, b) => {
      const aHasOrder = typeof a.order === 'number'
      const bHasOrder = typeof b.order === 'number'

      if (aHasOrder && bHasOrder) {
        const aOrder = a.order ?? 0
        const bOrder = b.order ?? 0
        const orderDelta = aOrder - bOrder
        if (orderDelta !== 0) {
          return orderDelta
        }
      }

      if (aHasOrder !== bHasOrder) {
        return aHasOrder ? -1 : 1
      }

      return a.index - b.index
    })
    .map((entry) => entry.item)
}
