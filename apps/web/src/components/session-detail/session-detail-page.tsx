import { useEffect, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import type { SocketEvent } from '@panda/protocol'
import { useSnapshot } from '../../lib/use-snapshot'
import { resolveConnectionTarget } from '../../lib/client'
import { capabilityLabel, sessionMetaLine, sessionTone } from '../../lib/format'
import { useUiStore } from '../../store/ui-store'
import { PageHeader } from '../shared/page-header'
import { Timeline } from './timeline'
import { Inspector } from './inspector'
import { Composer } from './composer'

export const SessionDetailPage = () => {
  const { sessionId } = useParams({ strict: false }) as {
    sessionId: string
  }
  const { data: snapshot } = useSnapshot()
  const setBottomNavVisible = useUiStore((s) => s.setBottomNavVisible)

  const [events, setEvents] = useState<SocketEvent[]>([])

  useEffect(() => {
    setBottomNavVisible(false)
    return () => setBottomNavVisible(true)
  }, [setBottomNavVisible])

  useEffect(() => {
    let disconnect: (() => void) | undefined
    let cancelled = false

    void resolveConnectionTarget({
      sessionId,
      projectId: session?.project_id ?? null,
      agentId: session?.agent_id ?? null,
    }).then((target) => {
      if (cancelled) return

      disconnect = target.client.connectEvents((event) => {
        setEvents((current) => [event, ...current].slice(0, 6))
      })
    })

    return () => {
      cancelled = true
      disconnect?.()
    }
  }, [])

  if (!snapshot) {
    return <div className="loading-shell">加载中…</div>
  }

  const session = snapshot.sessions.find((s) => s.id === sessionId)
  if (!session) {
    return <div className="loading-shell">未找到该会话。</div>
  }

  const project = snapshot.projects.find(
    (p) => p.id === session.project_id,
  )

  return (
    <div className="session-detail">
      <PageHeader
        title={session.title}
        subtitle={sessionMetaLine(session)}
        back
        trailing={
          <span className={`session-pill ${sessionTone(session)}`}>
            {capabilityLabel(session)}
          </span>
        }
      />

      <section className="session-overview">
        <div className="session-overview__chips">
          <span className="soft-badge">{session.branch}</span>
          <span className="soft-badge">
            {project?.worktree ?? session.worktree}
          </span>
          <span className={`health-dot health-dot--${session.health}`} />
        </div>
        <p className="session-overview__summary">{session.summary}</p>
      </section>

      <Timeline timeline={snapshot.timeline} events={events} />

      <Inspector
        changedFiles={snapshot.changed_files}
        runtimeProcesses={snapshot.runtime_processes}
        previews={snapshot.previews}
        approvals={snapshot.approvals}
      />

      <Composer session={session} />
    </div>
  )
}
