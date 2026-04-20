import {
  Suspense,
  lazy,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  SessionFilePreviewContentResponse,
  SessionFilePreviewTreeNode,
} from '@panda/protocol'
import hljs from 'highlight.js/lib/core'
import bashLanguage from 'highlight.js/lib/languages/bash'
import cssLanguage from 'highlight.js/lib/languages/css'
import javaLanguage from 'highlight.js/lib/languages/java'
import javascriptLanguage from 'highlight.js/lib/languages/javascript'
import jsonLanguage from 'highlight.js/lib/languages/json'
import markdownLanguage from 'highlight.js/lib/languages/markdown'
import typescriptLanguage from 'highlight.js/lib/languages/typescript'
import xmlLanguage from 'highlight.js/lib/languages/xml'
import yamlLanguage from 'highlight.js/lib/languages/yaml'
import {
  Check,
  ChevronLeft,
  ChevronDown,
  File,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  Folder,
  X,
} from 'lucide-react'
import {
  getSessionFilePreviewContentQueryOptions,
  getSessionFilePreviewTreeQueryOptions,
} from '../../lib/session-file-preview'

type SessionFilePreviewPageProps = {
  agentId: string | null
  sessionId: string
  projectName: string
  projectPath: string
  isActive: boolean
  onBack: () => void
}

type DirectoryLevel = {
  key: string
  label: string
  currentPath: string | null
}

type DirectorySelectorProps = {
  level: DirectoryLevel
  isOpen: boolean
  onToggle: () => void
  buttonRef: (node: HTMLButtonElement | null) => void
}

type OpenFileTab = {
  path: string
  name: string
}

type ImageLightboxState = {
  src: string
  alt: string
}

type TouchPointList = {
  length: number
  item(index: number): {
    clientX: number
    clientY: number
  } | null
}

hljs.registerLanguage('bash', bashLanguage)
hljs.registerLanguage('css', cssLanguage)
hljs.registerLanguage('java', javaLanguage)
hljs.registerLanguage('javascript', javascriptLanguage)
hljs.registerLanguage('json', jsonLanguage)
hljs.registerLanguage('markdown', markdownLanguage)
hljs.registerLanguage('typescript', typescriptLanguage)
hljs.registerLanguage('xml', xmlLanguage)
hljs.registerLanguage('yaml', yamlLanguage)

const LazySessionFileMarkdownPreview = lazy(async () => {
  const module = await import('./session-file-markdown-preview')
  return { default: module.SessionFileMarkdownPreview }
})

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

const inferCodeLanguage = (filePath: string) => {
  const normalized = filePath.toLowerCase()

  if (
    normalized.endsWith('.ts') ||
    normalized.endsWith('.tsx') ||
    normalized.endsWith('.mts') ||
    normalized.endsWith('.cts')
  ) {
    return 'typescript'
  }

  if (
    normalized.endsWith('.js') ||
    normalized.endsWith('.jsx') ||
    normalized.endsWith('.mjs') ||
    normalized.endsWith('.cjs')
  ) {
    return 'javascript'
  }

  if (normalized.endsWith('.json')) {
    return 'json'
  }

  if (
    normalized.endsWith('.css') ||
    normalized.endsWith('.scss') ||
    normalized.endsWith('.less')
  ) {
    return 'css'
  }

  if (
    normalized.endsWith('.html') ||
    normalized.endsWith('.svg') ||
    normalized.endsWith('.xml')
  ) {
    return 'xml'
  }

  if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) {
    return 'markdown'
  }

  if (normalized.endsWith('.yml') || normalized.endsWith('.yaml')) {
    return 'yaml'
  }

  if (normalized.endsWith('.sh')) {
    return 'bash'
  }

  if (normalized.endsWith('.java')) {
    return 'java'
  }

  return null
}

const highlightCode = (content: string, filePath: string, plainText = false) => {
  if (plainText || !content.trim()) {
    return escapeHtml(content)
  }

  const language = inferCodeLanguage(filePath)
  if (!language) {
    return escapeHtml(content)
  }

  try {
    return hljs.highlight(content, {
      language,
      ignoreIllegals: true,
    }).value
  } catch {
    return escapeHtml(content)
  }
}

