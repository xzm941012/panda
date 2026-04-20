import { useSnapshot } from '../../lib/use-snapshot'
import {
  agentAddressLabel,
  agentDisplayName,
  agentOriginalName,
  statusTone,
} from '../../lib/format'
import { PageHeader } from '../shared/page-header'
import { EmptyState } from '../shared/empty-state'

export const FleetPage = () => {
  const { data: snapshot } = useSnapshot()
  const agents = snapshot?.agents ?? []
  const projects = snapshot?.projects ?? []

  const onlineCount = agents.filter((a) => a.status === 'online').length

  return (
    <div className="fleet-page">
      <PageHeader
        title="机群监控"
        subtitle={`${onlineCount} / ${agents.length} 在线`}
      />

      {agents.length === 0 ? (
        <EmptyState message="暂无 Agent 节点。" />
      ) : (
        <div className="agent-list">
          {agents.map((agent) => {
            const agentProjects = projects.filter(
              (p) => p.agent_id === agent.id,
            )
            return (
              <article key={agent.id} className="agent-item">
                <div className="agent-item__title">
                  <span className={statusTone(agent.status)} />
                  <strong>{agentDisplayName(agent)}</strong>
                </div>
                {agentOriginalName(agent) ? <p>{agentOriginalName(agent)}</p> : null}
                <p>{agentAddressLabel(agent)}</p>
                <div className="agent-item__meta">
                  <span>{agent.project_count} 项目</span>
                  <span>{agent.session_count} 会话</span>
                </div>
                {agentProjects.length > 0 && (
                  <div className="fleet-projects">
                    {agentProjects.map((project) => (
                      <article key={project.id} className="project-card">
                        <div className="project-card__top">
                          <strong>{project.name}</strong>
                          <span className="soft-badge">{project.branch}</span>
                        </div>
                        <p>{project.path}</p>
                        <div className="project-card__meta">
                          <span>worktree {project.worktree}</span>
                          <span>{project.runtime_profiles.join(' · ')}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
