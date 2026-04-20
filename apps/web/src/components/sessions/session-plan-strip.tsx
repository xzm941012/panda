import { memo, useState } from 'react'
import type { SessionPlanSnapshot } from '@panda/protocol'

type SessionPlanStripProps = {
  planSnapshot: SessionPlanSnapshot
  hasStripAbove: boolean
  hasStripBelow: boolean
}

export const SessionPlanStrip = memo(function SessionPlanStrip({
  planSnapshot,
  hasStripAbove,
  hasStripBelow,
}: SessionPlanStripProps) {
  const [isCollapsed, setIsCollapsed] = useState(true)

  if (!planSnapshot.steps.length) {
    return null
  }

  return (
    <section
      className={`session-plan-strip ${isCollapsed ? 'is-collapsed' : ''} ${
        hasStripAbove ? 'has-strip-above' : ''
      } ${hasStripBelow ? 'has-strip-below' : ''}`}
    >
      <button
        type="button"
        className="session-plan-strip__toggle"
        onClick={() => setIsCollapsed((current) => !current)}
        aria-expanded={!isCollapsed}
      >
        <div className="session-plan-strip__summary">
          <span className="session-plan-strip__summary-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4.5" y="5" width="15" height="14" rx="2.5" />
              <path d="M8 9h8" />
              <path d="M8 13h5.5" />
              <path d="m15.5 14.5 1.5 1.5 2.5-3" />
            </svg>
          </span>
          <span className="session-plan-strip__summary-text">
            <span>
              共 {planSnapshot.total_count} 个任务，已完成 {planSnapshot.completed_count} 个
            </span>
          </span>
        </div>
        <span className="session-plan-strip__chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m8 10 4 4 4-4" />
          </svg>
        </span>
      </button>

      {!isCollapsed ? (
        <>
          <div className="session-plan-strip__steps">
            {planSnapshot.steps.map((step, index) => (
              <div key={step.id} className={`session-plan-step is-${step.status}`}>
                <span className="session-plan-step__dot" aria-hidden="true">
                  {step.status === 'in_progress' ? (
                    <span className="session-plan-step__spinner" />
                  ) : null}
                </span>
                <span className="session-plan-step__index">{index + 1}.</span>
                <span className="session-plan-step__label">{step.step}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  )
})
