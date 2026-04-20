import type { TimelineEntry, SocketEvent } from '@panda/protocol'
import { formatTime } from '../../lib/format'
import { EmptyState } from '../shared/empty-state'

export const Timeline = ({
  timeline,
  events,
}: {
  timeline: TimelineEntry[]
  events: SocketEvent[]
}) => (
  <>
    <section className="sheet">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Timeline</p>
          <h3>会话进展</h3>
        </div>
        <span className="soft-badge">实时回放</span>
      </div>
      <div className="timeline-list">
        {timeline.map((entry, index) => (
          <article
            key={entry.id}
            className={`timeline-entry timeline-entry--${entry.accent}`}
            style={{ ['--i' as string]: index }}
          >
            <div className="timeline-entry__meta">
              <span>{entry.kind}</span>
              <time dateTime={entry.timestamp}>
                {formatTime(entry.timestamp)}
              </time>
            </div>
            <h4>{entry.title}</h4>
            <p>{entry.body}</p>
          </article>
        ))}
      </div>
    </section>

    <section className="sheet">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Realtime</p>
          <h3>Agent 流</h3>
        </div>
        <span className="soft-badge">WebSocket</span>
      </div>
      <div className="feed-list">
        {events.length === 0 ? (
          <EmptyState message="正在等待新的 agent 事件。" />
        ) : (
          events.map((event) => (
            <div
              key={`${event.type}-${event.timestamp}`}
              className="feed-item"
            >
              <strong>{event.type}</strong>
              <span>{formatTime(event.timestamp)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  </>
)
