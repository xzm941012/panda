type SessionEmptyStateProps = {
  mode: 'node' | 'session'
  agentName?: string | null
  agentStatus?: 'online' | 'offline' | null
  onOpenNodes: () => void
  onCreateThread?: () => void
}

export const SessionEmptyState = ({
  mode,
  agentName,
  agentStatus,
  onOpenNodes,
  onCreateThread,
}: SessionEmptyStateProps) => {
  if (mode === 'node') {
    return (
      <section className="session-empty-state is-node-mode">
        <div className="session-empty-state__eyebrow">Panda Workspace</div>
        <div className="session-empty-state__actions">
          <button
            type="button"
            className="session-empty-state__button is-primary"
            onClick={onOpenNodes}
          >
            选择节点
          </button>
        </div>
      </section>
    )
  }

  const isOnline = agentStatus === 'online'

  return (
    <section className="session-empty-state is-session-mode">
      <div className="session-empty-state__status-row">
        <span
          className={`session-empty-state__status-dot is-${isOnline ? 'online' : 'offline'}`}
          aria-hidden="true"
        />
        <div className="session-empty-state__eyebrow">
          节点 · {agentName ?? '当前节点'}
        </div>
      </div>
      <div className="session-empty-state__actions">
        {onCreateThread ? (
          <button
            type="button"
            className="session-empty-state__button is-primary"
            onClick={onCreateThread}
          >
            新建会话
          </button>
        ) : null}
        <button
          type="button"
          className="session-empty-state__button"
          onClick={onOpenNodes}
        >
          切换节点
        </button>
      </div>
    </section>
  )
}
