import { useSnapshot } from '../../lib/use-snapshot'
import { healthOrder } from '../../lib/format'
import { PageHeader } from '../shared/page-header'
import { SessionCard } from '../shared/session-card'
import { EmptyState } from '../shared/empty-state'

export const SessionsPage = () => {
  const { data: snapshot } = useSnapshot()

  const sessions = [...(snapshot?.sessions ?? [])].sort(
    (a, b) => healthOrder(a.health) - healthOrder(b.health),
  )

  return (
    <div className="page-container sessions-page">
      <PageHeader
        title="远程会话"
        subtitle={`${sessions.length} 个会话`}
      />
      <div className="page-content session-list">
        {sessions.length === 0 ? (
          <EmptyState message="暂无可用会话。" />
        ) : (
          sessions.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))
        )}
      </div>
    </div>
  )
}
