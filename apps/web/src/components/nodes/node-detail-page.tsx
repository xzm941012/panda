import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useSnapshot } from '../../lib/use-snapshot'
import { agentDisplayName, agentOriginalName } from '../../lib/format'
import { PageHeader } from '../shared/page-header'
import { EmptyState } from '../shared/empty-state'
import { SessionCard } from '../shared/session-card'
import { resolveConnectionTarget } from '../../lib/client'

const createProjectRequest = async (payload: { agentId: string; name: string; path: string }) => {
  const target = await resolveConnectionTarget({
    agentId: payload.agentId,
  })
  const response = await fetch(`${target.baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.project) {
    throw new Error(body?.error ?? '无法创建项目')
  }
  return body.project
}

const createSessionRequest = async (payload: { agentId: string; projectId: string; title: string }) => {
  const target = await resolveConnectionTarget({
    agentId: payload.agentId,
    projectId: payload.projectId,
  })
  const response = await fetch(`${target.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.session) {
    throw new Error(body?.error ?? '无法创建会话')
  }
  return body.session
}

export const NodeDetailPage = () => {
  const { agentId } = useParams({ strict: false }) as { agentId: string }
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: snapshot, isLoading } = useSnapshot()

  const [showProjectForm, setShowProjectForm] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')

  const [showSessionForm, setShowSessionForm] = useState(false)
  const [sessionTitle, setSessionTitle] = useState('')
  const [sessionProjectId, setSessionProjectId] = useState('')

  const agent = snapshot?.agents.find((a) => a.id === agentId)
  
  const projects = useMemo(() => {
    return (snapshot?.projects ?? []).filter((p) => p.agent_id === agentId)
  }, [snapshot?.projects, agentId])

  const sessions = useMemo(() => {
    return (snapshot?.sessions ?? []).filter((s) => s.agent_id === agentId)
  }, [snapshot?.sessions, agentId])

  const refreshSnapshot = async () => {
    await queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
  }

  const projectMutation = useMutation({
    mutationFn: createProjectRequest,
    onSuccess: async () => {
      setProjectName('')
      setProjectPath('')
      setShowProjectForm(false)
      await refreshSnapshot()
    },
  })

  const sessionMutation = useMutation({
    mutationFn: createSessionRequest,
    onSuccess: async (session) => {
      setSessionTitle('')
      setShowSessionForm(false)
      await refreshSnapshot()
      void navigate({
        to: '/session/$sessionId',
        params: { sessionId: session.id },
      })
    },
  })

  if (isLoading && !snapshot) {
    return <div className="page-container"><PageHeader title="加载中..." /></div>
  }

  if (!agent) {
    return (
      <div className="page-container">
        <PageHeader title="节点未找到" />
        <EmptyState message="该节点不存在或已离线" />
      </div>
    )
  }

  return (
    <div className="page-container node-detail-page">
      <PageHeader
        title={agentDisplayName(agent)}
        subtitle={[
          agentOriginalName(agent),
          agent.host,
          agent.status,
        ].filter(Boolean).join(' • ')}
        back={true}
      />

      <div className="page-content">
        {/* Projects Section */}
        <section className="detail-section">
          <div className="section-heading">
            <h2>项目 ({projects.length})</h2>
            <button
              className="button button--primary button--sm"
              onClick={() => {
                setShowProjectForm(!showProjectForm)
                setShowSessionForm(false)
              }}
            >
              + 新建项目
            </button>
          </div>

          {showProjectForm && (
            <form
              className="surface-card form-card"
              onSubmit={(e) => {
                e.preventDefault()
                if (!projectName.trim() || !projectPath.trim()) return
                projectMutation.mutate({ agentId, name: projectName, path: projectPath })
              }}
            >
              <h3>创建新项目</h3>
              <input
                className="input"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="项目名称"
              />
              <input
                className="input"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder="项目路径 (例如: /var/www/app)"
              />
              <div className="form-actions">
                <button type="button" className="button button--ghost" onClick={() => setShowProjectForm(false)}>取消</button>
                <button type="submit" className="button button--primary" disabled={projectMutation.isPending}>
                  {projectMutation.isPending ? '创建中...' : '确认创建'}
                </button>
              </div>
              {projectMutation.error && (
                <p className="error-text">{projectMutation.error instanceof Error ? projectMutation.error.message : '创建失败'}</p>
              )}
            </form>
          )}

          {projects.length === 0 && !showProjectForm ? (
            <EmptyState message="该节点下暂无项目" />
          ) : (
            <div className="project-grid">
              {projects.map((project) => (
                <div key={project.id} className="surface-card project-card">
                  <strong>{project.name}</strong>
                  <span className="mono text-muted">{project.path}</span>
                  <div className="project-card__actions">
                    <button 
                      className="button button--ghost button--sm"
                      onClick={() => {
                        setSessionProjectId(project.id)
                        setShowSessionForm(true)
                        setShowProjectForm(false)
                        window.scrollTo({ top: 0, behavior: 'smooth' })
                      }}
                    >
                      + 新建会话
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Sessions Section */}
        <section className="detail-section">
          <div className="section-heading">
            <h2>会话 ({sessions.length})</h2>
            <button
              className="button button--primary button--sm"
              disabled={projects.length === 0}
              title={projects.length === 0 ? '请先创建项目' : ''}
              onClick={() => {
                setShowSessionForm(!showSessionForm)
                setShowProjectForm(false)
                if (projects.length > 0 && !sessionProjectId) {
                  setSessionProjectId(projects[0].id)
                }
              }}
            >
              + 新建会话
            </button>
          </div>

          {projects.length === 0 && sessions.length === 0 && (
             <div className="info-banner">
               <p>要开始会话，请先创建一个项目。</p>
             </div>
          )}

          {showSessionForm && (
            <form
              className="surface-card form-card"
              onSubmit={(e) => {
                e.preventDefault()
                if (!sessionProjectId || !sessionTitle.trim()) return
                sessionMutation.mutate({ agentId, projectId: sessionProjectId, title: sessionTitle })
              }}
            >
              <h3>创建新会话</h3>
              <select
                className="input"
                value={sessionProjectId}
                onChange={(e) => setSessionProjectId(e.target.value)}
              >
                <option value="" disabled>选择关联项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
              <input
                className="input"
                value={sessionTitle}
                onChange={(e) => setSessionTitle(e.target.value)}
                placeholder="会话标题"
              />
              <div className="form-actions">
                <button type="button" className="button button--ghost" onClick={() => setShowSessionForm(false)}>取消</button>
                <button type="submit" className="button button--primary" disabled={sessionMutation.isPending || !sessionProjectId}>
                  {sessionMutation.isPending ? '创建中...' : '确认创建'}
                </button>
              </div>
              {sessionMutation.error && (
                <p className="error-text">{sessionMutation.error instanceof Error ? sessionMutation.error.message : '创建失败'}</p>
              )}
            </form>
          )}

          {sessions.length === 0 && !showSessionForm ? (
            <EmptyState message="该节点下暂无会话" />
          ) : (
            <div className="session-list">
              {sessions.map((session) => (
                <SessionCard key={session.id} session={session} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