const buildDirectoryLevels = (
  projectName: string,
  currentDirectoryPath: string | null,
): DirectoryLevel[] => {
  const levels: DirectoryLevel[] = [
    {
      key: 'root',
      label: projectName,
      currentPath: null,
    },
  ]

  if (!currentDirectoryPath) {
    return levels
  }

  const segments = currentDirectoryPath.split('/').filter(Boolean)
  let accumulatedPath: string | null = null

  for (const segment of segments) {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${segment}` : segment
    levels.push({
      key: accumulatedPath,
      label: segment,
      currentPath: accumulatedPath,
    })
  }

  return levels
}

const getParentDirectoryPath = (path: string) => {
  const segments = path.split('/').filter(Boolean)
  if (segments.length <= 1) {
    return null
  }

  return segments.slice(0, -1).join('/')
}

const getNodeIcon = (node: Pick<SessionFilePreviewTreeNode, 'kind' | 'file_kind' | 'extension'>) => {
  if (node.kind === 'directory') {
    return Folder
  }

  if (node.file_kind === 'image') {
    return FileImage
  }

  if (node.extension === '.json') {
    return FileJson2
  }

  if (node.file_kind === 'code') {
    return FileCode2
  }

  if (node.file_kind === 'markdown' || node.file_kind === 'text') {
    return FileText
  }

  return File
}

const DirectorySelector = memo(function DirectorySelector({
  level,
  isOpen,
  onToggle,
  buttonRef,
}: DirectorySelectorProps) {
  return (
    <div className={`session-file-preview-nav__level ${isOpen ? 'is-open' : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className="session-file-preview-nav__trigger"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span className="session-file-preview-nav__trigger-label">{level.label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
    </div>
  )
})

const cleanupSessionPreviewQueries = (
  sessionId: string,
  queryClient: QueryClient,
) => {
  queryClient.removeQueries({
    predicate: (query) => {
      const queryKey = query.queryKey
      return Array.isArray(queryKey) && queryKey[0] === 'session-file-preview' && queryKey[2] === sessionId
    },
  })
}

const clampImageScale = (value: number) => Math.max(1, Math.min(4, value))

const getTouchDistance = (touches: TouchPointList) => {
  if (touches.length < 2) {
    return 0
  }

  const firstTouch = touches.item(0)
  const secondTouch = touches.item(1)
  if (!firstTouch || !secondTouch) {
    return 0
  }
  const deltaX = secondTouch.clientX - firstTouch.clientX
  const deltaY = secondTouch.clientY - firstTouch.clientY
  return Math.hypot(deltaX, deltaY)
}

const SessionFileImagePreview = memo(function SessionFileImagePreview({
  src,
  alt,
  onOpen,
}: {
  src: string
  alt: string
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      className="session-file-preview-viewer__image"
      onClick={onOpen}
      aria-label="全屏查看图片"
    >
      <img src={src} alt={alt} />
    </button>
  )
})

const SessionFileImageLightbox = memo(function SessionFileImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const pinchStateRef = useRef<{ distance: number; scale: number } | null>(null)
  const panStateRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  )

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  useEffect(() => {
    if (scale === 1 && (offset.x !== 0 || offset.y !== 0)) {
      setOffset({ x: 0, y: 0 })
    }
  }, [offset.x, offset.y, scale])

  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length >= 2) {
      pinchStateRef.current = {
        distance: getTouchDistance(event.touches),
        scale,
      }
      panStateRef.current = null
      return
    }

    if (event.touches.length === 1 && scale > 1) {
      const touch = event.touches[0]
      panStateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        originX: offset.x,
        originY: offset.y,
      }
    }
  }

  const handleTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length >= 2) {
      const pinchState = pinchStateRef.current
      if (!pinchState) {
        pinchStateRef.current = {
          distance: getTouchDistance(event.touches),
          scale,
        }
        return
      }

      const nextDistance = getTouchDistance(event.touches)
      if (nextDistance <= 0 || pinchState.distance <= 0) {
        return
      }

      event.preventDefault()
      setScale(clampImageScale((nextDistance / pinchState.distance) * pinchState.scale))
      return
    }

    if (event.touches.length === 1 && panStateRef.current && scale > 1) {
      const touch = event.touches[0]
      event.preventDefault()
      setOffset({
        x: panStateRef.current.originX + (touch.clientX - panStateRef.current.startX),
        y: panStateRef.current.originY + (touch.clientY - panStateRef.current.startY),
      })
    }
  }

  const handleTouchEnd = () => {
    if (pinchStateRef.current && scale <= 1) {
      setScale(1)
    }

    if (scale <= 1) {
      setOffset({ x: 0, y: 0 })
    }

    pinchStateRef.current = null
    panStateRef.current = null
  }

  return (
    <div
      className="session-file-preview-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片全屏预览"
      onClick={onClose}
    >
      <button
        type="button"
        className="session-file-preview-lightbox__close"
        onClick={onClose}
        aria-label="关闭图片预览"
      >
        <X />
      </button>

      <div
        className="session-file-preview-lightbox__stage"
        onClick={(event) => {
          event.stopPropagation()
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <img
          src={src}
          alt={alt}
          className="session-file-preview-lightbox__image"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        />
      </div>
    </div>
  )
})

