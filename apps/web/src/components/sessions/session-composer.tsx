import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type {
  CodexCommandPanel,
  SessionContextUsage,
  SessionInteractionRequest,
  SessionInputAttachment,
  SessionPlanSnapshot,
  WorkspaceSessionDirectory,
} from '@panda/protocol'
import { SessionInteractionStrip } from './session-interaction-strip'
import { SessionCommandPanel } from './session-command-panel'
import { SessionPlanStrip } from './session-plan-strip'
import { SkillAwareTextarea } from '../shared/skill-aware-textarea'
import { formatAttachmentSize } from '../../lib/session-attachments'
import {
  getSessionModelLabelFromOptions,
  getSessionReasoningLabel,
  REASONING_OPTIONS,
  type SessionComposerModelOption,
} from '../../lib/session-composer-preferences'

const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </svg>
)

const IconArrowDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14" />
    <path d="m7 14 5 5 5-5" />
  </svg>
)

const IconExpand = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 3H4v4" />
    <path d="M16 3h4v4" />
    <path d="M8 21H4v-4" />
    <path d="M16 21h4v-4" />
    <path d="M9 9 4 4" />
    <path d="m15 9 5-5" />
    <path d="m9 15-5 5" />
    <path d="m15 15 5 5" />
  </svg>
)

const IconPlus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
)

const IconFast = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 2 5.5 13h5L9 22l9.5-13h-5L13 2Z" />
  </svg>
)

const IconPlan = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6h10" />
    <path d="M9 12h10" />
    <path d="M9 18h10" />
    <path d="m4 6 1.5 1.5L7.5 5" />
    <path d="m4 12 1.5 1.5L7.5 11" />
    <path d="m4 18 1.5 1.5L7.5 17" />
  </svg>
)

const IconYolo = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 10V7.8A5 5 0 0 1 12 3a5 5 0 0 1 5 4.8V10" />
    <path d="M5.5 10h13a1.5 1.5 0 0 1 1.5 1.5v7A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5v-7A1.5 1.5 0 0 1 5.5 10Z" />
    <path d="M12 14v2.6" />
  </svg>
)

const IconUpload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 16V5" />
    <path d="m8 9 4-4 4 4" />
    <path d="M20 16.5v1A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-1" />
  </svg>
)

type SessionComposerProps = {
  isDesktopSidebar: boolean
  sidebarShift: number
  isSidebarDragging: boolean
  composerError: string | null
  onDismissComposerError: () => void
  interactionRequests: SessionInteractionRequest[]
  pendingInteractionRequestId: string | null
  onRespondInteraction: (input: {
    requestId: string
    optionId?: string | null
    text?: string | null
    answers?: Record<string, string>
  }) => void
  parentSession: WorkspaceSessionDirectory | null
  backgroundAgentSessions: WorkspaceSessionDirectory[]
  isBackgroundAgentsOpen: boolean
  planSnapshot: SessionPlanSnapshot | null
  onToggleBackgroundAgents: () => void
  onOpenSession: (sessionId: string) => void
  getBackgroundAgentStatusLabel: (session: WorkspaceSessionDirectory) => string
  getBackgroundAgentAccent: (session: WorkspaceSessionDirectory) => string
  formatBackgroundAgentsLabel: (count: number) => string
  hasBackgroundAgentStrip: boolean
  commandPanel: CodexCommandPanel | null
  isCommandPanelPending: boolean
  onDismissCommandPanel: () => void
  onCommandPanelOptionSelect: (optionId: string) => void
  onCommandPanelTextSubmit: (value: string) => void
  projectId?: string | null
  agentId?: string | null
  draft: string
  pendingAttachments: SessionInputAttachment[]
  canSendInput: boolean
  canSubmitInput?: boolean
  isInputLocked?: boolean
  inputPlaceholder?: string
  readOnlyPlaceholder?: string
  onDraftChange: (value: string) => void
  onUploadFiles: (files: FileList) => void
  onRemoveAttachment: (attachmentId: string) => void
  onSubmit: () => void
  showStopIcon: boolean
  isSendPending: boolean
  onInterrupt: () => void
  isFastModeEnabled: boolean
  isPlanModeEnabled: boolean
  isYoloModeEnabled: boolean
  onToggleFastMode: () => void
  onTogglePlanMode: () => void
  onToggleYoloMode: () => void
  showModeBadges?: boolean
  selectedModel: string
  modelOptions?: readonly SessionComposerModelOption[]
  selectedReasoning: string
  onSelectModel: (value: string) => void
  onSelectReasoning: (value: string) => void
  contextUsage: SessionContextUsage | null
  isContextUsageOpen: boolean
  onToggleContextUsage: () => void
  contextUsageRingStyle?: CSSProperties
  usedPercent: number
  remainingPercent: number
  usedTokensLabel: string
  totalTokensLabel: string
  showJumpToBottom: boolean
  onJumpToBottom: () => void
}

