import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import type {
  CodexCommandPanel,
  PhaseOneSnapshot,
  SessionRef,
  TimelineEntry,
  WorkspaceDirectorySnapshot,
} from '@panda/protocol'
import { WORKSPACE_DIRECTORY_QUERY_KEY } from '../../lib/bootstrap-query'
import { resolveConnectionTarget } from '../../lib/client'
import { appendTimelineEntry, getTimelineOptimisticQueryKey } from '../../lib/timeline-cache'
import {
  hasBootstrapSession,
  patchBootstrapSessionWithSafeLastEventAt,
} from '../../lib/bootstrap-cache'
import {
  getSessionModelLabelFromOptions,
  getSessionReasoningLabel,
  REASONING_OPTIONS,
  readStoredSessionModel,
  readStoredSessionReasoning,
  readStoredTitleGenerationModel,
  writeStoredSessionModel,
  writeStoredSessionReasoning,
} from '../../lib/session-composer-preferences'
import { isSlashCommandInput } from '../../lib/skill-mentions'
import {
  consumePendingProjectId,
  writePendingSessionHandoff,
  queuePendingProjectId,
  queuePendingSessionId,
  writeStoredAgentId,
  writeStoredSessionId,
} from '../../lib/session-selection'
import { useSessionModelOptions } from '../../lib/use-session-model-options'
import { upsertWorkspaceSession } from '../../lib/workspace-directory-cache'
import { useSnapshot } from '../../lib/use-snapshot'
import { ConversationSidebar } from './conversation-sidebar'
import { NewThreadLogo } from './new-thread-logo'
import { SessionCommandPanel } from './session-command-panel'
import { SkillAwareTextarea } from '../shared/skill-aware-textarea'

const SESSION_TITLE_MAX_LENGTH = 10

const makeSessionTitleFromInput = (input: string) => {
  const normalized = input.replace(/\s+/g, ' ').trim()
  if (normalized.length <= SESSION_TITLE_MAX_LENGTH) {
    return normalized
  }

  return normalized.slice(0, SESSION_TITLE_MAX_LENGTH).trimEnd()
}

const parseSlashCommandName = (value: string) => {
  const match = /^\/([A-Za-z][A-Za-z0-9._-]*)/.exec(value.trim())
  return match?.[1]?.toLowerCase() ?? ''
}

