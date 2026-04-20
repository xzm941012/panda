import { useSnapshot } from '../../lib/use-snapshot'
import { PageHeader } from '../shared/page-header'
import { EmptyState } from '../shared/empty-state'

export const ApprovalsPage = () => {
  const { data: snapshot } = useSnapshot()
  const approvals = snapshot?.approvals ?? []

  return (
    <div className="page-container approvals-page">
      <PageHeader
        title="审批管理"
        subtitle={`${approvals.length} 个待处理`}
      />
      <div className="page-content approval-list">
        {approvals.length === 0 ? (
          <EmptyState message="暂无待处理审批" />
        ) : (
          approvals.map((approval) => (
            <div key={approval.id} className="approval-card surface-card">
              <div className="approval-card__header">
                <strong>{approval.title}</strong>
                <span className={`approval-status approval-status--${approval.status}`}>
                  {approval.status === 'pending' ? '待处理' : 
                   approval.status === 'approved' ? '已通过' : '已拒绝'}
                </span>
              </div>
              <p className="approval-card__desc">{approval.description}</p>
              {approval.status === 'pending' && (
                <div className="approval-card__actions">
                  <button className="btn btn-secondary btn-sm">拒绝</button>
                  <button className="btn btn-primary btn-sm">通过</button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