const SessionFileCodePreview = memo(function SessionFileCodePreview({
  content,
  path,
  plainText = false,
}: {
  content: string
  path: string
  plainText?: boolean
}) {
  const highlightedHtml = useMemo(
    () => highlightCode(content, path, plainText),
    [content, path, plainText],
  )
  const lineHtml = useMemo(() => highlightedHtml.split('\n'), [highlightedHtml])

  return (
    <div className="session-file-preview-viewer__code-shell">
      <div className="session-file-preview-viewer__code-scroll">
        <div className="session-file-preview-viewer__code" role="presentation">
          {lineHtml.map((line, index) => (
            <div key={`${path}-line-${index + 1}`} className="session-file-preview-viewer__code-line">
              <span className="session-file-preview-viewer__line-number" aria-hidden="true">
                {index + 1}
              </span>
              <span
                className="session-file-preview-viewer__line-content"
                dangerouslySetInnerHTML={{
                  __html: line || ' ',
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})

const renderPreviewContent = (
  agentId: string | null,
  sessionId: string,
  preview: SessionFilePreviewContentResponse,
  onOpenImage: (state: ImageLightboxState) => void,
) => {
  const inferredLanguage = inferCodeLanguage(preview.path)
  const shouldRenderMarkdown =
    preview.content_text !== null &&
    (preview.file_kind === 'markdown' || inferredLanguage === 'markdown')

  if (shouldRenderMarkdown) {
    const markdownContent = preview.content_text
    if (markdownContent === null) {
      return (
        <div className="session-file-preview-viewer__empty">
          暂时没有可显示的内容。
        </div>
      )
    }

    return (
      <Suspense fallback={<div className="session-file-preview-viewer__empty">正在载入 Markdown…</div>}>
        <LazySessionFileMarkdownPreview
          agentId={agentId}
          sessionId={sessionId}
          filePath={preview.path}
          content={markdownContent}
        />
      </Suspense>
    )
  }

  if (
    preview.content_text !== null &&
    (preview.file_kind === 'code' || (inferredLanguage !== null && inferredLanguage !== 'markdown'))
  ) {
    return <SessionFileCodePreview content={preview.content_text} path={preview.path} />
  }

  if (preview.file_kind === 'text' && preview.content_text !== null) {
    return <SessionFileCodePreview content={preview.content_text} path={preview.path} plainText />
  }

  if (preview.file_kind === 'image' && preview.content_base64) {
    const imageSrc = `data:${preview.mime_type ?? 'application/octet-stream'};base64,${preview.content_base64}`
    return (
      <SessionFileImagePreview
        src={imageSrc}
        alt={preview.name}
        onOpen={() => {
          onOpenImage({
            src: imageSrc,
            alt: preview.name,
          })
        }}
      />
    )
  }

  if (preview.file_kind === 'image') {
    return (
      <div className="session-file-preview-viewer__empty">
        这张图片体积过大，当前预览页没有继续加载内容。
      </div>
    )
  }

  return (
    <div className="session-file-preview-viewer__empty">
      当前文件暂不支持预览。
    </div>
  )
}

export const SessionFilePreviewPage = ({
  agentId,
  sessionId,
  projectName,
  projectPath,
  isActive,
  onBack,
}: SessionFilePreviewPageProps) => {
  const queryClient = useQueryClient()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const navScrollRef = useRef<HTMLDivElement | null>(null)
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const previousSessionIdRef = useRef(sessionId)
  const [currentDirectoryPath, setCurrentDirectoryPath] = useState<string | null>(null)
  const [openTabs, setOpenTabs] = useState<OpenFileTab[]>([])
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null)
  const [openLevelKey, setOpenLevelKey] = useState<string | null>(null)
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const [imageLightbox, setImageLightbox] = useState<ImageLightboxState | null>(null)
  const levels = useMemo(
    () => buildDirectoryLevels(projectName, currentDirectoryPath),
    [currentDirectoryPath, projectName],
  )
  const levelQueries = useQueries({
    queries: levels.map((level) =>
      getSessionFilePreviewTreeQueryOptions({
        agentId,
        sessionId,
        enabled: isActive,
        path: level.currentPath,
      }),
    ),
  })
  const contentQuery = useQuery(
    getSessionFilePreviewContentQueryOptions({
      agentId,
      sessionId,
      enabled: isActive && Boolean(activeTabPath),
      path: activeTabPath ?? '',
    }),
  )
  const activePreview = contentQuery.data
  const openLevelIndex = levels.findIndex((level) => level.key === openLevelKey)
  const openLevel = openLevelIndex >= 0 ? levels[openLevelIndex] : null
  const openLevelQuery = openLevelIndex >= 0 ? levelQueries[openLevelIndex] : null
  const openLevelNodes = openLevelQuery?.data?.nodes ?? []

  const openFileTab = (tab: OpenFileTab) => {
    setOpenTabs((currentTabs) => {
      if (currentTabs.some((item) => item.path === tab.path)) {
        return currentTabs
      }

      return [...currentTabs, tab]
    })
    setActiveTabPath(tab.path)
  }

  const closeFileTab = (path: string) => {
    setOpenTabs((currentTabs) => {
      const nextTabs = currentTabs.filter((item) => item.path !== path)
      setActiveTabPath((currentActiveTabPath) => {
        if (currentActiveTabPath !== path) {
          return currentActiveTabPath
        }

        const closedTabIndex = currentTabs.findIndex((item) => item.path === path)
        const nextActiveTab =
          nextTabs[closedTabIndex] ??
          nextTabs[Math.max(0, closedTabIndex - 1)] ??
          null
        return nextActiveTab?.path ?? null
      })
      return nextTabs
    })
  }

  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current
    if (previousSessionId !== sessionId) {
      cleanupSessionPreviewQueries(previousSessionId, queryClient)
      previousSessionIdRef.current = sessionId
    }

    setCurrentDirectoryPath(null)
    setOpenTabs([])
    setActiveTabPath(null)
    setOpenLevelKey(null)
    setMenuStyle(null)
    setImageLightbox(null)
  }, [queryClient, sessionId, projectPath])

  useEffect(() => {
    return () => {
      cleanupSessionPreviewQueries(previousSessionIdRef.current, queryClient)
    }
  }, [queryClient])

  useEffect(() => {
    if (!isActive) {
      setOpenLevelKey(null)
      setMenuStyle(null)
      setImageLightbox(null)
    }
  }, [isActive])

  useEffect(() => {
    setImageLightbox(null)
  }, [activeTabPath])

  useEffect(() => {
    if (!activeTabPath) {
      return
    }

    setCurrentDirectoryPath(getParentDirectoryPath(activeTabPath))
    setOpenLevelKey(null)
    setMenuStyle(null)
  }, [activeTabPath])

  useEffect(() => {
    if (!isActive || !currentDirectoryPath) {
      return
    }

    const navScroll = navScrollRef.current
    if (!navScroll) {
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      navScroll.scrollTo({
        left: navScroll.scrollWidth,
        behavior: 'smooth',
      })
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [currentDirectoryPath, isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const container = containerRef.current
      if (!container || container.contains(event.target as Node)) {
        return
      }
      setOpenLevelKey(null)
      setMenuStyle(null)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isActive])

  useEffect(() => {
    if (!openLevelKey) {
      setMenuStyle(null)
      return
    }

    const container = containerRef.current
    const trigger = triggerRefs.current[openLevelKey]
    if (!container || !trigger) {
      setMenuStyle(null)
      return
    }

    const updateMenuPosition = () => {
      const containerRect = container.getBoundingClientRect()
      const triggerRect = trigger.getBoundingClientRect()
      const left = Math.max(0, triggerRect.left - containerRect.left)
      setMenuStyle({
        left: `${left}px`,
      })
    }

    updateMenuPosition()
    const navScroll = navScrollRef.current
    navScroll?.addEventListener('scroll', updateMenuPosition, { passive: true })
    window.addEventListener('resize', updateMenuPosition)

    return () => {
      navScroll?.removeEventListener('scroll', updateMenuPosition)
      window.removeEventListener('resize', updateMenuPosition)
    }
  }, [openLevelKey, levels])

  const renderOpenLevelMenu = () => {
    if (!openLevel || !menuStyle) {
      return null
    }

    return (
      <div className="session-file-preview-nav__menu" role="menu" style={menuStyle}>
        {openLevelQuery?.isPending ? (
          <div className="session-file-preview-nav__status">正在载入…</div>
        ) : openLevelQuery?.isError ? (
          <div className="session-file-preview-nav__status is-error">{openLevelQuery.error.message}</div>
        ) : openLevelNodes.length > 0 ? (
          openLevelNodes.map((node) => {
            const Icon = getNodeIcon(node)
            const isSelectedDirectory = node.kind === 'directory' && node.path === openLevel.currentPath
            const isSelectedFile = node.kind === 'file' && node.path === activeTabPath
            return (
              <button
                key={node.path}
                type="button"
                className={`session-file-preview-nav__option ${
                  isSelectedDirectory || isSelectedFile ? 'is-selected' : ''
                }`}
                onClick={() => {
                  if (node.kind === 'directory') {
                    setCurrentDirectoryPath(node.path)
                    setOpenLevelKey(node.path)
                  } else {
                    setCurrentDirectoryPath(getParentDirectoryPath(node.path))
                    openFileTab({
                      path: node.path,
                      name: node.name,
                    })
                    setOpenLevelKey(null)
                    setMenuStyle(null)
                  }
                }}
                role="menuitem"
              >
                <span className="session-file-preview-nav__option-icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="session-file-preview-nav__option-label">{node.name}</span>
                {isSelectedDirectory || isSelectedFile ? (
                  <span className="session-file-preview-nav__option-check" aria-hidden="true">
                    <Check />
                  </span>
                ) : null}
              </button>
            )
          })
        ) : (
          <div className="session-file-preview-nav__status">这一层没有可选内容。</div>
        )}
      </div>
    )
  }

  return (
    <section className="session-file-preview" aria-label="项目文件预览">
      <header className="session-file-preview__topbar">
        <button
          type="button"
          className="session-file-preview__back"
          onClick={onBack}
          aria-label="返回会话页"
        >
          <ChevronLeft strokeWidth={1.8} />
        </button>

        <div
          ref={containerRef}
          className="session-file-preview-nav-shell"
        >
          <div
            ref={navScrollRef}
            className="session-file-preview-nav"
          >
            {levels.map((level) => (
              <DirectorySelector
                key={level.key}
                level={level}
                isOpen={openLevelKey === level.key}
                onToggle={() => {
                  setOpenLevelKey((current) => {
                    const nextKey = current === level.key ? null : level.key
                    if (nextKey === null) {
                      setMenuStyle(null)
                    }
                    return nextKey
                  })
                }}
                buttonRef={(node) => {
                  triggerRefs.current[level.key] = node
                }}
              />
            ))}
          </div>
          {renderOpenLevelMenu()}
        </div>
      </header>

        <div className="session-file-preview__viewer">
        <div className="session-file-preview__tabs" role="tablist" aria-label="已打开文件">
          {openTabs.length > 0 ? (
            openTabs.map((tab) => (
              <div
                key={tab.path}
                className={`session-file-preview__tab ${
                  tab.path === activeTabPath ? 'is-active' : ''
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.path === activeTabPath}
                  className="session-file-preview__tab-button"
                  onClick={() => {
                    setActiveTabPath(tab.path)
                  }}
                >
                  <span className="session-file-preview__tab-label">{tab.name}</span>
                </button>
                <button
                  type="button"
                  className="session-file-preview__tab-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeFileTab(tab.path)
                  }}
                  aria-label={`关闭 ${tab.name}`}
                >
                  <X />
                </button>
              </div>
            ))
          ) : (
            <div className="session-file-preview__tabs-empty">未打开文件</div>
          )}
        </div>

        <div className="session-file-preview__viewer-scroll">
          {!activeTabPath ? (
            <div className="session-file-preview-viewer__empty">
              <div className="session-file-preview-viewer__empty-title">选择一个文件开始预览</div>
              <div className="session-file-preview-viewer__empty-meta">
                当前项目根目录：{projectPath}
              </div>
            </div>
          ) : contentQuery.isPending ? (
            <div className="session-file-preview-viewer__empty">正在载入文件内容…</div>
          ) : contentQuery.isError ? (
            <div className="session-file-preview-viewer__empty is-error">
              {contentQuery.error.message}
            </div>
          ) : activePreview ? (
            <div className="session-file-preview__viewer-content">
              {renderPreviewContent(agentId, sessionId, activePreview, setImageLightbox)}
            </div>
          ) : (
            <div className="session-file-preview-viewer__empty">
              暂时没有可显示的内容。
            </div>
          )}
        </div>
      </div>

      {imageLightbox ? (
        <SessionFileImageLightbox
          src={imageLightbox.src}
          alt={imageLightbox.alt}
          onClose={() => {
            setImageLightbox(null)
          }}
        />
      ) : null}
    </section>
  )
}
