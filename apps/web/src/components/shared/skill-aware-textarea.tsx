import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { CodexCommand, ProjectSkill } from '@panda/protocol'
import {
  filterCodexCommands,
  filterProjectSkills,
  getActiveSlashCommand,
  getActiveSkillMention,
  getSkillScopeLabel,
  replaceActiveSlashCommand,
  replaceActiveSkillMention,
  tokenizeInlineRichContent,
} from '../../lib/skill-mentions'
import { useCodexCommands } from '../../lib/use-codex-commands'
import { useProjectSkills } from '../../lib/use-project-skills'

type SkillAwareTextareaProps = {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  disabled?: boolean
  className: string
  projectId?: string | null
  agentId?: string | null
  autoFocus?: boolean
}

const MAX_SKILL_PICKER_ITEMS = 24

const renderOverlayContent = (value: string) => {
  const tokens = tokenizeInlineRichContent(value)

  if (tokens.length === 0) {
    return <span>&nbsp;</span>
  }

  return tokens.map((token, index) => {
    const tokenKey = `skill-aware-token-${index}`

    if (token.kind === 'skill') {
      return (
        <span key={tokenKey} className="skill-aware-textarea__token is-skill">
          {token.raw}
        </span>
      )
    }

    if (token.kind === 'command') {
      return (
        <span key={tokenKey} className="skill-aware-textarea__token is-command">
          {token.raw}
        </span>
      )
    }

    if (token.kind === 'code') {
      return (
        <span key={tokenKey} className="skill-aware-textarea__token is-code">
          {token.value}
        </span>
      )
    }

    if (token.kind === 'path-link') {
      return (
        <span key={tokenKey} className="skill-aware-textarea__token is-link">
          {token.label}
        </span>
      )
    }

    return <span key={tokenKey}>{token.value}</span>
  })
}

