import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  CodexCommandPanel,
  SessionInputAttachment,
  SessionRef,
  TimelineEntry,
  WorkspaceAgentSummary,
  WorkspaceProjectDirectory,
  WorkspaceDirectorySnapshot,
  WorkspaceSessionDirectory,
} from '@panda/protocol'
import { WORKSPACE_DIRECTORY_QUERY_KEY } from '../../lib/bootstrap-query'
import { resolveConnectionTarget } from '../../lib/client'
import { appendTimelineEntry, getTimelineOptimisticQueryKey } from '../../lib/timeline-cache'
import {
  upsertWorkspaceProject,
  upsertWorkspaceSession,
} from '../../lib/workspace-directory-cache'
import {
  getSessionModelLabelFromOptions,
  REASONING_OPTIONS,
  readStoredSessionModel,
  readStoredSessionReasoning,
  readStoredTitleGenerationModel,
  writeStoredSessionModel,
  writeStoredSessionReasoning,
  writeStoredSessionModes,
} from '../../lib/session-composer-preferences'
import { createSessionInputAttachment, toTimelineAttachments } from '../../lib/session-attachments'
import { isSlashCommandInput } from '../../lib/skill-mentions'
import {
  writePendingSessionHandoff,
  queuePendingProjectId,
  queuePendingSessionId,
  writeStoredAgentId,
  writeStoredSessionId,
} from '../../lib/session-selection'
import { useSessionModelOptions } from '../../lib/use-session-model-options'
import { DirectoryThreadPicker } from './directory-thread-picker'
import { NewThreadLogo } from './new-thread-logo'
import { SessionComposer } from './session-composer'

const SESSION_TITLE_MAX_LENGTH = 10

const makeSessionTitleFromInput = (input: string) => {
  const normalized = input.replace(/\s+/g, ' ').trim()
  if (normalized.length <= SESSION_TITLE_MAX_LENGTH) {
    return normalized
  }

  return normalized.slice(0, SESSION_TITLE_MAX_LENGTH).trimEnd()
}

const makeSessionTitle = (
  input: string,
  attachments: SessionInputAttachment[],
) => {
  const fromInput = makeSessionTitleFromInput(input)
  if (fromInput) {
    return fromInput
  }

  return attachments[0]?.name?.trim() || '附件'
}

const parseSlashCommandName = (value: string) => {
  const match = /^\/([A-Za-z][A-Za-z0-9._-]*)/.exec(value.trim())
  return match?.[1]?.toLowerCase() ?? ''
}

type NewThreadPaneProps = {
  currentAgent: WorkspaceAgentSummary
  projects: WorkspaceProjectDirectory[]
  sessions: WorkspaceSessionDirectory[]
  initialProjectId?: string | null
  entryView: 'composer' | 'directory-picker'
  isDesktopSidebar: boolean
  sidebarOffset: number
  isSidebarDragging: boolean
  onOpenSidebar: () => void
  onProjectSelected: (projectId: string) => void
  onSessionCreated: (sessionId: string) => void
}