export const NewThreadPage = () => {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { agentId } = useParams({ strict: false }) as { agentId: string }
  const { data: snapshot } = useSnapshot()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [pendingProjectId] = useState<string | null>(() => consumePendingProjectId())
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [activeCommandPanel, setActiveCommandPanel] = useState<CodexCommandPanel | null>(null)
  const [activePicker, setActivePicker] = useState<'model' | 'reasoning' | null>(null)
  const [selectedModel, setSelectedModel] = useState(() => readStoredSessionModel())
  const [selectedReasoning, setSelectedReasoning] = useState(() => readStoredSessionReasoning())
  const pickerMenuRef = useRef<HTMLDivElement | null>(null)
  const managedModelOptions = useSessionModelOptions()
  const modelOptions = useMemo(
    () => managedModelOptions.map(({ id: _id, ...option }) => option),
    [managedModelOptions],
  )

  const currentAgent =
    snapshot?.agents.find((agent) => agent.id === agentId) ?? snapshot?.agents[0]

  const projects = useMemo(
    () =>
      (snapshot?.projects ?? []).filter((project) => project.agent_id === currentAgent?.id),
    [currentAgent?.id, snapshot?.projects],
  )

  const sessions = useMemo(
    () =>
      (snapshot?.sessions ?? []).filter((session) => session.agent_id === currentAgent?.id),
    [currentAgent?.id, snapshot?.sessions],
  )

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null,
    [projects, selectedProjectId],
  )

  useEffect(() => {
    writeStoredSessionModel(selectedModel)
  }, [selectedModel])

  useEffect(() => {
    writeStoredSessionReasoning(selectedReasoning)
  }, [selectedReasoning])

  useEffect(() => {
    if (modelOptions.length === 0) {
      return
    }

    if (modelOptions.some((option) => option.value === selectedModel)) {
      return
    }

    setSelectedModel(modelOptions[0].value)
  }, [modelOptions, selectedModel])

  useEffect(() => {
    if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) {
      return
    }

    const preferredProjectId =
      (pendingProjectId && projects.some((project) => project.id === pendingProjectId)
        ? pendingProjectId
        : null) ??
      sessions.find((session) => !session.archived)?.project_id ??
      projects[0]?.id ??
      null
    setSelectedProjectId(preferredProjectId)
  }, [pendingProjectId, projects, selectedProjectId, sessions])

  useEffect(() => {
    if (!selectedProject) {
      setSelectedSessionId(undefined)
      return
    }

    if (
      selectedSessionId &&
      sessions.some(
        (session) =>
          session.id === selectedSessionId && session.project_id === selectedProject.id,
      )
    ) {
      return
    }

    const fallbackSession =
      sessions.find(
        (session) => session.project_id === selectedProject.id && !session.archived,
      ) ?? sessions.find((session) => session.project_id === selectedProject.id)

    setSelectedSessionId(fallbackSession?.id)
  }, [selectedProject, selectedSessionId, sessions])

  const createSessionMutation = useMutation({
    mutationFn: async (payload: {
      projectId: string
      input: string
      title: string
      model: string
      titleGenerationModel: string
      reasoningEffort: string
    }) => {
      if (!currentAgent?.id || !selectedProject || !draft.trim()) {
        throw new Error('请先在左侧选择线程，并输入第一条消息')
      }

      const target = await resolveConnectionTarget({
        projectId: payload.projectId,
        agentId: currentAgent.id,
      })
      const result = (await target.client.createSession({
        agentId: currentAgent.id,
        projectId: payload.projectId,
        title: payload.title,
        input: payload.input,
        model: payload.model,
        titleGenerationModel: payload.titleGenerationModel,
        reasoningEffort: payload.reasoningEffort,
      })) as { session: SessionRef }

      return result.session
    },
    onMutate: () => setErrorMessage(null),
    onSuccess: async (session, variables) => {
      const createdAt = new Date().toISOString()
      const optimisticEntry: TimelineEntry = {
        id: `optimistic-user:${session.id}:create`,
        kind: 'user',
        title: '你',
        body: variables.input,
        body_truncated: false,
        detail_available: false,
        patch_summary: null,
        session_ids: [],
        timestamp: session.last_event_at || createdAt,
        accent: 'primary',
        attachments: [],
      }

      writeStoredAgentId(currentAgent?.id ?? agentId)
      writeStoredSessionId(session.id)
      queuePendingSessionId(session.id)
      queuePendingProjectId(null)
      writePendingSessionHandoff({
        sessionId: session.id,
        agentId: session.agent_id,
        projectId: session.project_id,
        createdAt,
        session,
        project: selectedProject
          ? {
              id: selectedProject.id,
              agent_id: selectedProject.agent_id,
              name: selectedProject.name,
              display_name: selectedProject.display_name,
              pinned: selectedProject.pinned,
              path: selectedProject.path,
            }
          : null,
        optimisticEntry,
      })
      queryClient.setQueryData<PhaseOneSnapshot | undefined>(
        ['bootstrap'],
        (currentSnapshot) => {
          if (!currentSnapshot) {
            return currentSnapshot
          }

          return {
            ...currentSnapshot,
            generated_at: new Date().toISOString(),
            active_session_id: session.id,
            sessions: [
              session,
              ...currentSnapshot.sessions.filter((item) => item.id !== session.id),
            ],
          }
        },
      )
      queryClient.setQueriesData<WorkspaceDirectorySnapshot | undefined>(
        { queryKey: WORKSPACE_DIRECTORY_QUERY_KEY },
        (currentSnapshot) => upsertWorkspaceSession(currentSnapshot, session),
      )
      queryClient.setQueryData<TimelineEntry[] | undefined>(
        getTimelineOptimisticQueryKey(session.id),
        (currentEntries) => appendTimelineEntry(currentEntries, optimisticEntry),
      )
      await navigate({
        to: '/session/$sessionId',
        params: { sessionId: session.id },
      })
      void queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
      void queryClient.invalidateQueries({ queryKey: ['timeline', session.id] })
      void queryClient.invalidateQueries({ queryKey: ['plan', session.id] })
      void queryClient.invalidateQueries({ queryKey: ['change-sets', session.id] })
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : '创建会话失败')
    },
  })

  useEffect(() => {
    if (!activePicker) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        pickerMenuRef.current &&
        target instanceof Node &&
        pickerMenuRef.current.contains(target)
      ) {
        return
      }

      setActivePicker(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActivePicker(null)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [activePicker])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let hasConnectedOnce = false
    let shouldRefreshOnConnected = false

    void resolveConnectionTarget({
      agentId: currentAgent?.id ?? agentId,
    }).then((target) => {
      if (cancelled) {
        return
      }

      unsubscribe = target.client.connectEvents((event) => {
        const payloadSessionId =
          typeof event.payload?.sessionId === 'string'
            ? event.payload.sessionId
            : null

        if (event.type === 'snapshot.changed' || event.type === 'agent.online') {
          void queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
          return
        }

        if (event.type === 'session.updated' && payloadSessionId) {
          const currentSnapshot = queryClient.getQueryData<PhaseOneSnapshot>(['bootstrap'])
          const sessionPatch =
            event.payload?.sessionPatch &&
            typeof event.payload.sessionPatch === 'object'
              ? event.payload.sessionPatch as Partial<PhaseOneSnapshot['sessions'][number]>
              : null

          if (sessionPatch && hasBootstrapSession(currentSnapshot, payloadSessionId)) {
            queryClient.setQueryData<PhaseOneSnapshot | undefined>(
              ['bootstrap'],
              (snapshot) =>
                patchBootstrapSessionWithSafeLastEventAt(
                  snapshot,
                  payloadSessionId,
                  sessionPatch,
                ),
            )
            return
          }

          void queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
        }
      }, {
        onStatus: (status) => {
          if (status.state === 'connected') {
            if (hasConnectedOnce && shouldRefreshOnConnected) {
              shouldRefreshOnConnected = false
              void queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
            }

            hasConnectedOnce = true
            return
          }

          if (hasConnectedOnce) {
            shouldRefreshOnConnected = true
          }
        },
      })
    })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [agentId, currentAgent?.id, queryClient])

  const selectionLabel = selectedProject
    ? selectedProject.display_name ?? selectedProject.name
    : '选择线程'
  const selectionPath = selectedProject?.path ?? null

  const commitPickerValue = (value: string) => {
    if (activePicker === 'model') {
      setSelectedModel(value)
    }

    if (activePicker === 'reasoning') {
      setSelectedReasoning(value as (typeof REASONING_OPTIONS)[number]['value'])
    }

    setActivePicker(null)
  }

  const submitDraft = () => {
    const input = draft.trim()
    if (!input || createSessionMutation.isPending || !selectedProject) {
      return
    }

    if (isSlashCommandInput(input)) {
      const commandName = parseSlashCommandName(input)
      setDraft('')

      if (commandName === 'model') {
        if (modelOptions.length > 0) {
          setActiveCommandPanel({
            panel_id: `new-thread-command-${Date.now()}`,
            session_id: `new-thread:${selectedProject.id}`,
            command_name: 'model',
            command_text: input,
            title: '为新会话选择模型',
            description: '选择后会更新新会话默认模型。',
            status: 'awaiting_input',
            body: '在下面选择一个模型。',
            submitted_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            input_type: 'choice',
            options: modelOptions.map((option) => ({
              id: option.value,
              label: option.label,
              description: option.description ?? null,
            })),
            input_placeholder: null,
            submit_label: null,
            effect: null,
          })
          return
        }

        setActiveCommandPanel({
          panel_id: `new-thread-command-${Date.now()}`,
          session_id: `new-thread:${selectedProject.id}`,
          command_name: 'model',
          command_text: input,
          title: '为新会话选择模型',
          description: '选择后会更新新会话默认模型。',
          status: 'completed',
          body: '当前没有可选模型，请先去设置页维护模型列表。',
          submitted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          input_type: 'none',
          options: [],
          input_placeholder: null,
          submit_label: null,
          effect: null,
        })
        return
      }

      setActiveCommandPanel({
        panel_id: `new-thread-command-${Date.now()}`,
        session_id: `new-thread:${selectedProject.id}`,
        command_name: commandName || 'unknown',
        command_text: input,
        title: `/${commandName || 'unknown'} 暂不可用`,
        description: '新建线程阶段目前只接入了本地 /model。',
        status: 'completed',
        body: '请先进入已有会话后再执行这个命令。',
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        input_type: 'none',
        options: [],
        input_placeholder: null,
        submit_label: null,
        effect: null,
      })
      return
    }

    createSessionMutation.mutate({
      projectId: selectedProject.id,
      input,
      title: makeSessionTitleFromInput(input),
      model: selectedModel,
      titleGenerationModel: readStoredTitleGenerationModel(),
      reasoningEffort: selectedReasoning,
    })
  }

  const handleDraftKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    ) {
      return
    }

    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 768px)').matches
    ) {
      return
    }

    event.preventDefault()
    submitDraft()
  }

  return (
    <div className="conversation-page new-thread-page">
      <ConversationSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        currentAgent={currentAgent}
        projects={projects}
        sessions={sessions}
        activeSessionId={selectedSessionId}
        onCreateSession={(projectId) => {
          setSelectedProjectId(projectId)
          const fallbackSession =
            sessions.find((session) => session.project_id === projectId && !session.archived) ??
            sessions.find((session) => session.project_id === projectId)
          setSelectedSessionId(fallbackSession?.id)
          setSidebarOpen(false)
        }}
        onSelectSession={(sessionId) => {
          const session = sessions.find((item) => item.id === sessionId)
          if (!session) {
            return
          }

          setSelectedProjectId(session.project_id)
          setSelectedSessionId(session.id)
          setSidebarOpen(false)
        }}
      />

      <div className="conversation-main conversation-main--new-thread">
        <div className="conversation-topbar">
          <div className="conversation-topbar__meta">
            <div className="conversation-topbar__title-row">
              <h1 aria-label="未命名会话">&nbsp;</h1>
            </div>
          </div>

          <button
            type="button"
            className="conversation-menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="打开侧边栏"
          >
            <span />
            <span />
          </button>
        </div>

        <section className="new-thread-hero">
          <div className="new-thread-hero__stack">
            <NewThreadLogo />
            <label className="new-thread-hero__selector">
              <span className="new-thread-hero__selector-label">在线程中发起会话</span>
              <select
                className="new-thread-hero__select"
                value={selectedProjectId ?? ''}
                onChange={(event) => setSelectedProjectId(event.target.value || null)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.display_name ?? project.name}
                  </option>
                ))}
              </select>
            </label>

            {selectionPath ? (
              <div className="new-thread-hero__path">{selectionPath}</div>
            ) : (
              <div className="new-thread-hero__hint">
                选择一个线程后，直接输入第一条消息即可开始。
              </div>
            )}
          </div>
        </section>

        <div className="composer-wrap">
          {errorMessage ? (
            <div className="composer-alert" role="status" aria-live="polite">
              <span className="composer-alert__text">{errorMessage}</span>
            </div>
          ) : null}

          {activeCommandPanel ? (
            <SessionCommandPanel
              panel={activeCommandPanel}
              isPending={false}
              onDismiss={() => setActiveCommandPanel(null)}
              onSelectOption={(optionId) => {
                setSelectedModel(optionId)
                setActiveCommandPanel((current) =>
                  current
                    ? {
                        ...current,
                        status: 'completed',
                        body: `新会话默认模型已切换为 ${getSessionModelLabelFromOptions(optionId, modelOptions)}。现在可以继续输入真正的首条消息。`,
                        updated_at: new Date().toISOString(),
                        input_type: 'none',
                        options: [],
                      }
                    : current,
                )
              }}
              onSubmitText={() => {}}
            />
          ) : null}

          <form
            className="chat-composer new-thread-composer"
            onSubmit={(event) => {
              event.preventDefault()
              submitDraft()
            }}
          >
            <SkillAwareTextarea
              className="chat-composer__input"
              value={draft}
              onChange={setDraft}
              onKeyDown={handleDraftKeyDown}
              projectId={selectedProject?.id ?? null}
              agentId={currentAgent?.id ?? agentId}
              placeholder={
                selectedProject
                  ? `向 ${selectionLabel} 发起第一条任务…`
                  : '先选择线程，再输入第一条任务'
              }
              disabled={!selectedProject}
            />

            <div className="chat-composer__toolbar">
              <div ref={pickerMenuRef} className="chat-composer__controls">
                <div className={`composer-choice ${activePicker === 'model' ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    className="composer-control"
                    onClick={() =>
                      setActivePicker((current) =>
                        current === 'model' ? null : 'model',
                      )
                    }
                    aria-label="选择模型"
                    aria-expanded={activePicker === 'model'}
                  >
                    <span className="composer-icon">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 3 4 7v10l8 4 8-4V7z" />
                        <path d="m4 7 8 4 8-4" />
                        <path d="M12 11v10" />
                      </svg>
                    </span>
                    <span className="composer-control__value">
                      {getSessionModelLabelFromOptions(selectedModel, modelOptions)}
                    </span>
                  </button>

                  {activePicker === 'model' ? (
                    <div className="composer-choice-menu" role="menu" aria-label="选择模型">
                      {modelOptions.map((option) => (
                        <button
                          type="button"
                          key={option.value}
                          className={`composer-choice-menu__item ${
                            selectedModel === option.value ? 'is-active' : ''
                          }`}
                          role="menuitemradio"
                          aria-checked={selectedModel === option.value}
                          onClick={() => commitPickerValue(option.value)}
                        >
                          <span className="composer-choice-menu__text">
                            <span className="composer-choice-menu__label">
                              {option.label}
                            </span>
                          </span>
                          {selectedModel === option.value ? (
                            <span className="composer-choice-menu__check">✓</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div
                  className={`composer-choice ${
                    activePicker === 'reasoning' ? 'is-open' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="composer-control"
                    onClick={() =>
                      setActivePicker((current) =>
                        current === 'reasoning' ? null : 'reasoning',
                      )
                    }
                    aria-label="选择推理强度"
                    aria-expanded={activePicker === 'reasoning'}
                  >
                    <span className="composer-icon">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M9.5 3a6.5 6.5 0 0 0-3.7 11.84c.53.38.92.95 1.1 1.57l.1.34c.13.44.54.75 1 .75h7c.46 0 .87-.31 1-.75l.1-.34c.18-.62.57-1.2 1.1-1.57A6.5 6.5 0 0 0 14.5 3z" />
                        <path d="M10 21h4" />
                        <path d="M9 18h6" />
                      </svg>
                    </span>
                    <span className="composer-control__value">
                      {getSessionReasoningLabel(selectedReasoning)}
                    </span>
                  </button>

                  {activePicker === 'reasoning' ? (
                    <div
                      className="composer-choice-menu"
                      role="menu"
                      aria-label="选择推理强度"
                    >
                      {REASONING_OPTIONS.map((option) => (
                        <button
                          type="button"
                          key={option.value}
                          className={`composer-choice-menu__item ${
                            selectedReasoning === option.value ? 'is-active' : ''
                          }`}
                          role="menuitemradio"
                          aria-checked={selectedReasoning === option.value}
                          onClick={() => commitPickerValue(option.value)}
                        >
                          <span className="composer-choice-menu__label">
                            {option.label}
                          </span>
                          {selectedReasoning === option.value ? (
                            <span className="composer-choice-menu__check">✓</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="chat-composer__actions">
                <div className="new-thread-composer__meta">
                  <span className="new-thread-composer__badge">Panda</span>
                  <span className="new-thread-composer__target">{selectionLabel}</span>
                </div>

                <button
                  type="submit"
                  className="composer-send"
                  disabled={!selectedProject || !draft.trim() || createSessionMutation.isPending}
                  aria-label="发送并创建会话"
                >
                  {createSessionMutation.isPending ? (
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M12 6v6l4 4"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <circle
                        cx="12"
                        cy="12"
                        r="8"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeDasharray="4 4"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M12 17V7m0 0-4 4m4-4 4 4"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>

    </div>
  )
}