export const SkillAwareTextarea = ({
  value,
  onChange,
  onKeyDown,
  placeholder,
  disabled = false,
  className,
  projectId,
  agentId,
  autoFocus = false,
}: SkillAwareTextareaProps) => {
  const isFullscreenVariant = className.includes('composer-fullscreen-sheet__input')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [isFocused, setIsFocused] = useState(false)
  const [isPickerSuppressed, setIsPickerSuppressed] = useState(false)
  const [activeSkillIndex, setActiveSkillIndex] = useState(0)
  const activeMention = useMemo(
    () => getActiveSkillMention(value, selection.start, selection.end),
    [selection.end, selection.start, value],
  )
  const activeSlashCommand = useMemo(
    () => getActiveSlashCommand(value, selection.start, selection.end),
    [selection.end, selection.start, value],
  )
  const showSkillPicker =
    isFocused && !disabled && Boolean(activeMention) && !isPickerSuppressed
  const showCommandPicker =
    isFocused && !disabled && Boolean(activeSlashCommand) && !isPickerSuppressed
  const activePickerKind = showCommandPicker ? 'command' : showSkillPicker ? 'skill' : null
  const skillsQuery = useProjectSkills(projectId, agentId, { enabled: showSkillPicker })
  const commandsQuery = useCodexCommands({
    enabled: showCommandPicker,
    scope: agentId
      ? {
          agentId,
          projectId,
        }
      : undefined,
  })
  const filteredSkills = useMemo(
    () =>
      filterProjectSkills(skillsQuery.data ?? [], activeMention?.query ?? '').slice(
        0,
        MAX_SKILL_PICKER_ITEMS,
      ),
    [activeMention?.query, skillsQuery.data],
  )
  const filteredCommands = useMemo(
    () =>
      filterCodexCommands(
        commandsQuery.data?.commands ?? [],
        activeSlashCommand?.query ?? '',
      ).slice(0, MAX_SKILL_PICKER_ITEMS),
    [activeSlashCommand?.query, commandsQuery.data?.commands],
  )

  useEffect(() => {
    setActiveSkillIndex(0)
  }, [activeMention?.query, activeMention?.start, activeSlashCommand?.query, value, projectId])

  useEffect(() => {
    setIsPickerSuppressed(false)
  }, [
    activeMention?.query,
    activeMention?.start,
    activeMention?.end,
    activeSlashCommand?.query,
    activeSlashCommand?.start,
    activeSlashCommand?.end,
  ])

  const syncOverlayScroll = () => {
    if (!textareaRef.current || !overlayRef.current) {
      return
    }

    const textarea = textareaRef.current
    const overlay = overlayRef.current

    overlay.scrollTop = textarea.scrollTop
    overlay.scrollLeft = textarea.scrollLeft
    const scrollbarWidth = Math.max(
      0,
      textarea.offsetWidth - textarea.clientWidth,
    )
    overlay.style.setProperty(
      '--skill-aware-textarea-scrollbar-width',
      `${scrollbarWidth}px`,
    )
    // Preserve the input's own inline-end padding, then append scrollbar gutter width.
    overlay.style.setProperty(
      '--skill-aware-textarea-padding-inline-end',
      window.getComputedStyle(textarea).paddingInlineEnd,
    )
  }

  useEffect(() => {
    syncOverlayScroll()
  }, [value])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
      return
    }

    const textarea = textareaRef.current
    if (!textarea) {
      return
    }

    const observer = new ResizeObserver(() => {
      syncOverlayScroll()
    })
    observer.observe(textarea)
    syncOverlayScroll()

    return () => {
      observer.disconnect()
    }
  }, [])

  const updateSelection = () => {
    if (!textareaRef.current) {
      return
    }

    setSelection({
      start: textareaRef.current.selectionStart ?? 0,
      end: textareaRef.current.selectionEnd ?? 0,
    })
  }

  const applySkill = (skill: ProjectSkill) => {
    if (!textareaRef.current) {
      return
    }

    const nextValue = replaceActiveSkillMention(
      value,
      textareaRef.current.selectionStart ?? selection.start,
      textareaRef.current.selectionEnd ?? selection.end,
      skill.name,
    )
    if (!nextValue) {
      return
    }

    onChange(nextValue.value)
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return
        }

        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(
          nextValue.selectionStart,
          nextValue.selectionEnd,
        )
        setSelection({
          start: nextValue.selectionStart,
          end: nextValue.selectionEnd,
        })
      })
    }
  }

  const applyCommand = (command: CodexCommand) => {
    if (!textareaRef.current) {
      return
    }

    const nextValue = replaceActiveSlashCommand(
      value,
      textareaRef.current.selectionStart ?? selection.start,
      textareaRef.current.selectionEnd ?? selection.end,
      command.name,
    )
    if (!nextValue) {
      return
    }

    onChange(nextValue.value)
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return
        }

        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(
          nextValue.selectionStart,
          nextValue.selectionEnd,
        )
        setSelection({
          start: nextValue.selectionStart,
          end: nextValue.selectionEnd,
        })
      })
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const hasPickerOptions =
      (activePickerKind === 'skill' && filteredSkills.length > 0) ||
      (activePickerKind === 'command' && filteredCommands.length > 0)

    if (activePickerKind && hasPickerOptions) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const itemCount =
          activePickerKind === 'command' ? filteredCommands.length : filteredSkills.length
        setActiveSkillIndex((current) => (current + 1) % itemCount)
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const itemCount =
          activePickerKind === 'command' ? filteredCommands.length : filteredSkills.length
        setActiveSkillIndex((current) =>
          current - 1 < 0 ? itemCount - 1 : current - 1,
        )
        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault()
          if (activePickerKind === 'command') {
            const targetCommand =
              filteredCommands[activeSkillIndex] ?? filteredCommands[0]
            if (!targetCommand) {
              return
            }

            applyCommand(targetCommand)
            return
          }

          const targetSkill = filteredSkills[activeSkillIndex] ?? filteredSkills[0]
          if (!targetSkill) {
            return
          }

          applySkill(targetSkill)
          return
        }
      }
    }

    if (activePickerKind && event.key === 'Escape') {
      event.preventDefault()
      setIsPickerSuppressed(true)
      return
    }

    onKeyDown?.(event)
  }

  return (
    <div
      className={`skill-aware-textarea ${activePickerKind ? 'is-picker-open' : ''} ${
        isFullscreenVariant ? 'is-fullscreen' : ''
      }`}
    >
      {showCommandPicker ? (
        <div className="skill-mention-picker" role="listbox" aria-label="命令建议">
          {commandsQuery.isLoading ? (
            <div className="skill-mention-picker__empty">正在加载命令…</div>
          ) : commandsQuery.isError ? (
            <div className="skill-mention-picker__empty">命令列表加载失败</div>
          ) : filteredCommands.length === 0 ? (
            <div className="skill-mention-picker__empty">未找到匹配命令</div>
          ) : (
            filteredCommands.map((command, index) => {
              const isActive = index === activeSkillIndex
              return (
                <button
                  key={command.name}
                  type="button"
                  className={`skill-mention-picker__item ${isActive ? 'is-active' : ''}`}
                  role="option"
                  aria-selected={isActive}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    applyCommand(command)
                  }}
                  onMouseEnter={() => setActiveSkillIndex(index)}
                >
                  <span className="skill-mention-picker__main">
                    <span className="skill-mention-picker__name">/{command.name}</span>
                    <span className="skill-mention-picker__description">
                      {command.description}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      ) : showSkillPicker ? (
        <div className="skill-mention-picker" role="listbox" aria-label="技能建议">
          {skillsQuery.isLoading ? (
            <div className="skill-mention-picker__empty">正在加载技能…</div>
          ) : skillsQuery.isError ? (
            <div className="skill-mention-picker__empty">技能列表加载失败</div>
          ) : filteredSkills.length === 0 ? (
            <div className="skill-mention-picker__empty">未找到匹配技能</div>
          ) : (
            filteredSkills.map((skill, index) => {
              const isActive = index === activeSkillIndex
              return (
                <button
                  key={`${skill.scope}:${skill.name}:${skill.path}`}
                  type="button"
                  className={`skill-mention-picker__item ${isActive ? 'is-active' : ''}`}
                  role="option"
                  aria-selected={isActive}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    applySkill(skill)
                  }}
                  onMouseEnter={() => setActiveSkillIndex(index)}
                >
                  <span className="skill-mention-picker__main">
                    <span className="skill-mention-picker__name">${skill.name}</span>
                    <span className="skill-mention-picker__description">
                      {skill.description}
                    </span>
                    <span className="skill-mention-picker__scope">
                      {getSkillScopeLabel(skill.scope)}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      ) : null}

      <div className="skill-aware-textarea__surface">
        <div
          ref={overlayRef}
          className={`${className} skill-aware-textarea__overlay`}
          aria-hidden="true"
        >
          {value ? renderOverlayContent(value) : <span>&nbsp;</span>}
        </div>
        <textarea
          ref={textareaRef}
          className={`${className} skill-aware-textarea__input`}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(event) => {
            onChange(event.target.value)
            setIsPickerSuppressed(false)
            setSelection({
              start: event.target.selectionStart ?? 0,
              end: event.target.selectionEnd ?? 0,
            })
          }}
          onKeyDown={handleKeyDown}
          onClick={updateSelection}
          onSelect={updateSelection}
          onKeyUp={updateSelection}
          onFocus={() => {
            setIsFocused(true)
            setIsPickerSuppressed(false)
            updateSelection()
          }}
          onBlur={() => {
            setIsFocused(false)
          }}
          onScroll={syncOverlayScroll}
        />
      </div>
    </div>
  )
}
