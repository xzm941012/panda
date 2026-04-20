import { startTransition, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ClientDiagnosticElementSnapshot, ClientDiagnosticReport } from '@panda/protocol'
import { collectClientDiagnostics } from '../../lib/client-diagnostics'
import '../../styles/diagnostics.css'

const formatBoolean = (value: boolean) => (value ? '支持' : '不支持')

const summarizeLikelyCause = (report: ClientDiagnosticReport | null) => {
  if (!report) {
    return '正在采集浏览器能力、样式表、缓存和关键元素快照。'
  }

  if (!report.feature_support['color-mix-oklab']) {
    return '高概率是安卓浏览器不支持 color-mix(in oklab, ...)，导致输入框和面板的混色背景规则整体失效。'
  }

  if (report.resource_probes.some((entry) => !entry.ok)) {
    return '至少有一个静态资源探测失败，更像是 CSS 或脚本资源没有正确加载，或者被缓存 / Service Worker 干扰。'
  }

  if (report.service_worker.controller && report.cache.keys.length > 0) {
    return '样式能力本身看起来正常，但页面被 Service Worker 控制且存在缓存，下一步要重点排查缓存是否陈旧。'
  }

  return '浏览器能力和基础资源看起来正常，下一步需要对比具体元素快照与安卓真机截图。'
}

const summarizeElementIssue = (snapshot: ClientDiagnosticElementSnapshot) => {
  if (!snapshot.found) {
    return '未找到对应元素'
  }

  const backgroundColor = snapshot.computed['background-color'] ?? '(empty)'
  const backgroundImage = snapshot.computed['background-image'] ?? '(empty)'

  if (backgroundColor === 'rgba(0, 0, 0, 0)' && backgroundImage === 'none') {
    return '背景完全透明'
  }

  return `${backgroundColor} / ${backgroundImage}`
}

