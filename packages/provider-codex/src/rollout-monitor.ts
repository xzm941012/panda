import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const WATCH_DEBOUNCE_MS = 160
const FALLBACK_SCAN_INTERVAL_MS = 2500

const readFirstLine = async (filePath: string) => {
  const handle = await fsp.open(filePath, 'r')
  try {
    const chunks: string[] = []
    let bytesReadTotal = 0
    let position = 0

    while (bytesReadTotal < 256 * 1024) {
      const buffer = Buffer.alloc(8192)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) {
        break
      }

      const text = buffer.toString('utf8', 0, bytesRead)
      const newlineIndex = text.indexOf('\n')
      if (newlineIndex >= 0) {
        chunks.push(text.slice(0, newlineIndex))
        break
      }

      chunks.push(text)
      bytesReadTotal += bytesRead
      position += bytesRead
    }

    return chunks.join('').trim()
  } finally {
    await handle.close()
  }
}

const walkRolloutFiles = async (rootPath: string): Promise<string[]> => {
  let entries
  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkRolloutFiles(fullPath))
      continue
    }

    if (entry.isFile() && fullPath.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }

  return files
}

const readSessionIdFromRollout = async (filePath: string) => {
  try {
    const firstLine = await readFirstLine(filePath)
    if (!firstLine) {
      return null
    }

    const parsed = JSON.parse(firstLine) as {
      payload?: { id?: string }
    }

    return parsed.payload?.id?.trim() || null
  } catch {
    return null
  }
}

export type CodexRolloutMonitorEvent = {
  sessionId: string
  filePath: string
  timestamp: string
}

export type CodexRolloutMonitor = {
  start: () => Promise<void>
  stop: () => Promise<void>
}

export const createCodexRolloutMonitor = (options?: {
  codexHome?: string
  onSessionUpdated?: (event: CodexRolloutMonitorEvent) => void
}): CodexRolloutMonitor => {
  const codexHome = options?.codexHome ?? path.join(os.homedir(), '.codex')
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ]
  const watchedFiles = new Map<string, string>()
  const fileSignatures = new Map<string, string>()
  const pending = new Map<string, NodeJS.Timeout>()
  const watchers: fs.FSWatcher[] = []
  let pollTimer: NodeJS.Timeout | null = null
  let stopped = false

  const emitIfKnown = async (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) {
      return
    }

    let sessionId = watchedFiles.get(filePath)
    if (!sessionId) {
      sessionId = await readSessionIdFromRollout(filePath) ?? undefined
      if (!sessionId) {
        return
      }

      watchedFiles.set(filePath, sessionId)
    }

    options?.onSessionUpdated?.({
      sessionId,
      filePath,
      timestamp: new Date().toISOString(),
    })
  }

  const readFileSignature = async (filePath: string) => {
    const stat = await fsp.stat(filePath)
    return `${stat.size}:${stat.mtimeMs}`
  }

  const scheduleEmit = (filePath: string) => {
    const existing = pending.get(filePath)
    if (existing) {
      clearTimeout(existing)
    }

    pending.set(
      filePath,
      setTimeout(async () => {
        pending.delete(filePath)
        try {
          const stat = await fsp.stat(filePath)
          if (!stat.isFile()) {
            return
          }
          fileSignatures.set(filePath, `${stat.size}:${stat.mtimeMs}`)
        } catch {
          watchedFiles.delete(filePath)
          fileSignatures.delete(filePath)
          return
        }

        await emitIfKnown(filePath)
      }, WATCH_DEBOUNCE_MS),
    )
  }

  const seedExistingFiles = async () => {
    const files = (
      await Promise.all(roots.map((rootPath) => walkRolloutFiles(rootPath)))
    ).flat()

    await Promise.all(
      files.map(async (filePath) => {
        const sessionId = await readSessionIdFromRollout(filePath)
        if (sessionId) {
          watchedFiles.set(filePath, sessionId)
          fileSignatures.set(filePath, await readFileSignature(filePath))
        }
      }),
    )
  }

  const startPolling = () => {
    if (pollTimer) {
      return
    }

    pollTimer = setInterval(async () => {
      const files = (
        await Promise.all(roots.map((rootPath) => walkRolloutFiles(rootPath)))
      ).flat()
      for (const filePath of files) {
        let nextSignature = ''
        try {
          nextSignature = await readFileSignature(filePath)
        } catch {
          watchedFiles.delete(filePath)
          fileSignatures.delete(filePath)
          continue
        }

        if (fileSignatures.get(filePath) !== nextSignature) {
          fileSignatures.set(filePath, nextSignature)
          scheduleEmit(filePath)
        }
      }
    }, FALLBACK_SCAN_INTERVAL_MS)
  }

  const bindWatchers = async () => {
    for (const rootPath of roots) {
      try {
        await fsp.mkdir(rootPath, { recursive: true })
      } catch {
        continue
      }

      try {
        const watcher = fs.watch(rootPath, { recursive: true }, (_eventType, filename) => {
          if (stopped) {
            return
          }

          if (!filename) {
            return
          }

          const fullPath = path.join(rootPath, filename.toString())
          if (fullPath.endsWith('.jsonl')) {
            scheduleEmit(fullPath)
          }
        })

        watcher.on('error', () => {
          startPolling()
        })

        watchers.push(watcher)
      } catch {
        startPolling()
      }
    }
  }

  return {
    start: async () => {
      await seedExistingFiles()
      await bindWatchers()
    },
    stop: async () => {
      stopped = true
      for (const timer of pending.values()) {
        clearTimeout(timer)
      }
      pending.clear()
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      for (const watcher of watchers) {
        watcher.close()
      }
      watchers.length = 0
    },
  }
}
