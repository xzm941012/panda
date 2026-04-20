import { useEffect, useState } from 'react'
import type { DirectoryNode } from '@panda/protocol'
import {
  getParentDirectoryPath,
  listThreadDirectories,
} from '../../lib/thread-directory'

type SettingsDirectoryPathPickerProps = {
  agentId: string
  initialPath?: string | null
  title?: string
  subtitle?: string
  confirmLabel?: string
  onClose: () => void
  onSelect: (path: string) => void
}

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

const isDriveRoot = (targetPath: string | null) =>
  Boolean(targetPath && /^[A-Za-z]:[\\/]?$/.test(targetPath.trim()))

export const SettingsDirectoryPathPicker = ({
  agentId,
  initialPath = null,
  title = '选择开发版代码目录',
  subtitle = '按需展开目录，只在你进入某一层时加载它的子目录。',
  confirmLabel = '使用这个目录',
  onClose,
  onSelect,
}: SettingsDirectoryPathPickerProps) => {
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath)
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath)
  const [directories, setDirectories] = useState<DirectoryNode[]>([])
  const [isLoadingDirectories, setIsLoadingDirectories] = useState(true)
  const [loadErrorMessage, setLoadErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    setCurrentPath(initialPath)
    setSelectedPath(initialPath)
  }, [initialPath])

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
        setLoadErrorMessage(error instanceof Error ? error.message : '目录列表加载失败。')
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
  }, [agentId, currentPath])

  const parentPath = getParentDirectoryPath(currentPath)
  const canGoBack = parentPath !== null || isDriveRoot(currentPath)

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

  const handleEnterDirectory = (targetPath: string) => {
    setCurrentPath(targetPath)
    setSelectedPath(targetPath)
  }

  return (
    <div className="sheet-wrap sheet-wrap--centered" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        className="sheet-wrap__scrim"
        aria-label="关闭目录选择"
        onClick={onClose}
      />
      <div className="sheet-wrap__center">
        <section className="directory-picker settings-directory-picker">
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
                <span className="directory-picker__path-value">{currentPath ?? '根目录'}</span>
              </button>
            </div>

            <div className="directory-picker__field">
              <span className="directory-picker__field-label">目录</span>
              <div className="directory-picker__list" role="listbox" aria-label="目录列表">
                {isLoadingDirectories ? (
                  <div className="directory-picker__state">正在读取目录…</div>
                ) : loadErrorMessage ? (
                  <div className="directory-picker__state is-error">{loadErrorMessage}</div>
                ) : directories.length === 0 ? (
                  <div className="directory-picker__state">当前目录下没有可用子目录</div>
                ) : (
                  directories.map((directory) => {
                    const isSelected = selectedPath === directory.path

                    return (
                      <div
                        key={directory.path}
                        className={`directory-picker__row ${isSelected ? 'is-selected' : ''}`}
                      >
                        <button
                          type="button"
                          className="directory-picker__row-main"
                          onClick={() => {
                            setSelectedPath(directory.path)
                          }}
                          onDoubleClick={() => {
                            if (directory.has_children) {
                              handleEnterDirectory(directory.path)
                            }
                          }}
                          aria-selected={isSelected}
                        >
                          <span className="directory-picker__row-icon"><IconFolder /></span>
                          <span className="directory-picker__row-name">{directory.name}</span>
                          {isSelected ? (
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
                  })
                )}
              </div>
            </div>

            <footer className="directory-picker__footer">
              <div className="directory-picker__footer-actions">
                {canGoBack ? (
                  <button
                    type="button"
                    className="directory-picker__secondary"
                    onClick={handleBack}
                  >
                    <span>返回上级</span>
                  </button>
                ) : null}

                <button
                  type="button"
                  className="directory-picker__secondary"
                  onClick={onClose}
                >
                  <span>取消</span>
                </button>

                <button
                  type="button"
                  className="directory-picker__primary"
                  disabled={!selectedPath}
                  onClick={() => {
                    if (selectedPath) {
                      onSelect(selectedPath)
                    }
                  }}
                >
                  {confirmLabel}
                </button>
              </div>
            </footer>
          </div>
        </section>
      </div>
    </div>
  )
}