export const NewThreadPane = ({
  currentAgent,
  projects,
  sessions,
  initialProjectId = null,
  entryView,
  isDesktopSidebar,
  sidebarOffset,
  isSidebarDragging,
  onOpenSidebar,
  onProjectSelected,
  onSessionCreated,
}: NewThreadPaneProps) => {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProjectId)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [activeCommandPanel, setActiveCommandPanel] = useState<CodexCommandPanel | null>(
    null,
  )
  const [selectedModel, setSelectedModel] = useState(() => readStoredSessionModel())
  const [selectedReasoning, setSelectedReasoning] = useState(() => readStoredSessionReasoning())
  const [pendingAttachments, setPendingAttachments] = useState<SessionInputAttachment[]>([])
  const [isFastModeEnabled, setIsFastModeEnabled] = useState(false)
  const [isPlanModeEnabled, setIsPlanModeEnabled] = useState(false)
  const [isYoloModeEnabled, setIsYoloModeEnabled] = useState(false)
  const [paneView, setPaneView] = useState<'composer' | 'directory-picker'>(entryView)
  const managedModelOptions = useSessionModelOptions()
  const modelOptions = useMemo(
    () => managedModelOptions.map(({ id: _id, ...option }) => option),
    [managedModelOptions],
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
    setPaneView(entryView)
  }, [entryView])

  useEffect(() => {
    setActiveCommandPanel(null)
  }, [selectedProjectId])

  useEffect(() => {
    if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) {
      return
    }

    const preferredProjectId =
      (initialProjectId && projects.some((project) => project.id === initialProjectId)
        ? initialProjectId
        : null) ??
      sessions.find((session) => !session.archived)?.project_id ??
      projects[0]?.id ??
      null
    setSelectedProjectId(preferredProjectId)
  }, [initialProjectId, projects, selectedProjectId, sessions])

  const createSessionMutation = useMutation({
    mutationFn: async (payload: {
      projectId: string
      input: string
      title: string
      attachments: SessionInputAttachment[]
      model: string
      titleGenerationModel: string
      reasoningEffort: string
      serviceTier?: 'fast'
      planMode: boolean
      yoloMode: boolean
    }) => {
      if (!selectedProject || (!payload.input.trim() && payload.attachments.length === 0)) {
        throw new Error('请先选择线程，再输入第一条消息')
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
        attachments: payload.attachments,
        model: payload.model,
        titleGenerationModel: payload.titleGenerationModel,
        reasoningEffort: payload.reasoningEffort,
        serviceTier: payload.serviceTier,
        planMode: payload.planMode,
        yoloMode: payload.yoloMode,
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
        attachments: toTimelineAttachments(variables.attachments),
      }

      writeStoredAgentId(currentAgent.id)
      writeStoredSessionId(session.id)
      writeStoredSessionModes(session.id, {
        isFastModeEnabled: variables.serviceTier === 'fast',
        isPlanModeEnabled: variables.planMode,
        isYoloModeEnabled: variables.yoloMode,
      })
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
      queryClient.setQueriesData<WorkspaceDirectorySnapshot | undefined>(
        { queryKey: WORKSPACE_DIRECTORY_QUERY_KEY },
        (currentSnapshot) => upsertWorkspaceSession(currentSnapshot, session),
      )
      queryClient.setQueryData<TimelineEntry[] | undefined>(
        getTimelineOptimisticQueryKey(session.id),
        (currentEntries) => appendTimelineEntry(currentEntries, optimisticEntry),
      )
      setIsFastModeEnabled(false)
      setIsPlanModeEnabled(false)
      setIsYoloModeEnabled(false)
      onSessionCreated(session.id)
      void queryClient.invalidateQueries({ queryKey: ['plan', session.id] })
      void queryClient.invalidateQueries({ queryKey: ['change-sets', session.id] })
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : '创建会话失败')
    },
  })

  const selectionPath = selectedProject?.path ?? null
  const showDirectoryPicker = paneView === 'directory-picker'
  const mainStyle: CSSProperties = {
    transform: `translateX(${sidebarOffset}px)`,
    transition: isSidebarDragging ? 'none' : undefined,
  }

  const submitDraft = () => {
    const input = draft.trim()
    if ((!input && pendingAttachments.length === 0) || createSessionMutation.isPending || !selectedProject) {
      return
    }

    if (isSlashCommandInput(input)) {
      if (pendingAttachments.length > 0) {
        setErrorMessage('命令暂不支持附件，请先移除附件后再执行。')
        return
      }

      const commandName = parseSlashCommandName(input)
      if (commandName === 'model') {
        setDraft('')
        if (modelOptions.length > 0) {
          setActiveCommandPanel({
            panel_id: `new-thread-command-${Date.now()}`,
            session_id: `new-thread:${selectedProject.id}`,
            command_name: commandName,
            command_text: input,
            title: '为新会话选择模型',
            description: '选择后会更新新会话的默认模型，再继续输入真正的首条消息。',
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
          command_name: commandName,
          command_text: input,
          title: '为新会话选择模型',
          description: '选择后会更新新会话的默认模型，再继续输入真正的首条消息。',
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

      if (commandName === 'status') {
        setDraft('')
        setActiveCommandPanel({
          panel_id: `new-thread-command-${Date.now()}`,
          session_id: `new-thread:${selectedProject.id}`,
          command_name: commandName,
          command_text: input,
          title: '新会话当前设置',
          description: '这里展示的是创建下一条会话时会使用的本地设置。',
          status: 'completed',
          body: [
            `线程：${selectedProject.display_name ?? selectedProject.name}`,
            `模型：${selectedModel}`,
            `推理强度：${selectedReasoning}`,
            `Fast 模式：${isFastModeEnabled ? '开启' : '关闭'}`,
            `计划模式：${isPlanModeEnabled ? '开启' : '关闭'}`,
            `Yolo 模式：${isYoloModeEnabled ? '开启' : '关闭'}`,
          ].join('\n'),
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

      setDraft('')
      setActiveCommandPanel({
        panel_id: `new-thread-command-${Date.now()}`,
        session_id: `new-thread:${selectedProject.id}`,
        command_name: commandName || 'unknown',
        command_text: input,
        title: `/${commandName || 'unknown'} 暂不可用`,
        description: '新建线程阶段目前只接入了少量本地命令。',
        status: 'completed',
        body: '请先进入已有会话后再执行这个命令，或者先使用 /model 调整新会话默认模型。',
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
      title: makeSessionTitle(input, pendingAttachments),
      attachments: pendingAttachments,
      model: selectedModel,
      titleGenerationModel: readStoredTitleGenerationModel(),
      reasoningEffort: selectedReasoning,
      serviceTier: isFastModeEnabled ? 'fast' : undefined,
      planMode: isPlanModeEnabled,
      yoloMode: isYoloModeEnabled,
    })
  }

  return (
    <>
      <div
        className={`conversation-main conversation-main--new-thread ${
          isDesktopSidebar ? 'has-desktop-sidebar' : ''
        }`}
        style={mainStyle}
      >
        <div className="conversation-topbar">
          {!isDesktopSidebar ? (
            <button
              type="button"
              className="conversation-menu"
              onClick={onOpenSidebar}
              aria-label="打开侧边栏"
            >
              <span />
              <span className="short" />
            </button>
          ) : null}

          <div className="conversation-topbar__meta">
            <div className="conversation-topbar__title-row">
              <h1 aria-label="未命名会话">&nbsp;</h1>
            </div>
          </div>
        </div>

        <div className="conversation-scroll conversation-scroll--empty">
          <div className="conversation-thread conversation-thread--empty">
            {showDirectoryPicker ? (
              <DirectoryThreadPicker
                agentId={currentAgent.id}
                projects={projects}
                title="选择目录"
                subtitle=""
                onProjectCreated={(project) => {
                  queryClient.setQueriesData<WorkspaceDirectorySnapshot | undefined>(
                    { queryKey: WORKSPACE_DIRECTORY_QUERY_KEY },
                    (currentSnapshot) => upsertWorkspaceProject(currentSnapshot, project),
                  )
                  setSelectedProjectId(project.id)
                  onProjectSelected(project.id)
                  setPaneView('composer')
                }}
              />
            ) : (
              <section className="new-thread-hero">
                <div className="new-thread-hero__stack">
                  <NewThreadLogo />
                  <label className="new-thread-hero__selector">
                    <span className="new-thread-hero__selector-label">在线程中发起会话</span>
                    <select
                      className="new-thread-hero__select"
                      value={selectedProjectId ?? ''}
                      onChange={(event) => {
                        const nextProjectId = event.target.value || null
                        setSelectedProjectId(nextProjectId)
                        if (nextProjectId) {
                          onProjectSelected(nextProjectId)
                        }
                      }}
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

                  {!isDesktopSidebar ? (
                    <button
                      type="button"
                      className="new-thread-hero__directory-trigger"
                      onClick={() => setPaneView('directory-picker')}
                    >
                      新增目录线程
                    </button>
                  ) : null}
                </div>
              </section>
            )}
          </div>
        </div>

      </div>

      {showDirectoryPicker ? null : (
        <SessionComposer
          isDesktopSidebar={isDesktopSidebar}
          sidebarShift={sidebarOffset}
          isSidebarDragging={isSidebarDragging}
          composerError={errorMessage}
          onDismissComposerError={() => setErrorMessage(null)}
          interactionRequests={[]}
          pendingInteractionRequestId={null}
          onRespondInteraction={() => {}}
          parentSession={null}
          backgroundAgentSessions={[]}
          isBackgroundAgentsOpen={false}
          planSnapshot={null}
          onToggleBackgroundAgents={() => {}}
          onOpenSession={() => {}}
          getBackgroundAgentStatusLabel={() => ''}
          getBackgroundAgentAccent={() => 'var(--color-accent-primary)'}
          formatBackgroundAgentsLabel={(count) => `${count} background agents`}
          hasBackgroundAgentStrip={false}
          commandPanel={activeCommandPanel}
          isCommandPanelPending={false}
          onDismissCommandPanel={() => setActiveCommandPanel(null)}
          onCommandPanelOptionSelect={(optionId) => {
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
          onCommandPanelTextSubmit={() => {}}
          projectId={selectedProject?.id ?? null}
          agentId={currentAgent.id}
          draft={draft}
          pendingAttachments={pendingAttachments}
          canSendInput={Boolean(selectedProject)}
          inputPlaceholder={
            selectedProject
              ? `向 ${selectedProject.display_name ?? selectedProject.name} 发起第一条任务…`
              : '先选择线程，再输入第一条任务'
          }
          readOnlyPlaceholder="先选择线程，再输入第一条任务"
          onDraftChange={setDraft}
          onUploadFiles={(files) => {
            const fileList = [...files]
            if (fileList.length === 0) {
              return
            }

            setErrorMessage(null)
            void Promise.all(fileList.map((file) => createSessionInputAttachment(file)))
              .then((attachments) => {
                setPendingAttachments((current) => [...current, ...attachments])
              })
              .catch((error) => {
                setErrorMessage(error instanceof Error ? error.message : '无法读取附件')
              })
          }}
          onRemoveAttachment={(attachmentId) => {
            setPendingAttachments((current) =>
              current.filter((attachment) => attachment.id !== attachmentId),
            )
          }}
          onSubmit={submitDraft}
          showStopIcon={false}
          isSendPending={createSessionMutation.isPending}
          onInterrupt={() => {}}
          isFastModeEnabled={isFastModeEnabled}
          isPlanModeEnabled={isPlanModeEnabled}
          isYoloModeEnabled={isYoloModeEnabled}
          onToggleFastMode={() => setIsFastModeEnabled((current) => !current)}
          onTogglePlanMode={() => setIsPlanModeEnabled((current) => !current)}
          onToggleYoloMode={() => setIsYoloModeEnabled((current) => !current)}
          showModeBadges
          selectedModel={selectedModel}
          modelOptions={modelOptions}
          selectedReasoning={selectedReasoning}
          onSelectModel={setSelectedModel}
          onSelectReasoning={(value) =>
            setSelectedReasoning(
              value as (typeof REASONING_OPTIONS)[number]['value'],
            )
          }
          contextUsage={null}
          isContextUsageOpen={false}
          onToggleContextUsage={() => {}}
          usedPercent={0}
          remainingPercent={0}
          usedTokensLabel="0"
          totalTokensLabel="0"
          showJumpToBottom={false}
          onJumpToBottom={() => {}}
        />
      )}
    </>
  )
}
