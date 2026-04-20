import {
  memo,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import type {
  SessionTerminal,
  SessionTerminalOutputChunk,
} from '@panda/protocol'

export type SessionTerminalOutputState = {
  chunks: SessionTerminalOutputChunk[]
  nextCursor: number
  truncated: boolean
  isLoading: boolean
  error: string | null
}

type SessionTerminalPanelProps = {
  terminals: SessionTerminal[]
  activeTerminalId: string | null
  outputs: Record<string, SessionTerminalOutputState>
  error: string | null
  compact?: boolean
  canToggleFullscreen?: boolean
  isFullscreen?: boolean
  onSelectTerminal: (terminalId: string) => void
  onCloseTerminal: (terminalId: string) => void
  onToggleFullscreen?: () => void
}

type AnsiState = {
  fg: string | null
  bg: string | null
  bold: boolean
  dim: boolean
  underline: boolean
}

type AnsiSegment = {
  text: string
  className: string
}

const ANSI_ESCAPE_PATTERN = /\u001b\[([0-9;]*)m/g

const STREAM_LABEL: Record<SessionTerminalOutputChunk['stream'], string> = {
  stdout: '',
  stderr: 'stderr',
  system: 'system',
}

const ANSI_COLOR_TOKEN_BY_CODE: Record<number, string> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  90: 'bright-black',
  91: 'bright-red',
  92: 'bright-green',
  93: 'bright-yellow',
  94: 'bright-blue',
  95: 'bright-magenta',
  96: 'bright-cyan',
  97: 'bright-white',
}

const EMPTY_ANSI_STATE: AnsiState = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  underline: false,
}

const IconClose = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 6 18 18" />
    <path d="M18 6 6 18" />
  </svg>
)

const IconExpand = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 4H4v4" />
    <path d="M16 4h4v4" />
    <path d="M8 20H4v-4" />
    <path d="M16 20h4v-4" />
    <path d="M9 9 4 4" />
    <path d="m15 9 5-5" />
    <path d="m9 15-5 5" />
    <path d="m15 15 5 5" />
  </svg>
)

const IconCollapse = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 4H4v5" />
    <path d="M15 4h5v5" />
    <path d="M9 20H4v-5" />
    <path d="M15 20h5v-5" />
    <path d="m4 9 5-5" />
    <path d="m20 9-5-5" />
    <path d="m4 15 5 5" />
    <path d="m20 15-5 5" />
  </svg>
)

