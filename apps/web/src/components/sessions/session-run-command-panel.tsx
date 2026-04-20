import {
  useMemo,
  useState,
} from 'react'
import type {
  SessionRunCommand,
  SessionRunCommandDraft,
  SessionRunNodeRuntime,
} from '@panda/protocol'

type SessionRunCommandPanelProps = {
  commands: SessionRunCommand[]
  nodeRuntime: SessionRunNodeRuntime | null
  error: string | null
  pendingRunCommandId: string | null
  pendingKillCommandId: string | null
  pendingDeleteCommandId: string | null
  isSaving: boolean
  isGenerating: boolean
  isStartingAll: boolean
  isStoppingAll: boolean
  generationReason: string | null
  executionModelLabel: string
  onRun: (commandId: string) => void
  onRunAll: () => void
  onRunAllKill: () => void
  onRunKill: (commandId: string) => void
  onSave: (input: {
    commandId?: string
    draft: SessionRunCommandDraft
  }) => void
  onDelete: (commandId: string) => void
  onGenerate: () => void
}

type EditorMode = 'list' | 'edit'

const EMPTY_DRAFT: SessionRunCommandDraft = {
  name: '',
  description: null,
  command: '',
  kill_command: null,
  cwd: null,
  shell: 'auto',
  node_version: null,
  port: null,
}

const IconPlay = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m8 6 9 6-9 6z" />
  </svg>
)

const IconSquareStop = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.8" />
  </svg>
)

const IconSpark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4Z" />
    <path d="M18 15.2 18.8 18 21.6 18.8 18.8 19.6 18 22.4 17.2 19.6 14.4 18.8 17.2 18Z" />
  </svg>
)

const IconEdit = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4 20 4.2-1 9.2-9.2a1.8 1.8 0 0 0 0-2.6l-.6-.6a1.8 1.8 0 0 0-2.6 0L5 15.8 4 20Z" />
    <path d="m13.5 6.5 4 4" />
  </svg>
)

const IconTrash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 7h15" />
    <path d="M9.5 4.5h5" />
    <path d="M7 7l.6 11a1.8 1.8 0 0 0 1.8 1.7h5.2a1.8 1.8 0 0 0 1.8-1.7L17 7" />
    <path d="M10 10.5v5.2" />
    <path d="M14 10.5v5.2" />
  </svg>
)

const IconPlus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
)

const shellLabel: Record<SessionRunCommandDraft['shell'], string> = {
  auto: '自动',
  powershell: 'PowerShell',
  cmd: 'CMD',
  bash: 'Bash',
}

