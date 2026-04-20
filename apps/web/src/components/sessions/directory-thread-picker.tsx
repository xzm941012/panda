import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  DirectoryNode,
  ProjectRef,
  WorkspaceProjectDirectory,
} from '@panda/protocol'
import { WORKSPACE_BOOTSTRAP_QUERY_KEY } from '../../lib/bootstrap-query'
import {
  createThreadDirectory,
  createProjectFromDirectory,
  getParentDirectoryPath,
  listThreadDirectories,
  normalizeDirectoryPath,
} from '../../lib/thread-directory'

const IconFolder = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
  </svg>
)

const IconArrowRight = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
)

const IconCheck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12 4.5 4.5L19 7" />
  </svg>
)

const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </svg>
)

const isDriveRoot = (path: string | null) =>
  Boolean(path && /^[A-Za-z]:[\\/]?$/.test(path.trim()))

type DirectoryThreadPickerProps = {
  agentId: string
  projects: WorkspaceProjectDirectory[]
  initialPath?: string | null
  title?: string
  subtitle?: string
  confirmLabel?: string
  cancelLabel?: string
  closeLabel?: string
  onClose?: () => void
  onProjectCreated: (project: WorkspaceProjectDirectory | ProjectRef) => void
}

export const DirectoryThreadPicker = ({
  agentId,
  projects,
  initialPath = null,
  title = '选择目录',
  subtitle = '线程名会使用目录最后一级名称',
  confirmLabel = '选择此目录',
  cancelLabel = '返回上级',
  onProjectCreated,
}: DirectoryThreadPickerProps) => {
  const queryClient = useQueryClient()
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath)
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath)
  const [directories, setDirectories] = useState<DirectoryNode[]>([])
  const [isLoadingDirectories, setIsLoadingDirectories] = useState(true)
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null)
  const [directoryReloadKey, setDirectoryReloadKey] = useState(0)
  const [isCreatingDirectory, setIsCreatingDirectory] = useState(false)
  const [newDirectoryName, setNewDirectoryName] = useState('')
  const [newDirectoryErrorMessage, setNewDirectoryErrorMessage] = useState<string | null>(null)
  const newDirectoryInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setCurrentPath(initialPath)
    setSelectedPath(initialPath)
  }, [initialPath])

  useEffect(() => {
    setIsCreatingDirectory(false)
    setNewDirectoryName('')
    setNewDirectoryErrorMessage(null)
    createDirectoryMutation.reset()
  }, [currentPath])

  useEffect(() => {
    let cancelled = false
    setIsLoadingDirectories(true)
    setLoadErrorMessage(null)

    void listThreadDirectories({ agentId, path: currentPath })
      .then((nextDirectories) => {
        if (cancelled) {
          return
        }

        setDirectories(nextDirectories)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        setLoadErrorMessage(error instanceof Error ? error.message : '目录列表加载失败')
        setDirectories([])
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingDirectories(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [agentId, currentPath, directoryReloadKey])

  useEffect(() => {
    if (!isCreatingDirectory) {
      return
    }

    newDirectoryInputRef.current?.focus()
    newDirectoryInputRef.current?.select()
  }, [isCreatingDirectory])

  const createProjectMutation = useMutation({
    mutationFn: async (path: string) =>
      createProjectFromDirectory({
        agentId,
        path,
        projects,
        queryClient,
        bootstrapQueryKey: WORKSPACE_BOOTSTRAP_QUERY_KEY,
      }),
    onSuccess: (project) => {
      onProjectCreated(project)
    },
  })

  const createDirectoryMutation = useMutation({
    mutationFn: async (input: { parentPath: string; name: string }) =>
      createThreadDirectory({
        agentId,
        parentPath: input.parentPath,
        name: input.name,
      }),
    onSuccess: ({ directory }) => {
      setIsCreatingDirectory(false)
      setNewDirectoryName('')
      setNewDirectoryErrorMessage(null)
      setSelectedPath(directory.path)
      setDirectoryReloadKey((value) => value + 1)
    },
  })

  const projectLookup = useMemo(() => {
    const nextLookup = new Map<string, WorkspaceProjectDirectory>()

    for (const project of projects) {
      nextLookup.set(normalizeDirectoryPath(project.path), project)
    }

    return nextLookup
  }, [projects])

  const selectedProject = useMemo(() => {
    if (!selectedPath) {
      return null
    }

    return projectLookup.get(normalizeDirectoryPath(selectedPath)) ?? null
  }, [projectLookup, selectedPath])

  const resolvedConfirmLabel =
    confirmLabel !== '选择此目录'
      ? confirmLabel
      : selectedProject
        ? '在线程中继续'
        : '创建新线程'

  const parentPath = getParentDirectoryPath(currentPath)
  const canGoBack = parentPath !== null || isDriveRoot(currentPath)
  const canCreateDirectory = Boolean(currentPath)
  const trimmedNewDirectoryName = newDirectoryName.trim()
  const createDirectoryError =
    newDirectoryErrorMessage ??
    (createDirectoryMutation.error instanceof Error
      ? createDirectoryMutation.error.message
      : null)
  const createProjectError =
    createProjectMutation.error instanceof Error
      ? createProjectMutation.error.message
      : createProjectMutation.error
        ? '创建线程失败'
        : null

  const handleBack = () => {
    if (parentPath !== null) {
      setCurrentPath(parentPath)
      setSelectedPath(parentPath)
      return
    }

    if (isDriveRoot(currentPath)) {
      setCurrentPath(null)
      setSelectedPath(null)
    }
  }

  const handleEnterDirectory = (path: string) => {
    setCurrentPath(path)
    setSelectedPath(path)
  }

  const resetCreateDirectoryState = () => {
    setIsCreatingDirectory(false)
    setNewDirectoryName('')
    setNewDirectoryErrorMessage(null)
    createDirectoryMutation.reset()
  }

  const handleStartCreateDirectory = () => {
    if (!currentPath) {
      return
    }

    createDirectoryMutation.reset()
    setNewDirectoryErrorMessage(null)
    setNewDirectoryName('')
    setIsCreatingDirectory(true)
  }

  const handleSubmitCreateDirectory = () => {
    if (!currentPath) {
      return
    }

    if (!trimmedNewDirectoryName) {
      setNewDirectoryErrorMessage('目录名称不能为空')
      return
    }

    setNewDirectoryErrorMessage(null)
    createDirectoryMutation.mutate({
      parentPath: currentPath,
      name: trimmedNewDirectoryName,
    })
  }

  return (
    <section className="directory-picker">
      <div className="directory-picker__panel">
        <header className="directory-picker__header">
          <div className="directory-picker__heading">
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
        </header>

        <div className="directory-picker__field">
          <span className="directory-picker__field-label">当前路径</span>
          <button
            type="button"
            className={`directory-picker__path ${selectedPath === currentPath ? 'is-selected' : ''}`}
            onClick={() => {
              if (currentPath) {
                setSelectedPath(currentPath)
              }
            }}
            disabled={!currentPath}
            aria-pressed={selectedPath === currentPath}
          >
            <span className="directory-picker__path-icon"><IconFolder /></span>
            <span className="directory-picker__path-value">
              {currentPath ?? '根目录'}
            </span>
          </button>
        </div>

        <div className="directory-picker__field">
          <span className="directory-picker__field-label">目录</span>
          <div className="directory-picker__list" role="listbox" aria-label="目录列表">
            {isLoadingDirectories ? (
              <div className="directory-picker__state">正在读取目录…</div>
            ) : loadErrorMessage ? (
              <div className="directory-picker__state is-error">{loadErrorMessage}</div>
            ) : (
              <>
                {directories.length === 0 && !isCreatingDirectory ? (
                  <div className="directory-picker__state">当前目录下没有可用子目录</div>
                ) : null}

                {directories.map((directory) => {
                  const isSelected = selectedPath === directory.path

                  return (
                    <div
                      key={directory.path}
                      className={`directory-picker__row ${isSelected ? 'is-selected' : ''}`}
                    >
                      <button
                        type="button"
                        className="directory-picker__row-main"
                        onClick={(event) => {
                          if (directory.has_children && event.detail >= 2) {
                            handleEnterDirectory(directory.path)
                            return
                          }

                          setSelectedPath(directory.path)
                        }}
                        aria-selected={isSelected}
                      >
                        <span className="directory-picker__row-icon"><IconFolder /></span>
                        <span className="directory-picker__row-name">{directory.name}</span>
                        {!directory.has_children && isSelected ? (
                          <span className="directory-picker__row-check"><IconCheck /></span>
                        ) : null}
                      </button>
                      {directory.has_children ? (
                        <button
                          type="button"
                          className="directory-picker__row-enter-button"
                          aria-label={`进入 ${directory.name}`}
                          onClick={() => handleEnterDirectory(directory.path)}
                        >
                          <span className="directory-picker__row-enter" aria-hidden="true">
                            <IconArrowRight />
                          </span>
                        </button>
                      ) : null}
                    </div>
                  )
                })}

                {isCreatingDirectory ? (
                  <div className="directory-picker__row is-creating">
                    <div className="directory-picker__row-editor">
                      <span className="directory-picker__row-icon"><IconFolder /></span>
                      <input
                        ref={newDirectoryInputRef}
                        type="text"
                        className="directory-picker__row-input"
                        value={newDirectoryName}
                        onChange={(event) => {
                          setNewDirectoryName(event.target.value)
                          if (newDirectoryErrorMessage) {
                            setNewDirectoryErrorMessage(null)
                          }
                          if (createDirectoryMutation.error) {
                            createDirectoryMutation.reset()
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            handleSubmitCreateDirectory()
                          }

                          if (event.key === 'Escape') {
                            event.preventDefault()
                            resetCreateDirectoryState()
                          }
                        }}
                        placeholder="输入目录名称"
                        aria-label="新目录名称"
                        disabled={createDirectoryMutation.isPending}
                      />
                      <div className="directory-picker__row-actions">
                        <button
                          type="button"
                          className="directory-picker__row-action"
                          onClick={handleSubmitCreateDirectory}
                          aria-label="确认创建目录"
                          disabled={!trimmedNewDirectoryName || createDirectoryMutation.isPending}
                        >
                          <IconCheck />
                        </button>
                        <button
                          type="button"
                          className="directory-picker__row-action"
                          onClick={resetCreateDirectoryState}
                          aria-label="取消创建目录"
                          disabled={createDirectoryMutation.isPending}
                        >
                          <IconClose />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

        {createDirectoryError ? (
          <div className="directory-picker__feedback is-error" role="status" aria-live="polite">
            {createDirectoryError}
          </div>
        ) : null}

        {createProjectError ? (
          <div className="directory-picker__feedback is-error" role="status" aria-live="polite">
            {createProjectError}
          </div>
        ) : null}

        <footer className="directory-picker__footer">
          <div className="directory-picker__footer-actions">
            {canGoBack ? (
              <button
                type="button"
                className="directory-picker__secondary"
                onClick={handleBack}
              >
                <span>{cancelLabel}</span>
              </button>
            ) : null}

            {canCreateDirectory ? (
              <button
                type="button"
                className="directory-picker__secondary"
                onClick={handleStartCreateDirectory}
                disabled={isCreatingDirectory || createDirectoryMutation.isPending}
              >
                <span>新建目录</span>
              </button>
            ) : null}

            <button
              type="button"
              className="directory-picker__primary"
              disabled={!selectedPath || createProjectMutation.isPending}
              onClick={() => {
                if (selectedPath) {
                  createProjectMutation.mutate(selectedPath)
                }
              }}
            >
              {createProjectMutation.isPending ? '创建中…' : resolvedConfirmLabel}
            </button>
          </div>
        </footer>
      </div>
    </section>
  )
}
