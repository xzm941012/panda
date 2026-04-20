import type {
  ApprovalRequest,
  GitFile,
  PreviewEndpoint,
  RuntimeProcess,
} from '@panda/protocol'
import { useUiStore } from '../../store/ui-store'

export const Inspector = ({
  changedFiles,
  runtimeProcesses,
  previews,
  approvals,
}: {
  changedFiles: GitFile[]
  runtimeProcesses: RuntimeProcess[]
  previews: PreviewEndpoint[]
  approvals: ApprovalRequest[]
}) => {
  const panelTab = useUiStore((s) => s.panelTab)
  const setPanelTab = useUiStore((s) => s.setPanelTab)

  const tabs = ['git', 'runtime', 'preview', 'approvals'] as const

  const tabContent = {
    git: (
      <div className="detail-list">
        {changedFiles.map((file) => (
          <div key={file.path} className="detail-item">
            <div>
              <strong>{file.path}</strong>
              <p>{file.status}</p>
            </div>
            <span>
              +{file.additions} / -{file.deletions}
            </span>
          </div>
        ))}
      </div>
    ),
    runtime: (
      <div className="detail-list">
        {runtimeProcesses.map((rt) => (
          <div key={rt.id} className="detail-item">
            <div>
              <strong>{rt.name}</strong>
              <p>{rt.command}</p>
            </div>
            <span>{rt.port ? `:${rt.port}` : rt.status}</span>
          </div>
        ))}
      </div>
    ),
    preview: (
      <div className="detail-list">
        {previews.map((p) => (
          <a
            key={p.id}
            className="detail-item detail-item--link"
            href={p.url}
            target="_blank"
            rel="noreferrer"
          >
            <div>
              <strong>{p.label}</strong>
              <p>{p.url}</p>
            </div>
            <span>{p.status}</span>
          </a>
        ))}
      </div>
    ),
    approvals: (
      <div className="detail-list">
        {approvals.map((a) => (
          <div key={a.id} className="detail-item">
            <div>
              <strong>{a.title}</strong>
              <p>{a.description}</p>
            </div>
            <span>{a.status}</span>
          </div>
        ))}
      </div>
    ),
  } as const

  return (
    <section className="sheet">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h3>控制面板</h3>
        </div>
      </div>
      <div className="inspector-tabs">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tab-chip ${panelTab === tab ? 'tab-chip--active' : ''}`}
            onClick={() => setPanelTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      {tabContent[panelTab]}
    </section>
  )
}
