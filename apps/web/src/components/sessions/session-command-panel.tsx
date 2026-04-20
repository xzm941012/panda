import { useEffect, useState } from 'react'
import type { CodexCommandPanel } from '@panda/protocol'

type SessionCommandPanelProps = {
  panel: CodexCommandPanel
  isPending: boolean
  onDismiss: () => void
  onSelectOption: (optionId: string) => void
  onSubmitText: (value: string) => void
}

const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </svg>
)

export const SessionCommandPanel = ({
  panel,
  isPending,
  onDismiss,
  onSelectOption,
  onSubmitText,
}: SessionCommandPanelProps) => {
  const [textValue, setTextValue] = useState('')

  useEffect(() => {
    setTextValue('')
  }, [panel.panel_id, panel.status])

  return (
    <section className={`session-command-panel is-${panel.status}`}>
      <div className="session-command-panel__header">
        <div className="session-command-panel__command">/{panel.command_name}</div>
        <button
          type="button"
          className="session-command-panel__close"
          aria-label="关闭命令面板"
          onClick={onDismiss}
        >
          <IconClose />
        </button>
      </div>

      <div className="session-command-panel__title">{panel.title}</div>
      {panel.description ? (
        <div className="session-command-panel__description">{panel.description}</div>
      ) : null}
      <pre className="session-command-panel__body">{panel.body}</pre>

      {panel.input_type === 'choice' && panel.options.length > 0 ? (
        <div className="session-command-panel__options">
          {panel.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="session-command-panel__option"
              disabled={isPending}
              onClick={() => onSelectOption(option.id)}
            >
              <span className="session-command-panel__option-label">{option.label}</span>
              {option.description ? (
                <span className="session-command-panel__option-description">
                  {option.description}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {panel.input_type === 'text' ? (
        <form
          className="session-command-panel__form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!textValue.trim() || isPending) {
              return
            }

            onSubmitText(textValue.trim())
          }}
        >
          <input
            className="session-command-panel__input"
            value={textValue}
            disabled={isPending}
            placeholder={panel.input_placeholder ?? '继续输入'}
            onChange={(event) => setTextValue(event.target.value)}
          />
          <button
            type="submit"
            className="session-command-panel__submit"
            disabled={isPending || !textValue.trim()}
          >
            {panel.submit_label ?? '提交'}
          </button>
        </form>
      ) : null}
    </section>
  )
}
