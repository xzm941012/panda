import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { SessionRef } from '@panda/protocol'
import { resolveConnectionTarget } from '../../lib/client'
import { capabilityLabel, composerHint, sessionTone } from '../../lib/format'
import { useUiStore } from '../../store/ui-store'

export const Composer = ({ session }: { session: SessionRef }) => {
  const composerText = useUiStore((s) => s.composerText)
  const setComposerText = useUiStore((s) => s.setComposerText)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const canSendInput = session.capability.can_send_input

  const mutation = useMutation({
    mutationFn: async (input: string) => {
      const target = await resolveConnectionTarget({
        sessionId: session.id,
        projectId: session.project_id,
        agentId: session.agent_id,
      })
      const response = await fetch(
        `${target.baseUrl}/api/sessions/${session.id}/input`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input }),
        },
      )
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(body?.error ?? '暂时无法把输入发送到这个会话。')
      }
    },
    onMutate: () => setErrorMessage(null),
    onSuccess: () => setComposerText(''),
    onError: (error) => {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : '暂时无法把输入发送到这个会话。',
      )
    },
  })

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        if (!canSendInput || !composerText.trim()) return
        mutation.mutate(composerText)
      }}
    >
      <div className="composer__heading">
        <div>
          <p className="eyebrow">Prompt</p>
          <h3>远程输入</h3>
        </div>
        <span className={`session-pill ${sessionTone(session)}`}>
          {capabilityLabel(session)}
        </span>
      </div>
      <label className="composer__field">
        <span className="sr-only">Remote prompt</span>
        <textarea
          rows={3}
          value={composerText}
          disabled={!canSendInput}
          placeholder={composerHint(session)}
          onChange={(e) => setComposerText(e.target.value)}
        />
      </label>
      <p className="composer__hint">
        {canSendInput
          ? 'Managed 会话支持实时输入、流式回显和后续审批。'
          : `${capabilityLabel(session)} 目前是只读模式。`}
      </p>
      {errorMessage && <p className="composer__error">{errorMessage}</p>}
      <div className="composer__actions">
        <button
          type="button"
          className="button button--secondary"
          disabled={!canSendInput}
        >
          语音输入
        </button>
        <button
          type="submit"
          className="button"
          disabled={!canSendInput || mutation.isPending}
        >
          {mutation.isPending ? '发送中…' : '发送到 Codex'}
        </button>
      </div>
    </form>
  )
}