export const DiagnosticsPage = () => {
  const navigate = useNavigate()
  const [report, setReport] = useState<ClientDiagnosticReport | null>(null)
  const [isCollecting, setIsCollecting] = useState(true)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const collectReport = async () => {
    setIsCollecting(true)
    setStatusMessage(null)

    try {
      const nextReport = await collectClientDiagnostics()
      startTransition(() => {
        setReport(nextReport)
      })
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? `采集失败：${error.message}`
          : '采集失败，请稍后重试。',
      )
    } finally {
      setIsCollecting(false)
    }
  }

  useEffect(() => {
    void collectReport()
  }, [])

  const handleCopyJson = async () => {
    if (!report) {
      return
    }

    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
      setStatusMessage('当前浏览器不支持直接复制，请手动截图或长按选择。')
      return
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      setStatusMessage('诊断 JSON 已复制，可以直接发给我继续分析。')
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? `复制失败：${error.message}`
          : '复制失败，请手动截图或长按选择。',
      )
    }
  }

  const likelyCause = useMemo(() => summarizeLikelyCause(report), [report])

  return (
    <main className="diagnostics-page">
      <div className="diagnostics-shell">
        <header className="diagnostics-header">
          <div className="diagnostics-header__copy">
            <button
              type="button"
              className="diagnostics-back"
              onClick={() => void navigate({ to: '/settings' })}
            >
              返回设置
            </button>
            <h1>安卓样式诊断</h1>
            <p>在手机上打开本页，可以直接检查浏览器能力、样式加载、缓存和关键面板快照。</p>
          </div>
          <div className="diagnostics-toolbar">
            <button
              type="button"
              className="diagnostics-button"
              onClick={() => void collectReport()}
              disabled={isCollecting}
            >
              {isCollecting ? '采集中…' : '刷新诊断'}
            </button>
            <button
              type="button"
              className="diagnostics-button diagnostics-button--ghost"
              onClick={() => void handleCopyJson()}
              disabled={!report}
            >
              复制 JSON
            </button>
          </div>
        </header>

        {statusMessage ? <p className="diagnostics-status">{statusMessage}</p> : null}

        <section className="diagnostics-card diagnostics-card--hero">
          <span className="diagnostics-eyebrow">初步判断</span>
          <h2>{likelyCause}</h2>
          <p>
            真机异常而桌面浏览器和 F12 模拟正常，最常见就是浏览器 CSS 能力和缓存状态与桌面环境不同。
          </p>
          {report?.notes.length ? (
            <ul className="diagnostics-list">
              {report.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </section>

        {report ? (
          <>
            <section className="diagnostics-grid">
              <article className="diagnostics-card">
                <h2>环境</h2>
                <dl className="diagnostics-kv">
                  <div>
                    <dt>页面</dt>
                    <dd>{report.page.pathname}</dd>
                  </div>
                  <div>
                    <dt>安全上下文</dt>
                    <dd>{report.environment.secure_context ? '是' : '否'}</dd>
                  </div>
                  <div>
                    <dt>独立窗口</dt>
                    <dd>{report.environment.standalone_display_mode ? '是' : '否'}</dd>
                  </div>
                  <div>
                    <dt>在线状态</dt>
                    <dd>{report.environment.online == null ? '未知' : report.environment.online ? '在线' : '离线'}</dd>
                  </div>
                  <div>
                    <dt>视口</dt>
                    <dd>
                      {report.viewport.width} x {report.viewport.height} @ {report.viewport.device_pixel_ratio}
                    </dd>
                  </div>
                  <div>
                    <dt>UA</dt>
                    <dd className="diagnostics-break">{report.environment.user_agent}</dd>
                  </div>
                </dl>
              </article>

              <article className="diagnostics-card">
                <h2>浏览器能力</h2>
                <dl className="diagnostics-kv">
                  {Object.entries(report.feature_support).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{formatBoolean(value)}</dd>
                    </div>
                  ))}
                </dl>
              </article>

              <article className="diagnostics-card">
                <h2>缓存与 SW</h2>
                <dl className="diagnostics-kv">
                  <div>
                    <dt>Service Worker</dt>
                    <dd>{report.service_worker.supported ? '支持' : '不支持'}</dd>
                  </div>
                  <div>
                    <dt>当前受控</dt>
                    <dd>{report.service_worker.controller ? '是' : '否'}</dd>
                  </div>
                  <div>
                    <dt>注册数量</dt>
                    <dd>{report.service_worker.registrations.length}</dd>
                  </div>
                  <div>
                    <dt>Cache Storage</dt>
                    <dd>{report.cache.supported ? report.cache.keys.join(', ') || '空' : '不支持'}</dd>
                  </div>
                </dl>
              </article>

              <article className="diagnostics-card">
                <h2>主题变量</h2>
                <dl className="diagnostics-kv">
                  {Object.entries(report.theme_variables).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            </section>

            <section className="diagnostics-card">
              <h2>资源探测</h2>
              <div className="diagnostics-table-wrap">
                <table className="diagnostics-table">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>URL</th>
                      <th>状态</th>
                      <th>内容类型</th>
                      <th>Cache-Control</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.resource_probes.map((entry) => (
                      <tr key={`${entry.kind}:${entry.url}`}>
                        <td>{entry.kind}</td>
                        <td className="diagnostics-break">{entry.url}</td>
                        <td>{entry.ok ? `OK (${entry.status ?? '-'})` : `失败 (${entry.status ?? '-'})`}</td>
                        <td>{entry.content_type ?? '-'}</td>
                        <td>{entry.cache_control ?? entry.error ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="diagnostics-card">
              <h2>关键元素快照</h2>
              <div className="diagnostics-element-grid">
                {report.element_snapshots.map((snapshot) => (
                  <article key={snapshot.selector} className="diagnostics-element-card">
                    <h3>{snapshot.selector}</h3>
                    <p>{summarizeElementIssue(snapshot)}</p>
                    <dl className="diagnostics-kv diagnostics-kv--compact">
                      <div>
                        <dt>找到元素</dt>
                        <dd>{snapshot.found ? '是' : '否'}</dd>
                      </div>
                      <div>
                        <dt>尺寸</dt>
                        <dd>
                          {snapshot.rect
                            ? `${snapshot.rect.width} x ${snapshot.rect.height}`
                            : '-'}
                        </dd>
                      </div>
                      <div>
                        <dt>背景色</dt>
                        <dd>{snapshot.computed['background-color'] ?? '-'}</dd>
                      </div>
                      <div>
                        <dt>背景图</dt>
                        <dd className="diagnostics-break">
                          {snapshot.computed['background-image'] ?? '-'}
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            </section>

            <section className="diagnostics-card">
              <h2>原始 JSON</h2>
              <pre className="diagnostics-json">
                {JSON.stringify(report, null, 2)}
              </pre>
            </section>
          </>
        ) : (
          <section className="diagnostics-card">
            <p>正在等待诊断结果…</p>
          </section>
        )}
      </div>
    </main>
  )
}