const formatTime = (value: string | null) => {
  if (!value) {
    return '刚刚'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '刚刚'
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

const buildAnsiClassName = (
  baseClassName: string,
  state: AnsiState,
): string => {
  const classNames = [baseClassName]
  if (state.bold) {
    classNames.push('is-bold')
  }
  if (state.dim) {
    classNames.push('is-dim')
  }
  if (state.underline) {
    classNames.push('is-underline')
  }
  if (state.fg) {
    classNames.push(`is-fg-${state.fg}`)
  }
  if (state.bg) {
    classNames.push(`is-bg-${state.bg}`)
  }
  return classNames.join(' ')
}

const applyAnsiCode = (
  current: AnsiState,
  code: number,
): AnsiState => {
  if (code === 0) {
    return { ...EMPTY_ANSI_STATE }
  }
  if (code === 1) {
    return {
      ...current,
      bold: true,
      dim: false,
    }
  }
  if (code === 2) {
    return {
      ...current,
      dim: true,
      bold: false,
    }
  }
  if (code === 4) {
    return {
      ...current,
      underline: true,
    }
  }
  if (code === 22) {
    return {
      ...current,
      bold: false,
      dim: false,
    }
  }
  if (code === 24) {
    return {
      ...current,
      underline: false,
    }
  }
  if (code === 39) {
    return {
      ...current,
      fg: null,
    }
  }
  if (code === 49) {
    return {
      ...current,
      bg: null,
    }
  }

  const foregroundColor = ANSI_COLOR_TOKEN_BY_CODE[code]
  if (foregroundColor) {
    return {
      ...current,
      fg: foregroundColor,
    }
  }

  const backgroundColor = ANSI_COLOR_TOKEN_BY_CODE[code - 10]
  if (backgroundColor && code >= 40) {
    return {
      ...current,
      bg: backgroundColor,
    }
  }

  return current
}

const parseAnsiText = (
  value: string,
  baseClassName: string,
): AnsiSegment[] => {
  const segments: AnsiSegment[] = []
  let lastIndex = 0
  let state = { ...EMPTY_ANSI_STATE }

  for (const match of value.matchAll(ANSI_ESCAPE_PATTERN)) {
    const offset = match.index ?? 0
    if (offset > lastIndex) {
      segments.push({
        text: value.slice(lastIndex, offset),
        className: buildAnsiClassName(baseClassName, state),
      })
    }

    const codes = (match[1] ?? '')
      .split(';')
      .map((code) => Number.parseInt(code || '0', 10))
      .filter((code) => Number.isFinite(code))

    if (codes.length === 0) {
      state = { ...EMPTY_ANSI_STATE }
    } else {
      state = codes.reduce(applyAnsiCode, state)
    }

    lastIndex = offset + match[0].length
  }

  if (lastIndex < value.length) {
    segments.push({
      text: value.slice(lastIndex),
      className: buildAnsiClassName(baseClassName, state),
    })
  }

  if (segments.length === 0) {
    segments.push({
      text: value,
      className: baseClassName,
    })
  }

  return segments
}

const TerminalOutput = memo(({
  chunks,
}: {
  chunks: SessionTerminalOutputChunk[]
}) => {
  const renderedChunks = useMemo(
    () =>
      chunks.map((chunk) => {
        const streamLabel = STREAM_LABEL[chunk.stream]
        const baseClassName = [
          'session-terminal-output__segment',
          `is-${chunk.stream}`,
        ].join(' ')
        return {
          cursor: chunk.cursor,
          label: streamLabel,
          segments: parseAnsiText(chunk.text, baseClassName),
        }
      }),
    [chunks],
  )

  return (
    <>
      {renderedChunks.map((chunk) => (
        <span key={chunk.cursor} className="session-terminal-output__chunk">
          {chunk.label ? (
            <span className="session-terminal-output__label">{chunk.label}</span>
          ) : null}
          {chunk.segments.map((segment, index) => (
            <span key={`${chunk.cursor}:${index}`} className={segment.className}>
              {segment.text}
            </span>
          ))}
        </span>
      ))}
    </>
  )
})

TerminalOutput.displayName = 'TerminalOutput'

export const SessionTerminalPanel = ({
  terminals,
  activeTerminalId,
  outputs,
  error,
  compact = false,
  canToggleFullscreen = false,
  isFullscreen = false,
  onSelectTerminal,
  onCloseTerminal,
  onToggleFullscreen,
}: SessionTerminalPanelProps) => {
  const outputScrollRef = useRef<HTMLDivElement | null>(null)
  const activeTerminal =
    terminals.find((terminal) => terminal.id === activeTerminalId) ??
    terminals[0] ??
    null
  const activeOutput = activeTerminal ? outputs[activeTerminal.id] : null

  useEffect(() => {
    const container = outputScrollRef.current
    if (!container) {
      return
    }

    container.scrollTop = container.scrollHeight
  }, [activeOutput?.chunks, activeTerminal?.id])

  if (terminals.length === 0) {
    return (
      <section className={`session-terminal-panel ${compact ? 'is-compact' : ''}`}>
        <div className="session-terminal-panel__empty">
          <div className="session-terminal-panel__empty-title">还没有运行中的命令</div>
          <p className="session-terminal-panel__empty-copy">
            从右上角的运行按钮启动一个项目命令后，这里会实时显示终端输出。
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className={`session-terminal-panel ${compact ? 'is-compact' : ''}`}>
      <div className="session-terminal-panel__tabs">
        <div
          className="session-terminal-panel__tab-list"
          role="tablist"
          aria-label="终端列表"
        >
          {terminals.map((terminal) => {
            const isActive = terminal.id === activeTerminal?.id
            return (
              <div
                key={terminal.id}
                className={`session-terminal-panel__tab ${isActive ? 'is-active' : ''}`}
              >
                <button
                  type="button"
                  className="session-terminal-panel__tab-button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onSelectTerminal(terminal.id)}
                >
                  <span
                    className={`session-terminal-panel__tab-dot is-${terminal.status}`}
                    aria-hidden="true"
                  />
                  <span className="session-terminal-panel__tab-title">
                    {terminal.title}
                  </span>
                  <span className="session-terminal-panel__tab-time">
                    {formatTime(terminal.last_output_at ?? terminal.updated_at)}
                  </span>
                </button>
                <button
                  type="button"
                  className="session-terminal-panel__tab-close"
                  aria-label={`关闭 ${terminal.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onCloseTerminal(terminal.id)
                  }}
                >
                  <IconClose />
                </button>
              </div>
            )
          })}
        </div>

        {canToggleFullscreen && onToggleFullscreen ? (
          <button
            type="button"
            className="session-terminal-panel__fullscreen-button"
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? '退出终端全屏' : '终端全屏'}
            title={isFullscreen ? '退出终端全屏' : '终端全屏'}
          >
            {isFullscreen ? <IconCollapse /> : <IconExpand />}
          </button>
        ) : null}
      </div>

      {activeTerminal ? (
        <>
          {error ? (
            <div className="session-terminal-panel__notice is-error">{error}</div>
          ) : null}

          {activeOutput?.error ? (
            <div className="session-terminal-panel__notice is-error">
              {activeOutput.error}
            </div>
          ) : null}

          {activeOutput?.truncated ? (
            <div className="session-terminal-panel__notice">
              终端输出过长，已自动显示服务端仍保留的最近内容。
            </div>
          ) : null}

          <div ref={outputScrollRef} className="session-terminal-panel__output-wrap">
            <pre className="session-terminal-output">
              {activeOutput && activeOutput.chunks.length > 0 ? (
                <TerminalOutput chunks={activeOutput.chunks} />
              ) : activeOutput?.isLoading ? (
                <span className="session-terminal-output__placeholder">
                  正在读取终端输出...
                </span>
              ) : (
                <span className="session-terminal-output__placeholder">
                  这个终端暂时还没有输出。
                </span>
              )}
            </pre>
          </div>
        </>
      ) : null}
    </section>
  )
}