export const SessionComposer = memo(function SessionComposer({
  isDesktopSidebar,
  sidebarShift,
  isSidebarDragging,
  composerError,
  onDismissComposerError,
  interactionRequests,
  pendingInteractionRequestId,
  onRespondInteraction,
  parentSession,
  backgroundAgentSessions,
  isBackgroundAgentsOpen,
  planSnapshot,
  onToggleBackgroundAgents,
  onOpenSession,
  getBackgroundAgentStatusLabel,
  getBackgroundAgentAccent,
  formatBackgroundAgentsLabel,
  hasBackgroundAgentStrip,
  commandPanel,
  isCommandPanelPending,
  onDismissCommandPanel,
  onCommandPanelOptionSelect,
  onCommandPanelTextSubmit,
  projectId = null,
  agentId = null,
  draft,
  pendingAttachments,
  canSendInput,
  canSubmitInput = true,
  isInputLocked = false,
  inputPlaceholder,
  readOnlyPlaceholder,
  onDraftChange,
  onUploadFiles,
  onRemoveAttachment,
  onSubmit,
  showStopIcon,
  isSendPending,
  onInterrupt,
  isFastModeEnabled,
  isPlanModeEnabled,
  isYoloModeEnabled,
  onToggleFastMode,
  onTogglePlanMode,
  onToggleYoloMode,
  showModeBadges = false,
  selectedModel,
  modelOptions = [],
  selectedReasoning,
  onSelectModel,
  onSelectReasoning,
  contextUsage,
  isContextUsageOpen,
  onToggleContextUsage,
  contextUsageRingStyle,
  usedPercent,
  remainingPercent,
  usedTokensLabel,
  totalTokensLabel,
  showJumpToBottom,
  onJumpToBottom,
}: SessionComposerProps) {
  const fileInputId = useId()
  const [isFullscreenEditorOpen, setIsFullscreenEditorOpen] = useState(false)
  const [activePopover, setActivePopover] = useState<
    'utility' | 'model' | 'reasoning' | null
  >(null)
  const controlsPopoverRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const currentInteractionRequest = interactionRequests[0] ?? null
  const isInteractiveQuestionnaire = currentInteractionRequest?.kind === 'user_input'
  const hasInteractionStrip = interactionRequests.length > 0
  const hasPlanStrip = Boolean(planSnapshot) && !isInteractiveQuestionnaire
  const shouldShowBackgroundAgentStrip =
    !isInteractiveQuestionnaire && hasBackgroundAgentStrip
  const interactionHasStripBelow = hasPlanStrip || shouldShowBackgroundAgentStrip
  const hasAttachedTopStrip =
    hasInteractionStrip || hasPlanStrip || shouldShowBackgroundAgentStrip
  const wrapStyle: CSSProperties = {
    transform: `translateX(${sidebarShift}px)`,
    transition: isSidebarDragging ? 'none' : undefined,
  }
  const canSubmit =
    (Boolean(draft.trim()) || pendingAttachments.length > 0) &&
    canSendInput &&
    canSubmitInput &&
    !isInputLocked &&
    !isSendPending &&
    !showStopIcon

  const canEditInput = canSendInput && !isInputLocked
  const hasVisibleModeBadges =
    showModeBadges &&
    (isFastModeEnabled || isPlanModeEnabled || isYoloModeEnabled)

  const submitDraft = () => {
    if (!canSubmit) {
      return
    }

    setActivePopover(null)
    onSubmit()
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

  useEffect(() => {
    if (!isFullscreenEditorOpen) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isFullscreenEditorOpen])

  useEffect(() => {
    if (!isFullscreenEditorOpen || typeof window === 'undefined') {
      return
    }

    const mediaQuery = window.matchMedia('(min-width: 769px)')
    const handleChange = () => {
      if (mediaQuery.matches) {
        setIsFullscreenEditorOpen(false)
      }
    }

    handleChange()
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
      return () => {
        mediaQuery.removeEventListener('change', handleChange)
      }
    }

    mediaQuery.addListener(handleChange)
    return () => {
      mediaQuery.removeListener(handleChange)
    }
  }, [isFullscreenEditorOpen])

  useEffect(() => {
    if (!activePopover) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (
        controlsPopoverRef.current &&
        target instanceof Node &&
        controlsPopoverRef.current.contains(target)
      ) {
        return
      }

      setActivePopover(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActivePopover(null)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [activePopover])

  const renderModeBadges = (className: string) => {
    if (!hasVisibleModeBadges) {
      return null
    }

    return (
      <div className={className} aria-label="当前已启用的会话模式">
        {isFastModeEnabled ? (
          <button
            type="button"
            className="composer-mode-badge is-fast"
            onClick={() => {
              setActivePopover(null)
              onToggleFastMode()
            }}
            aria-label="关闭 Fast 模式"
          >
            <span className="composer-mode-badge__icon" aria-hidden="true">
              <IconFast />
            </span>
            <span className="composer-mode-badge__label">Fast</span>
          </button>
        ) : null}

        {isPlanModeEnabled ? (
          <button
            type="button"
            className="composer-mode-badge is-plan"
            onClick={() => {
              setActivePopover(null)
              onTogglePlanMode()
            }}
            aria-label="关闭计划模式"
          >
            <span className="composer-mode-badge__icon" aria-hidden="true">
              <IconPlan />
            </span>
            <span className="composer-mode-badge__label">计划</span>
          </button>
        ) : null}

        {isYoloModeEnabled ? (
          <button
            type="button"
            className="composer-mode-badge is-yolo"
            onClick={() => {
              setActivePopover(null)
              onToggleYoloMode()
            }}
            aria-label="关闭 Yolo 模式"
          >
            <span className="composer-mode-badge__icon" aria-hidden="true">
              <IconYolo />
            </span>
            <span className="composer-mode-badge__label">Yolo</span>
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <>
      <div
        className={`composer-wrap ${isDesktopSidebar ? 'has-desktop-sidebar' : ''}`}
        style={wrapStyle}
      >
        {composerError ? (
          <div className="composer-alert" role="status" aria-live="polite">
            <span className="composer-alert__text">{composerError}</span>
            <button
              type="button"
              className="composer-alert__close"
              onClick={onDismissComposerError}
              aria-label="关闭错误提示"
            >
              <IconClose />
            </button>
          </div>
        ) : null}

        {hasInteractionStrip ? (
          <SessionInteractionStrip
            requests={interactionRequests}
            hasStripBelow={interactionHasStripBelow}
            pendingRequestId={pendingInteractionRequestId}
            onRespond={onRespondInteraction}
          />
        ) : null}

        {hasPlanStrip && planSnapshot ? (
          <SessionPlanStrip
            planSnapshot={planSnapshot}
            hasStripAbove={hasInteractionStrip}
            hasStripBelow={shouldShowBackgroundAgentStrip}
          />
        ) : null}

        {shouldShowBackgroundAgentStrip && parentSession ? (
          <button
            type="button"
            className={`background-agents-exit ${
              hasInteractionStrip || hasPlanStrip ? 'has-strip-above' : ''
            }`}
            onClick={() => {
              onOpenSession(parentSession.id)
            }}
          >
            <span className="background-agents-exit__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 12h12" />
                <path d="m13 7 5 5-5 5" />
              </svg>
            </span>
            <span>返回主会话</span>
            </button>
        ) : shouldShowBackgroundAgentStrip && backgroundAgentSessions.length > 0 ? (
          <section className={`background-agents-card ${isBackgroundAgentsOpen ? 'is-open' : ''} ${
            hasInteractionStrip || hasPlanStrip ? 'has-strip-above' : ''
          }`}>
            <button
              type="button"
              className="background-agents-card__toggle"
              onClick={onToggleBackgroundAgents}
              aria-expanded={isBackgroundAgentsOpen}
            >
              <span className="background-agents-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="7" y="4" width="10" height="7" rx="2.5" />
                  <path d="M12 11v3" />
                  <circle cx="10" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
                  <circle cx="14" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
                  <path d="M4.5 18a4.5 4.5 0 0 1 4.5-4.5h6A4.5 4.5 0 0 1 19.5 18" />
                </svg>
              </span>
              <span className="background-agents-card__summary">
                <span className="background-agents-card__title">
                  {formatBackgroundAgentsLabel(backgroundAgentSessions.length)}
                </span>
                {isBackgroundAgentsOpen ? (
                  <span className="background-agents-card__hint">(@ to tag agents)</span>
                ) : null}
              </span>
              <span className="background-agents-card__chevron" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m8 10 4 4 4-4" />
                </svg>
              </span>
            </button>

            {isBackgroundAgentsOpen ? (
              <div className="background-agents-card__list">
                {backgroundAgentSessions.map((backgroundAgent) => (
                  <button
                    type="button"
                    key={backgroundAgent.id}
                    className={`background-agent-row ${
                      backgroundAgent.run_state === 'running' ? 'is-running' : 'is-idle'
                    }`}
                    style={
                      {
                        '--agent-accent': getBackgroundAgentAccent(backgroundAgent),
                      } as CSSProperties
                    }
                    onClick={() => {
                      onOpenSession(backgroundAgent.id)
                    }}
                  >
                    <span className="background-agent-row__accent" aria-hidden="true" />
                    <span className="background-agent-row__meta">
                      <span className="background-agent-row__title">
                        <span className="background-agent-row__name">
                          {backgroundAgent.subagent?.nickname ?? backgroundAgent.title}
                        </span>
                        <span className="background-agent-row__role">
                          ({backgroundAgent.subagent?.role ?? 'agent'})
                        </span>
                      </span>
                      <span className="background-agent-row__status">
                        {getBackgroundAgentStatusLabel(backgroundAgent)}
                      </span>
                    </span>
                    <span className="background-agent-row__open">Open</span>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {commandPanel ? (
          <SessionCommandPanel
            panel={commandPanel}
            isPending={isCommandPanelPending}
            onDismiss={onDismissCommandPanel}
            onSelectOption={onCommandPanelOptionSelect}
            onSubmitText={onCommandPanelTextSubmit}
          />
        ) : null}

        {!isInteractiveQuestionnaire ? (
          <form
            className={`chat-composer ${hasAttachedTopStrip ? 'is-attached-to-agent-strip' : ''}`}
            onSubmit={(event) => {
              event.preventDefault()
              submitDraft()
            }}
          >
          <div className="chat-composer__editor">
            {pendingAttachments.length > 0 ? (
              <div className="chat-composer__attachments">
                {pendingAttachments.map((attachment) => {
                  const sizeLabel = formatAttachmentSize(attachment.size_bytes)
                  return (
                    <div key={attachment.id} className="chat-composer__attachment-chip">
                      <div className="chat-composer__attachment-copy">
                        <span className="chat-composer__attachment-name">{attachment.name}</span>
                        <span className="chat-composer__attachment-meta">
                          {attachment.kind === 'image' ? '图片' : '文件'}
                          {sizeLabel ? ` · ${sizeLabel}` : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="chat-composer__attachment-remove"
                        aria-label={`移除 ${attachment.name}`}
                        onClick={() => onRemoveAttachment(attachment.id)}
                      >
                        <IconClose />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : null}

            <SkillAwareTextarea
              className="chat-composer__input"
              value={draft}
              disabled={!canEditInput}
              projectId={projectId}
              agentId={agentId}
              placeholder={
                canEditInput
                  ? (inputPlaceholder ?? '要求后续变更')
                  : (readOnlyPlaceholder ?? '当前会话为只读模式')
              }
              onChange={onDraftChange}
              onKeyDown={handleDraftKeyDown}
            />
            <button
              type="button"
              className="composer-fullscreen-toggle"
              aria-label="全屏编辑"
              onClick={() => setIsFullscreenEditorOpen(true)}
            >
              <IconExpand />
            </button>
            <input
              id={fileInputId}
              ref={fileInputRef}
              type="file"
              className="chat-composer__file-input"
              multiple
              onChange={(event) => {
                if (event.target.files && event.target.files.length > 0) {
                  onUploadFiles(event.target.files)
                }
                event.target.value = ''
              }}
            />
          </div>

          {renderModeBadges('composer-mode-badges composer-mode-badges--mobile')}

          <div className="chat-composer__toolbar">
            <div ref={controlsPopoverRef} className="chat-composer__controls">
              <div
                className={`composer-utility-menu ${activePopover === 'utility' ? 'is-open' : ''}`}
              >
                <button
                  type="button"
                  className="composer-utility-menu__trigger"
                  aria-label="打开额外功能"
                  aria-expanded={activePopover === 'utility'}
                  onClick={() =>
                    setActivePopover((current) =>
                      current === 'utility' ? null : 'utility',
                    )
                  }
                >
                  <IconPlus />
                </button>

                {activePopover === 'utility' ? (
                  <div className="composer-utility-menu__popover" role="menu">
                    <button
                      type="button"
                      className="composer-utility-menu__item"
                      role="menuitem"
                      onClick={() => {
                        setActivePopover(null)
                        fileInputRef.current?.click()
                      }}
                    >
                      <span className="composer-utility-menu__item-icon" aria-hidden="true">
                        <IconUpload />
                      </span>
                      <span className="composer-utility-menu__item-label">上传文件</span>
                    </button>

                    <button
                      type="button"
                      className="composer-utility-menu__item"
                      role="menuitemcheckbox"
                      aria-checked={isFastModeEnabled}
                      onClick={onToggleFastMode}
                    >
                      <span className="composer-utility-menu__item-icon" aria-hidden="true">
                        <IconFast />
                      </span>
                      <span className="composer-utility-menu__item-label">Fast 模式</span>
                      <span className={`composer-utility-menu__switch ${isFastModeEnabled ? 'is-on' : ''}`} aria-hidden="true">
                        <span className="composer-utility-menu__switch-thumb" />
                      </span>
                    </button>

                    <button
                      type="button"
                      className="composer-utility-menu__item"
                      role="menuitemcheckbox"
                      aria-checked={isPlanModeEnabled}
                      onClick={onTogglePlanMode}
                    >
                      <span className="composer-utility-menu__item-icon" aria-hidden="true">
                        <IconPlan />
                      </span>
                      <span className="composer-utility-menu__item-label">计划模式</span>
                      <span className={`composer-utility-menu__switch ${isPlanModeEnabled ? 'is-on' : ''}`} aria-hidden="true">
                        <span className="composer-utility-menu__switch-thumb" />
                      </span>
                    </button>

                    <button
                      type="button"
                      className="composer-utility-menu__item"
                      role="menuitemcheckbox"
                      aria-checked={isYoloModeEnabled}
                      onClick={onToggleYoloMode}
                    >
                      <span className="composer-utility-menu__item-icon" aria-hidden="true">
                        <IconYolo />
                      </span>
                      <span className="composer-utility-menu__item-label">Yolo 模式</span>
                      <span className={`composer-utility-menu__switch ${isYoloModeEnabled ? 'is-on' : ''}`} aria-hidden="true">
                        <span className="composer-utility-menu__switch-thumb" />
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>

              <div className={`composer-choice ${activePopover === 'model' ? 'is-open' : ''}`}>
                <button
                  type="button"
                  className="composer-control"
                  aria-label="选择模型"
                  aria-expanded={activePopover === 'model'}
                  onClick={() =>
                    setActivePopover((current) =>
                      current === 'model' ? null : 'model',
                    )
                  }
                >
                  <span className="composer-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3 4 7v10l8 4 8-4V7z" />
                      <path d="m4 7 8 4 8-4" />
                      <path d="M12 11v10" />
                    </svg>
                  </span>
                  <span className="composer-control__value">
                    {getSessionModelLabelFromOptions(selectedModel, modelOptions)}
                  </span>
                </button>

                {activePopover === 'model' ? (
                  <div className="composer-choice-menu" role="menu" aria-label="选择模型">
                    {modelOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`composer-choice-menu__item ${
                          selectedModel === option.value ? 'is-active' : ''
                        }`}
                        role="menuitemradio"
                        aria-checked={selectedModel === option.value}
                        onClick={() => {
                          onSelectModel(option.value)
                          setActivePopover(null)
                        }}
                      >
                        <span className="composer-choice-menu__text">
                          <span className="composer-choice-menu__label">{option.label}</span>
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
                  activePopover === 'reasoning' ? 'is-open' : ''
                }`}
              >
                <button
                  type="button"
                  className="composer-control"
                  aria-label="选择推理强度"
                  aria-expanded={activePopover === 'reasoning'}
                  onClick={() =>
                    setActivePopover((current) =>
                      current === 'reasoning' ? null : 'reasoning',
                    )
                  }
                >
                  <span className="composer-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9.5 3a6.5 6.5 0 0 0-3.7 11.84c.53.38.92.95 1.1 1.57l.1.34c.13.44.54.75 1 .75h7c.46 0 .87-.31 1-.75l.1-.34c.18-.62.57-1.2 1.1-1.57A6.5 6.5 0 0 0 14.5 3z" />
                      <path d="M10 21h4" />
                      <path d="M9 18h6" />
                    </svg>
                  </span>
                  <span className="composer-control__value">
                    {getSessionReasoningLabel(selectedReasoning)}
                  </span>
                </button>

                {activePopover === 'reasoning' ? (
                  <div className="composer-choice-menu" role="menu" aria-label="选择推理强度">
                    {REASONING_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`composer-choice-menu__item ${
                          selectedReasoning === option.value ? 'is-active' : ''
                        }`}
                        role="menuitemradio"
                        aria-checked={selectedReasoning === option.value}
                        onClick={() => {
                          onSelectReasoning(option.value)
                          setActivePopover(null)
                        }}
                      >
                        <span className="composer-choice-menu__label">{option.label}</span>
                        {selectedReasoning === option.value ? (
                          <span className="composer-choice-menu__check">✓</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {renderModeBadges('composer-mode-badges composer-mode-badges--inline')}
            </div>

            <div className="chat-composer__actions">
              {contextUsage ? (
                <div className={`composer-context ${isContextUsageOpen ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    className="composer-context__trigger"
                    aria-label="查看背景信息窗口使用情况"
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleContextUsage()
                    }}
                  >
                    <span className="composer-context__ring" style={contextUsageRingStyle}>
                      <span className="composer-context__ring-core" />
                    </span>
                  </button>

                  {isContextUsageOpen ? (
                    <div className="composer-context__popover" role="tooltip">
                      <div className="composer-context__title">背景信息窗口：</div>
                      <div>{usedPercent}% 已用（剩余 {remainingPercent}%）</div>
                      <div>
                        已用 {usedTokensLabel}，共 {totalTokensLabel}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <button
                type={showStopIcon ? 'button' : 'submit'}
                className="composer-send"
                disabled={showStopIcon ? !canSendInput : !canSubmit}
                aria-label={showStopIcon ? '中断' : '发送'}
                onClick={() => {
                  if (showStopIcon) {
                    onInterrupt()
                  }
                }}
              >
                {showStopIcon ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="7" y="7" width="10" height="10" rx="2.5" />
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
        ) : null}
      </div>

      {isFullscreenEditorOpen ? (
        <div className="composer-fullscreen-sheet" role="dialog" aria-modal="true" aria-label="全屏编辑">
          <div className="composer-fullscreen-sheet__panel">
            <div className="composer-fullscreen-sheet__header">
              <div className="composer-fullscreen-sheet__title">全屏编辑</div>
              <button
                type="button"
                className="composer-fullscreen-sheet__close"
                aria-label="退出全屏编辑"
                onClick={() => setIsFullscreenEditorOpen(false)}
              >
                <IconClose />
              </button>
            </div>

            <SkillAwareTextarea
              className="composer-fullscreen-sheet__input"
              value={draft}
              disabled={!canEditInput}
              projectId={projectId}
              agentId={agentId}
              placeholder={
                canEditInput
                  ? (inputPlaceholder ?? '要求后续变更')
                  : (readOnlyPlaceholder ?? '当前会话为只读模式')
              }
              onChange={onDraftChange}
              onKeyDown={handleDraftKeyDown}
              autoFocus
            />

            <div className="composer-fullscreen-sheet__footer">
              <div className="composer-fullscreen-sheet__meta">
                <span>{selectedModel}</span>
                <span>{selectedReasoning}</span>
                {isYoloModeEnabled ? (
                  <span>Yolo</span>
                ) : null}
                {pendingAttachments.length > 0 ? (
                  <span>{pendingAttachments.length} 个附件</span>
                ) : null}
              </div>
              <div className="composer-fullscreen-sheet__actions">
                <button
                  type="button"
                  className="composer-fullscreen-sheet__button"
                  onClick={() => setIsFullscreenEditorOpen(false)}
                >
                  关闭
                </button>
                {showStopIcon ? (
                  <button
                    type="button"
                    className="composer-fullscreen-sheet__button is-primary"
                    disabled={!canSendInput}
                    onClick={onInterrupt}
                  >
                    中断
                  </button>
                ) : (
                  <button
                    type="button"
                    className="composer-fullscreen-sheet__button is-primary"
                    disabled={!canSubmit}
                    onClick={() => {
                      submitDraft()
                      setIsFullscreenEditorOpen(false)
                    }}
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showJumpToBottom ? (
        <button
          type="button"
          className={`conversation-jump-bottom ${isDesktopSidebar ? 'has-desktop-sidebar' : ''}`}
          style={wrapStyle}
          onClick={onJumpToBottom}
          aria-label="滚动到最下面"
        >
          <IconArrowDown />
        </button>
      ) : null}
    </>
  )
})
