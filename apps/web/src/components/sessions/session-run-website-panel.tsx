import { useMemo, useState } from 'react'
import type {
  SessionRunWebsite,
  SessionRunWebsiteDraft,
} from '@panda/protocol'

type SessionRunWebsitePanelProps = {
  websites: SessionRunWebsite[]
  error: string | null
  pendingDeleteWebsiteId: string | null
  isSaving: boolean
  isGenerating: boolean
  generationReason: string | null
  executionModelLabel: string
  onOpen: (website: SessionRunWebsite) => void
  onSave: (input: {
    websiteId?: string
    draft: SessionRunWebsiteDraft
  }) => void
  onDelete: (websiteId: string) => void
  onGenerate: () => void
}

type EditorMode = 'list' | 'edit'

const EMPTY_DRAFT: SessionRunWebsiteDraft = {
  name: '',
  description: null,
  url: '',
}

const IconSpark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4Z" />
    <path d="M18 15.2 18.8 18 21.6 18.8 18.8 19.6 18 22.4 17.2 19.6 14.4 18.8 17.2 18Z" />
  </svg>
)

const IconGlobe = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.8 12h16.4" />
    <path d="M12 3.7c2.3 2.4 3.6 5.3 3.6 8.3S14.3 17.9 12 20.3c-2.3-2.4-3.6-5.3-3.6-8.3S9.7 6.1 12 3.7Z" />
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

export const SessionRunWebsitePanel = ({
  websites,
  error,
  pendingDeleteWebsiteId,
  isSaving,
  isGenerating,
  generationReason,
  executionModelLabel,
  onOpen,
  onSave,
  onDelete,
  onGenerate,
}: SessionRunWebsitePanelProps) => {
  const [mode, setMode] = useState<EditorMode>('list')
  const [editingWebsiteId, setEditingWebsiteId] = useState<string | null>(null)
  const [draft, setDraft] = useState<SessionRunWebsiteDraft>(EMPTY_DRAFT)

  const editingWebsite = useMemo(
    () => websites.find((website) => website.id === editingWebsiteId) ?? null,
    [editingWebsiteId, websites],
  )

  const beginCreate = () => {
    setDraft(EMPTY_DRAFT)
    setEditingWebsiteId(null)
    setMode('edit')
  }

  const beginEdit = (website: SessionRunWebsite) => {
    setDraft({
      name: website.name,
      description: website.description,
      url: website.url,
    })
    setEditingWebsiteId(website.id)
    setMode('edit')
  }

  const handleSave = () => {
    onSave({
      websiteId: editingWebsite?.id,
      draft,
    })
    if (!isSaving) {
      setMode('list')
      setEditingWebsiteId(null)
    }
  }

  return (
    <div className="session-run-panel">
      <div className="session-run-panel__header">
        <div className="session-run-panel__header-copy">
          <div className="session-run-panel__title-row">
            <h2 className="session-run-panel__title">项目网页</h2>
            <span className="session-run-panel__count">{websites.length} 条</span>
          </div>
          <div className="session-run-panel__hint">一键生成使用模型：{executionModelLabel}</div>
        </div>

        <div className="session-run-panel__header-actions">
          <button
            type="button"
            className={`session-run-panel__icon-button ${isGenerating ? 'is-loading' : ''}`}
            aria-label={isGenerating ? '正在一键生成项目网页' : '一键生成项目网页'}
            title={isGenerating ? '正在一键生成项目网页' : '一键生成项目网页'}
            aria-busy={isGenerating}
            disabled={isGenerating}
            onClick={onGenerate}
          >
            <IconSpark />
          </button>
          <button
            type="button"
            className="session-run-panel__icon-button"
            aria-label="新增项目网页"
            title="新增项目网页"
            onClick={beginCreate}
          >
            <IconPlus />
          </button>
        </div>
      </div>

      {error ? <div className="session-run-panel__notice is-error">{error}</div> : null}
      {isGenerating ? (
        <div className="session-run-panel__notice is-loading" role="status" aria-live="polite">
          正在分析项目并生成推荐网页…
        </div>
      ) : null}
      {generationReason ? <div className="session-run-panel__hint">{generationReason}</div> : null}

      {mode === 'edit' ? (
        <div className="session-run-panel__card">
          <h3 className="session-run-panel__section-title">
            {editingWebsite ? '编辑网页' : '新增网页'}
          </h3>
          <div className="session-run-panel__form-grid">
            <label className="session-run-panel__field">
              <span>名称</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                className="session-run-panel__input"
                placeholder="例如：前端首页"
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
              <span>地址</span>
              <input
                value={draft.url}
                onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
                className="session-run-panel__input"
                placeholder="http://localhost:5173"
              />
            </label>
          </div>

          <div className="session-run-panel__form-actions">
            <button type="button" className="session-run-panel__ghost-button" onClick={() => setMode('list')}>
              取消
            </button>
            <button
              type="button"
              className="session-run-panel__primary-button"
              disabled={!draft.name.trim() || !draft.url.trim() || isSaving}
              onClick={handleSave}
            >
              {isSaving ? '保存中...' : editingWebsite ? '保存修改' : '保存网页'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="session-run-panel__list">
        {websites.length > 0 ? (
          websites.map((website) => (
            <article key={website.id} className="session-run-panel__command-card">
              <div className="session-run-panel__command-head">
                <button type="button" className="session-run-panel__command-main" onClick={() => beginEdit(website)}>
                  <div className="session-run-panel__command-heading">
                    <span className="session-run-panel__command-name">{website.name}</span>
                    {website.description ? (
                      <span className="session-run-panel__command-description">{website.description}</span>
                    ) : null}
                  </div>
                  <div className="session-run-panel__command-line">{website.url}</div>
                </button>

                <div className="session-run-panel__command-actions">
                  <a
                    className="session-run-panel__icon-button is-primary"
                    aria-label={`打开 ${website.name}`}
                    title={`打开 ${website.name}`}
                    href={website.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => onOpen(website)}
                  >
                    <IconGlobe />
                  </a>
                  <button
                    type="button"
                    className="session-run-panel__icon-button"
                    aria-label={`编辑 ${website.name}`}
                    title={`编辑 ${website.name}`}
                    onClick={() => beginEdit(website)}
                  >
                    <IconEdit />
                  </button>
                  <button
                    type="button"
                    className="session-run-panel__icon-button is-danger"
                    aria-label={`删除 ${website.name}`}
                    title={`删除 ${website.name}`}
                    disabled={pendingDeleteWebsiteId === website.id}
                    onClick={() => onDelete(website.id)}
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>

              <div className="session-run-panel__command-footer">
                <div className="session-run-panel__command-meta">
                  <span className="session-run-panel__command-pill">网页</span>
                </div>
              </div>
            </article>
          ))
        ) : (
          <div className="session-run-panel__empty">
            <div className="session-run-panel__empty-title">还没有项目网页</div>
            <div className="session-run-panel__empty-copy">可以手动新增，或直接点击一键生成。</div>
          </div>
        )}
      </div>
    </div>
  )
}