export const SessionRunCommandPanel = ({
  commands,
  nodeRuntime,
  error,
  pendingRunCommandId,
  pendingKillCommandId,
  pendingDeleteCommandId,
  isSaving,
  isGenerating,
  isStartingAll,
  isStoppingAll,
  generationReason,
  executionModelLabel,
  onRun,
  onRunAll,
  onRunAllKill,
  onRunKill,
  onSave,
  onDelete,
  onGenerate,
}: SessionRunCommandPanelProps) => {
  const [mode, setMode] = useState<EditorMode>('list')
  const [editingCommandId, setEditingCommandId] = useState<string | null>(null)
  const [draft, setDraft] = useState<SessionRunCommandDraft>(EMPTY_DRAFT)

  const editingCommand = useMemo(
    () => commands.find((command) => command.id === editingCommandId) ?? null,
    [commands, editingCommandId],
  )

  const nodeVersionOptions = useMemo(() => {
    const options = [...(nodeRuntime?.versions ?? [])]
    if (draft.node_version && !options.includes(draft.node_version)) {
      options.unshift(draft.node_version)
    }
    return options
  }, [draft.node_version, nodeRuntime?.versions])

  const stoppableCommandCount = useMemo(
    () => commands.filter((command) => Boolean(command.kill_command)).length,
    [commands],
  )

  const beginCreate = () => {
    setDraft(EMPTY_DRAFT)
    setEditingCommandId(null)
    setMode('edit')
  }

  const beginEdit = (command: SessionRunCommand) => {
    setDraft({
      name: command.name,
      description: command.description,
      command: command.command,
      kill_command: command.kill_command,
      cwd: command.cwd,
      shell: command.shell,
      node_version: command.node_version,
      port: command.port,
    })
    setEditingCommandId(command.id)
    setMode('edit')
  }

  const handleSave = () => {
    onSave({
      commandId: editingCommand?.id,
      draft,
    })
    if (!isSaving) {
      setMode('list')
      setEditingCommandId(null)
    }
  }

  return (
    <div className="session-run-panel">
      <div className="session-run-panel__header">
        <div className="session-run-panel__header-copy">
          <div className="session-run-panel__title-row">
            <h2 className="session-run-panel__title">项目命令</h2>
            <span className="session-run-panel__count">{commands.length} 条</span>
          </div>
          <div className="session-run-panel__hint">一键生成使用模型：{executionModelLabel}</div>
        </div>

        <div className="session-run-panel__header-actions">
          <button
            type="button"
            className="session-run-panel__icon-button is-primary"
            aria-label={isStartingAll ? '正在一键启动项目命令' : '一键启动项目命令'}
            title={isStartingAll ? '正在一键启动项目命令' : '一键启动项目命令'}
            disabled={commands.length === 0 || isStartingAll || isStoppingAll}
            onClick={onRunAll}
          >
            <IconPlay />
          </button>
          <button
            type="button"
            className="session-run-panel__icon-button is-warning"
            aria-label={isStoppingAll ? '正在一键停止项目命令' : '一键停止项目命令'}
            title={isStoppingAll ? '正在一键停止项目命令' : '一键停止项目命令'}
            disabled={stoppableCommandCount === 0 || isStartingAll || isStoppingAll}
            onClick={onRunAllKill}
          >
            <IconSquareStop />
          </button>
          <button
            type="button"
            className={`session-run-panel__icon-button ${isGenerating ? 'is-loading' : ''}`}
            aria-label={isGenerating ? '正在一键生成项目命令' : '一键生成项目命令'}
            title={isGenerating ? '正在一键生成项目命令' : '一键生成项目命令'}
            aria-busy={isGenerating}
            disabled={isGenerating || isStartingAll || isStoppingAll}
            onClick={onGenerate}
          >
            <IconSpark />
          </button>
          <button
            type="button"
            className="session-run-panel__icon-button"
            aria-label="新增项目命令"
            title="新增项目命令"
            onClick={beginCreate}
          >
            <IconPlus />
          </button>
        </div>
      </div>

      {error ? <div className="session-run-panel__notice is-error">{error}</div> : null}
      {isGenerating ? (
        <div className="session-run-panel__notice is-loading" role="status" aria-live="polite">
          正在分析项目并生成推荐命令…
        </div>
      ) : null}
      {generationReason ? <div className="session-run-panel__hint">{generationReason}</div> : null}

      {mode === 'edit' ? (
        <div className="session-run-panel__card">
          <h3 className="session-run-panel__section-title">
            {editingCommand ? '编辑命令' : '新增命令'}
          </h3>
          <div className="session-run-panel__form-grid">
            <label className="session-run-panel__field">
              <span>名称</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                className="session-run-panel__input"
                placeholder="例如：启动前端"
              />
            </label>

            <label className="session-run-panel__field">
              <span>说明</span>
              <input
                value={draft.description ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value || null }))
                }
                className="session-run-panel__input"
                placeholder="给自己留一个短说明"
              />
            </label>

            <label className="session-run-panel__field is-full">
              <span>命令</span>
              <textarea
                value={draft.command}
                onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
                className="session-run-panel__textarea"
                placeholder="pnpm dev"
                rows={4}
              />
            </label>

            <label className="session-run-panel__field is-full">
              <span>停止命令</span>
              <textarea
                value={draft.kill_command ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, kill_command: event.target.value || null }))
                }
                className="session-run-panel__textarea"
                placeholder="留空表示不需要单独停止"
                rows={3}
              />
            </label>

            <label className="session-run-panel__field">
              <span>工作目录</span>
              <input
                value={draft.cwd ?? ''}
                onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value || null }))}
                className="session-run-panel__input"
                placeholder="留空表示项目根目录"
              />
            </label>

            <label className="session-run-panel__field">
              <span>端口</span>
              <input
                value={draft.port ?? ''}
                onChange={(event) => {
                  const nextValue = Number.parseInt(event.target.value, 10)
                  setDraft((current) => ({
                    ...current,
                    port: Number.isFinite(nextValue) && nextValue > 0 ? nextValue : null,
                  }))
                }}
                className="session-run-panel__input"
                placeholder="例如：5173"
                inputMode="numeric"
              />
            </label>

            <label className="session-run-panel__field">
              <span>Shell</span>
              <select
                value={draft.shell}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    shell: event.target.value as SessionRunCommandDraft['shell'],
                  }))
                }
                className="session-run-panel__select"
              >
                {Object.entries(shellLabel).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="session-run-panel__field">
              <span>Node 环境</span>
              <select
                value={draft.node_version ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, node_version: event.target.value || null }))
                }
                className="session-run-panel__select"
              >
                <option value="">默认环境</option>
                {nodeVersionOptions.map((version) => (
                  <option key={version} value={version}>
                    Node {version}
                    {nodeRuntime?.versions.includes(version) ? '' : '（未检测到）'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="session-run-panel__hint">
            {nodeRuntime?.versions.length
              ? 'Node 版本只会临时注入当前命令，不会修改系统全局环境。'
              : (nodeRuntime?.error?.trim() || '未检测到可用的 nvm Node 版本，将按默认环境运行。')}
          </div>

          <div className="session-run-panel__form-actions">
            <button type="button" className="session-run-panel__ghost-button" onClick={() => setMode('list')}>
              取消
            </button>
            <button
              type="button"
              className="session-run-panel__primary-button"
              disabled={!draft.name.trim() || !draft.command.trim() || isSaving}
              onClick={handleSave}
            >
              {isSaving ? '保存中...' : editingCommand ? '保存修改' : '保存命令'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="session-run-panel__list">
        {commands.length > 0 ? (
          commands.map((command) => (
            <article key={command.id} className="session-run-panel__command-card">
              <div className="session-run-panel__command-head">
                <button type="button" className="session-run-panel__command-main" onClick={() => beginEdit(command)}>
                  <div className="session-run-panel__command-heading">
                    <span className="session-run-panel__command-name">{command.name}</span>
                    {command.description ? (
                      <span className="session-run-panel__command-description">{command.description}</span>
                    ) : null}
                  </div>
                  <div className="session-run-panel__command-line">{command.command}</div>
                </button>

                <div className="session-run-panel__command-actions">
                  {command.kill_command ? (
                    <button
                      type="button"
                      className="session-run-panel__icon-button is-warning"
                      aria-label={`执行 ${command.name} 的停止命令`}
                      title={`执行 ${command.name} 的停止命令`}
                      disabled={pendingKillCommandId === command.id}
                      onClick={() => onRunKill(command.id)}
                    >
                      <IconSquareStop />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="session-run-panel__icon-button"
                    aria-label={`编辑 ${command.name}`}
                    title={`编辑 ${command.name}`}
                    onClick={() => beginEdit(command)}
                  >
                    <IconEdit />
                  </button>
                  <button
                    type="button"
                    className="session-run-panel__icon-button is-danger"
                    aria-label={`删除 ${command.name}`}
                    title={`删除 ${command.name}`}
                    disabled={pendingDeleteCommandId === command.id}
                    onClick={() => onDelete(command.id)}
                  >
                    <IconTrash />
                  </button>
                  <button
                    type="button"
                    className="session-run-panel__icon-button is-primary"
                    aria-label={`运行 ${command.name}`}
                    title={`运行 ${command.name}`}
                    disabled={pendingRunCommandId === command.id}
                    onClick={() => onRun(command.id)}
                  >
                    <IconPlay />
                  </button>
                </div>
              </div>

              <div className="session-run-panel__command-footer">
                <div className="session-run-panel__command-meta">
                  <span className="session-run-panel__command-pill">{shellLabel[command.shell]}</span>
                  {command.node_version ? (
                    <span className="session-run-panel__command-pill is-node">Node {command.node_version}</span>
                  ) : null}
                  {command.port ? (
                    <span className="session-run-panel__command-pill">:{command.port}</span>
                  ) : null}
                  {command.kill_command ? (
                    <span className="session-run-panel__command-pill is-kill">可停止</span>
                  ) : null}
                  <span className="session-run-panel__command-pill">{command.cwd ? command.cwd : '项目根目录'}</span>
                </div>
              </div>
            </article>
          ))
        ) : (
          <div className="session-run-panel__empty">
            <div className="session-run-panel__empty-title">还没有项目命令</div>
            <div className="session-run-panel__empty-copy">可以手动新增，或直接点击一键生成。</div>
          </div>
        )}
      </div>
    </div>
  )
}
