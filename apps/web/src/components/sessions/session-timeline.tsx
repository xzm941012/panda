import { memo, type CSSProperties, type ReactNode, type RefObject } from 'react'

type ConnectionStatus = {
  state: 'connected' | 'reconnecting' | 'failed'
  attempt: number
  maxAttempts: number
  error?: string
}

type SessionRecoveryStatus = {
  state: 'idle' | 'recovering' | 'failed'
  error?: string
}

type SessionTimelineProps = {
  conversationMainRef: RefObject<HTMLDivElement | null>
  conversationScrollRef: RefObject<HTMLDivElement | null>
  isDesktopSidebar: boolean
  sidebarShift: number
  isSidebarDragging: boolean
  title: string
  titleActions?: ReactNode
  topbarActions?: ReactNode
  onOpenSidebar: () => void
  threadContent: ReactNode
  connectionStatus: ConnectionStatus
  sessionRecoveryStatus: SessionRecoveryStatus
  isConnectionDetailOpen: boolean
  onToggleConnectionDetail: () => void
  showThinkingStatus: boolean
}

export const SessionTimeline = memo(function SessionTimeline({
  conversationMainRef,
  conversationScrollRef,
  isDesktopSidebar,
  sidebarShift,
  isSidebarDragging,
  title,
  titleActions,
  topbarActions,
  onOpenSidebar,
  threadContent,
  connectionStatus,
  sessionRecoveryStatus,
  isConnectionDetailOpen,
  onToggleConnectionDetail,
  showThinkingStatus,
}: SessionTimelineProps) {
  const mainStyle: CSSProperties = {
    transform: `translateX(${sidebarShift}px)`,
    transition: isSidebarDragging ? 'none' : undefined,
  }

  return (
    <div
      ref={conversationMainRef}
      className={`conversation-main ${isDesktopSidebar ? 'has-desktop-sidebar' : ''}`}
      style={mainStyle}
    >
      <div className="conversation-topbar">
        {!isDesktopSidebar ? (
          <button
            type="button"
            className="conversation-menu"
            onClick={onOpenSidebar}
            aria-label="打开侧边栏"
          >
            <span />
            <span className="short" />
          </button>
        ) : null}

        <div className="conversation-topbar__meta">
          <div className="conversation-topbar__title-row">
            <h1>{title}</h1>
            {titleActions}
          </div>
        </div>

        {topbarActions}
      </div>

      <div ref={conversationScrollRef} className="conversation-scroll">
        <div className="conversation-thread">
          {threadContent}

          {connectionStatus.state !== 'connected' ? (
            <section className="conversation-entry is-connection-status">
              <div className="connection-status">
                <button
                  type="button"
                  className="connection-status__pill"
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleConnectionDetail()
                  }}
                >
                  <span>
                    {connectionStatus.state === 'failed'
                      ? '连接异常'
                      : `Reconnecting... ${connectionStatus.attempt}/${connectionStatus.maxAttempts}`}
                  </span>
                </button>
                {isConnectionDetailOpen && connectionStatus.error ? (
                  <div className="connection-status__tooltip" role="tooltip">
                    {connectionStatus.error}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {connectionStatus.state === 'connected' &&
          sessionRecoveryStatus.state !== 'idle' ? (
            <section className="conversation-entry is-connection-status">
              <div className="connection-status">
                <div className="connection-status__pill">
                  <span>
                    {sessionRecoveryStatus.state === 'recovering'
                      ? '恢复会话中...'
                      : '会话恢复失败'}
                  </span>
                </div>
                {sessionRecoveryStatus.state === 'failed' &&
                sessionRecoveryStatus.error ? (
                  <div className="connection-status__tooltip" role="tooltip">
                    {sessionRecoveryStatus.error}
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {showThinkingStatus ? (
            <section className="conversation-entry is-thinking-status">
              <div className="thinking-status-pill">
                <span>正在思考</span>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
})
