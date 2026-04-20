import { Link } from '@tanstack/react-router'
import type { SessionRef } from '@panda/protocol'
import { capabilityLabel, formatTime, sessionTone } from '../../lib/format'

export const SessionCard = ({ session }: { session: SessionRef }) => (
  <Link
    to="/session/$sessionId"
    params={{ sessionId: session.id }}
    className="session-card"
  >
    <div className="session-card__top">
      <span className={`session-pill ${sessionTone(session)}`}>
        {capabilityLabel(session)}
      </span>
      <span className={`health-dot health-dot--${session.health}`} />
    </div>
    <strong>{session.title}</strong>
    <p>{session.summary}</p>
    <div className="session-card__meta">
      <span>{session.branch}</span>
      <span>{formatTime(session.last_event_at)}</span>
    </div>
  </Link>
)
