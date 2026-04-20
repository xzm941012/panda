import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DevManagerConfig, DevManagerJob, DevManagerSnapshot } from '@panda/protocol'
import { resolveConnectionTarget } from '../../lib/client'
import { SettingsDirectoryPathPicker } from './settings-directory-path-picker'

type DevManagerPanelProps = {
  isActive: boolean
  agentId: string | null
}

type DevManagerQueryData = {
  baseUrl: string
  snapshot: DevManagerSnapshot
}

const LAST_APK_DOWNLOAD_KEY = 'panda-dev-manager-last-apk-download'
const DUPLICATE_DOWNLOAD_WINDOW_MS = 90_000

const formatTimestamp = (value: string | null | undefined) => {
  if (!value) {
    return '未记录'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', {
    hour12: false,
  })
}

const formatBytes = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '未知'
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`
  }
  return `${Math.round((value / 1024 / 1024) * 10) / 10} MB`
}

const readLastDownloadRecord = () => {
  if (typeof window === 'undefined') {
    return null as { artifactId: string; triggeredAt: number } | null
  }
  try {
    const raw = window.localStorage.getItem(LAST_APK_DOWNLOAD_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as {
      artifactId?: unknown
      triggeredAt?: unknown
    }
    if (
      typeof parsed.artifactId !== 'string' ||
      typeof parsed.triggeredAt !== 'number' ||
      !Number.isFinite(parsed.triggeredAt)
    ) {
      return null
    }
    return {
      artifactId: parsed.artifactId,
      triggeredAt: parsed.triggeredAt,
    }
  } catch {
    return null
  }
}

const writeLastDownloadRecord = (artifactId: string) => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    window.localStorage.setItem(
      LAST_APK_DOWNLOAD_KEY,
      JSON.stringify({
        artifactId,
        triggeredAt: Date.now(),
      }),
    )
  } catch {
    // Ignore best-effort local persistence failures.
  }
}

const jobStatusLabel = (status: DevManagerJob['status']) => {
  if (status === 'succeeded') {
    return '通过'
  }
  if (status === 'failed') {
    return '异常'
  }
  return '进行中'
}

const jobStatusTone = (status: DevManagerJob['status']) =>
  status === 'succeeded' ? 'is-success' : status === 'failed' ? 'is-danger' : 'is-muted'

const probeResultLabel = (ok: boolean | null | undefined) => {
  if (ok == null) {
    return '未测试'
  }
  return ok ? '通过' : '异常'
}

const probeResultTone = (ok: boolean | null | undefined) => {
  if (ok == null) {
    return 'is-muted'
  }
  return ok ? 'is-success' : 'is-danger'
}

const serviceControllerLabel = (status: string | null | undefined) => {
  if (!status) {
    return '未注册'
  }
  if (status === 'running') {
    return '运行中'
  }
  if (status === 'stopped') {
    return '已停止'
  }
  if (status === 'missing') {
    return '未注册'
  }
  return '未知'
}

const localhostHttp = (port: number | null | undefined) =>
  port ? `http://127.0.0.1:${port}` : ''

const localhostWs = (port: number | null | undefined) =>
  port ? `ws://127.0.0.1:${port}/ws` : ''

const createEmptyDraft = (config: DevManagerConfig): DevManagerConfig => ({
  ...config,
})

const mergeSnapshotPreservingProbe = (
  previous: DevManagerSnapshot | null | undefined,
  next: DevManagerSnapshot,
): DevManagerSnapshot => {
  if (!previous || previous.config.updated_at !== next.config.updated_at) {
    return next
  }

  const previousServices = new Map(previous.services.map((service) => [service.key, service]))
  return {
    ...next,
    services: next.services.map((service) => {
      if (service.probe) {
        return service
      }
      const previousService = previousServices.get(service.key)
      return previousService?.probe
        ? {
            ...service,
            probe: previousService.probe,
          }
        : service
    }),
  }
}

export const DevManagerPanel = ({ isActive, agentId }: DevManagerPanelProps) => {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<DevManagerConfig | null>(null)
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [npmTokenDraft, setNpmTokenDraft] = useState('')
  const [clearNpmToken, setClearNpmToken] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [isDirectoryPickerOpen, setIsDirectoryPickerOpen] = useState(false)
  const connectionScope = agentId ? { agentId } : undefined
  const devManagerQueryKey = ['settings-dev-manager', agentId ?? 'no-agent'] as const

  const devManagerQuery = useQuery<DevManagerQueryData>({
    queryKey: devManagerQueryKey,
    queryFn: async () => {
      const target = await resolveConnectionTarget(connectionScope)
      const current = queryClient.getQueryData<DevManagerQueryData>(devManagerQueryKey)
      const snapshot = await target.client.getDevManagerSnapshot({
        includeServiceProbe: false,
      })
      return {
        baseUrl: target.baseUrl,
        snapshot: mergeSnapshotPreservingProbe(current?.snapshot, snapshot),
      }
    },
    enabled: isActive && Boolean(agentId),
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchInterval: (query) => {
      const current = query.state.data as DevManagerQueryData | undefined
      return current?.snapshot.jobs.some((job) => job.status === 'running')
        ? 2_000
        : false
    },
  })

  useEffect(() => {
    const config = devManagerQuery.data?.snapshot.config
    if (!config) {
      return
    }
    if (draft && syncedAt === config.updated_at) {
      return
    }
    setDraft(createEmptyDraft(config))
    setSyncedAt(config.updated_at)
    setNpmTokenDraft('')
    setClearNpmToken(false)
  }, [devManagerQuery.data, draft, syncedAt])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!connectionScope) {
        throw new Error('当前没有可用的开发节点，暂时无法保存开发版配置。')
      }
      if (!draft) {
        throw new Error('开发版配置还没有加载完成。')
      }
      const target = await resolveConnectionTarget(connectionScope)
      return target.client.saveDevManagerConfig({
        ...draft,
        npm_token: npmTokenDraft || null,
        clear_npm_token: clearNpmToken,
      })
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData<DevManagerQueryData>(devManagerQueryKey, (current) => ({
        baseUrl: current?.baseUrl ?? '',
        snapshot: mergeSnapshotPreservingProbe(current?.snapshot, snapshot),
      }))
      setDraft(createEmptyDraft(snapshot.config))
      setSyncedAt(snapshot.config.updated_at)
      setNpmTokenDraft('')
      setClearNpmToken(false)
      setStatusMessage('开发版配置已保存。')
    },
    onError: (error) => {
      setStatusMessage(error instanceof Error ? error.message : '保存配置失败。')
    },
  })

  const actionMutation = useMutation({
    mutationFn: async (
      action:
        | 'start-development'
        | 'restart-development'
        | 'stop-development'
        | 'probe-development'
        | 'publish-npm'
        | 'install-release-services'
        | 'uninstall-release-services'
        | 'install-latest-release-package'
        | 'restart-release-services'
        | 'install-latest-release'
        | 'build-apk',
    ) => {
      if (!connectionScope) {
        throw new Error('当前没有可用的开发节点，暂时无法执行开发版管理操作。')
      }
      const target = await resolveConnectionTarget(connectionScope)
      return target.client.executeDevManagerAction({ action })
    },
    onSuccess: (response, action) => {
      queryClient.setQueryData<DevManagerQueryData>(devManagerQueryKey, (current) => ({
        baseUrl: current?.baseUrl ?? '',
        snapshot: mergeSnapshotPreservingProbe(current?.snapshot, response.snapshot),
      }))
      setStatusMessage(
        action === 'restart-release-services'
          ? '后台重启助手已启动，当前连接会短时断开，请等待正式版自动恢复。'
          : action === 'install-latest-release'
          ? '后台升级助手已启动，当前连接会短时断开，请等待正式版自动恢复。'
          : action === 'install-latest-release-package'
            ? response.job?.summary ?? '正式版 npm 安装任务已启动。'
          : action === 'install-release-services'
            ? response.job?.summary ?? '正式版服务注册任务已启动。'
            : action === 'uninstall-release-services'
              ? response.job?.summary ?? '正式版服务移除任务已启动。'
          : response.job?.summary ?? '任务已启动。',
      )
    },
    onError: (error) => {
      setStatusMessage(error instanceof Error ? error.message : '执行操作失败。')
    },
  })

  const snapshot = devManagerQuery.data?.snapshot ?? null
  const latestJob = snapshot?.jobs[0] ?? null
  const activeJob = snapshot?.jobs.find((job) => job.status === 'running') ?? null
  const latestPublishJob = snapshot?.jobs.find((job) => job.kind === 'npm-publish') ?? null
  const latestReleaseServiceInstallJob =
    snapshot?.jobs.find((job) => job.kind === 'release-service-install') ?? null
  const latestReleaseServiceUninstallJob =
    snapshot?.jobs.find((job) => job.kind === 'release-service-uninstall') ?? null
  const latestReleasePackageInstallJob =
    snapshot?.jobs.find((job) => job.kind === 'release-install-package') ?? null
  const latestReleaseRestartJob =
    snapshot?.jobs.find((job) => job.kind === 'release-restart')
    ?? snapshot?.jobs.find((job) => job.kind === 'release-install-run')
    ?? null
  const visibleJob = latestJob
  const devServices = useMemo(
    () => snapshot?.services.filter((service) => service.key.startsWith('dev-')) ?? [],
    [snapshot],
  )
  const releaseServices = useMemo(
    () => snapshot?.services.filter((service) => service.key.startsWith('release-')) ?? [],
    [snapshot],
  )

  const developmentStatusLabel = useMemo(() => {
    if (devServices.some((service) => service.status === 'running')) {
      return '部分或全部运行中'
    }
    if (devServices.some((service) => service.status === 'degraded')) {
      return '存在异常'
    }
    return '未运行'
  }, [devServices])

  const handleFieldChange = <K extends keyof DevManagerConfig>(
    key: K,
    value: DevManagerConfig[K],
  ) => {
    setDraft((current) => {
      if (!current) {
        return current
      }
      return {
        ...current,
        [key]: value,
      }
    })
  }

  const handlePortChange = (
    key:
      | 'dev_hub_port'
      | 'dev_agent_port'
      | 'dev_web_port'
      | 'release_hub_port'
      | 'release_agent_port',
    rawValue: string,
  ) => {
    const nextPort = Number(rawValue) || null
    setDraft((current) => {
      if (!current) {
        return current
      }

      const nextDraft: DevManagerConfig = {
        ...current,
        [key]: nextPort,
      }

      if (key === 'dev_hub_port') {
        const previousDefault = localhostHttp(current.dev_hub_port)
        const nextDefault = localhostHttp(nextPort)
        if (current.dev_agent_hub_url === previousDefault) {
          nextDraft.dev_agent_hub_url = nextDefault
        }
        if (current.dev_web_hub_url === previousDefault) {
          nextDraft.dev_web_hub_url = nextDefault
        }
      }

      if (key === 'dev_agent_port') {
        const previousHttp = localhostHttp(current.dev_agent_port)
        const nextHttp = localhostHttp(nextPort)
        const previousWs = localhostWs(current.dev_agent_port)
        const nextWs = localhostWs(nextPort)
        if (current.dev_agent_direct_base_url === previousHttp) {
          nextDraft.dev_agent_direct_base_url = nextHttp
        }
        if (current.dev_agent_ws_base_url === previousWs) {
          nextDraft.dev_agent_ws_base_url = nextWs
        }
      }

      if (key === 'release_hub_port') {
        const previousDefault = localhostHttp(current.release_hub_port)
        const nextDefault = localhostHttp(nextPort)
        if (current.release_agent_hub_url === previousDefault) {
          nextDraft.release_agent_hub_url = nextDefault
        }
      }

      if (key === 'release_agent_port') {
        const previousHttp = localhostHttp(current.release_agent_port)
        const nextHttp = localhostHttp(nextPort)
        const previousWs = localhostWs(current.release_agent_port)
        const nextWs = localhostWs(nextPort)
        if (current.release_agent_direct_base_url === previousHttp) {
          nextDraft.release_agent_direct_base_url = nextHttp
        }
        if (current.release_agent_ws_base_url === previousWs) {
          nextDraft.release_agent_ws_base_url = nextWs
        }
      }

      return nextDraft
    })
  }

  const handleDownloadApk = async () => {
    if (!snapshot?.apk_artifact) {
      setStatusMessage('当前还没有可下载的 APK。')
      return
    }
    if (!connectionScope) {
      setStatusMessage('当前没有可用的开发节点，暂时无法下载 APK。')
      return
    }

    const lastRecord = readLastDownloadRecord()
    if (
      lastRecord?.artifactId === snapshot.apk_artifact.artifact_id &&
      Date.now() - lastRecord.triggeredAt < DUPLICATE_DOWNLOAD_WINDOW_MS
    ) {
      setStatusMessage('同一个 APK 刚刚已经触发过下载。如果安装确认没有弹出，请先查看系统下载列表或等待浏览器处理完成。')
      return
    }

    const target = await resolveConnectionTarget(connectionScope)
    const downloadUrl = new URL(snapshot.apk_artifact.download_path, target.baseUrl).toString()
    writeLastDownloadRecord(snapshot.apk_artifact.artifact_id)
    window.open(downloadUrl, '_blank', 'noopener,noreferrer')
    setStatusMessage('APK 下载已触发。')
  }

  const handleSelectRepoPath = (targetPath: string) => {
    handleFieldChange('repo_path', targetPath)
    setIsDirectoryPickerOpen(false)
    setStatusMessage(`已选中开发版目录：${targetPath}`)
  }

  const isActionBusy = actionMutation.isPending

  if (devManagerQuery.isLoading && !snapshot) {
    return <p className="settings-block__status">正在加载开发版管理信息…</p>
  }

  if (devManagerQuery.error instanceof Error) {
    return <p className="settings-block__status">{devManagerQuery.error.message}</p>
  }

  if (!agentId) {
    return (
      <p className="settings-block__status">
        当前没有可用的代码线程节点，请先在会话里连接到目标 agent，再使用开发版管理。
      </p>
    )
  }

  if (!snapshot || !draft) {
    return <p className="settings-block__status">当前还没有可用的开发版管理数据。</p>
  }

  const currentAction = actionMutation.variables
  const hasDetectedNodeVersions = snapshot.node_runtime.versions.length > 0

  return (
    <div className="settings-content-stack">
      <section className="settings-panel settings-panel--hero">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">开发版与正式版双环境</h3>
            <p className="settings-panel__subtitle">
              正式版保持默认可用，开发版走独立端口和独立命令。首屏只读取轻量快照，状态测试按端口连通性快测。
            </p>
          </div>
        </div>

        <div className="settings-summary-strip">
          <div className="settings-summary-strip__item">
            <span>开发版代码</span>
            <strong>{snapshot.config.repo_path ?? '未配置'}</strong>
          </div>
          <div className="settings-summary-strip__item">
            <span>正式版版本</span>
            <strong>{snapshot.current_version ?? '未检测到'}</strong>
          </div>
          <div className="settings-summary-strip__item">
            <span>开发版状态</span>
            <strong>{developmentStatusLabel}</strong>
          </div>
          <div className="settings-summary-strip__item">
            <span>最新 APK</span>
            <strong>{snapshot.apk_artifact ? formatTimestamp(snapshot.apk_artifact.built_at) : '尚未生成'}</strong>
          </div>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">基础配置</h3>
            <p className="settings-panel__subtitle">保存开发版路径、nvm 版本、启动参数，以及正式版升级后自动恢复所需配置。</p>
          </div>
          <div className="settings-actions-row">
            <button
              type="button"
              className="settings-inline-action"
              onClick={() => void saveMutation.mutateAsync()}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? '保存中…' : '保存配置'}
            </button>
          </div>
        </div>

        <div className="dev-manager-form-grid">
          <div className="dev-manager-form-section dev-manager-field--wide">
            <strong>开发版运行配置</strong>
            <p>这些配置直接用于启动、重启、停止开发版 Hub + Agent + Web。启动参数会追加到对应启动命令末尾。</p>
          </div>

          <div className="settings-field dev-manager-field--wide">
            <span>开发版代码路径</span>
            <input
              type="text"
              className={`dev-manager-path-display ${draft.repo_path ? 'is-selected' : ''}`}
              value={draft.repo_path ?? ''}
              placeholder={agentId ? '点击下方按钮选择目录' : '当前没有可用节点，暂时无法浏览目录'}
              readOnly
              onClick={() => {
                if (agentId) {
                  setIsDirectoryPickerOpen(true)
                }
              }}
            />
            <div className="settings-actions-row dev-manager-path-actions">
              <button
                type="button"
                className="settings-inline-action"
                onClick={() => setIsDirectoryPickerOpen(true)}
                disabled={!agentId}
              >
                选择目录
              </button>
              <button
                type="button"
                className="settings-ghost-button"
                onClick={() => handleFieldChange('repo_path', null)}
                disabled={!draft.repo_path}
              >
                清空
              </button>
            </div>
            <small className="dev-manager-field-hint">
              使用内置目录弹层懒加载浏览；这里只保存最终选中的开发版仓库路径。
            </small>
          </div>

          <div className="settings-field">
            <span>Node 版本</span>
            <select
              value={draft.nvm_version ?? ''}
              onChange={(event) => handleFieldChange('nvm_version', event.target.value || null)}
            >
              <option value="">保持系统默认</option>
              {snapshot.node_runtime.versions.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
            <small className={`dev-manager-field-hint ${hasDetectedNodeVersions ? '' : 'is-danger'}`}>
              {hasDetectedNodeVersions
                ? snapshot.node_runtime.manager === 'nvm-windows'
                  ? '下拉内容包含当前正在运行的 Node 版本，以及这台电脑上 nvm-windows 已安装的版本。'
                  : '下拉内容至少包含当前正在运行的 Node 版本；如果这台电脑安装了 nvm-windows，也会一并列出。'
                : snapshot.node_runtime.error || '当前没有检测到可用的 Node 版本。'}
            </small>
          </div>

          <label className="settings-field">
            <span>npm 令牌</span>
            <input
              type="password"
              value={npmTokenDraft}
              onChange={(event) => {
                setClearNpmToken(false)
                setNpmTokenDraft(event.target.value)
              }}
              placeholder={
                snapshot.credentials.has_npm_token
                  ? `已保存：${snapshot.credentials.npm_token_hint ?? '******'}`
                  : '输入新的 npm token'
              }
            />
          </label>

          <div className="settings-actions-row dev-manager-token-actions">
            <button
              type="button"
              className="settings-ghost-button"
              onClick={() => {
                setNpmTokenDraft('')
                setClearNpmToken(true)
              }}
            >
              清空令牌
            </button>
          </div>

          <label className="settings-field">
            <span>开发版 Hub 端口</span>
            <input
              type="number"
              value={draft.dev_hub_port ?? ''}
              onChange={(event) => handlePortChange('dev_hub_port', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>开发版 Agent 端口</span>
            <input
              type="number"
              value={draft.dev_agent_port ?? ''}
              onChange={(event) => handlePortChange('dev_agent_port', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>开发版 Web 端口</span>
            <input
              type="number"
              value={draft.dev_web_port ?? ''}
              onChange={(event) => handlePortChange('dev_web_port', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>开发版 Agent -&gt; Hub URL</span>
            <input
              type="text"
              value={draft.dev_agent_hub_url}
              onChange={(event) => handleFieldChange('dev_agent_hub_url', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>开发版 Agent 直连 URL</span>
            <input
              type="text"
              value={draft.dev_agent_direct_base_url}
              onChange={(event) => handleFieldChange('dev_agent_direct_base_url', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>开发版 Agent WS URL</span>
            <input
              type="text"
              value={draft.dev_agent_ws_base_url}
              onChange={(event) => handleFieldChange('dev_agent_ws_base_url', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>开发版 Agent 名称</span>
            <input
              type="text"
              value={draft.dev_agent_name}
              onChange={(event) => handleFieldChange('dev_agent_name', event.target.value)}
              placeholder="留空后默认显示为直连地址 host:port"
            />
          </label>

          <label className="settings-field">
            <span>开发版 Web -&gt; Hub URL</span>
            <input
              type="text"
              value={draft.dev_web_hub_url}
              onChange={(event) => handleFieldChange('dev_web_hub_url', event.target.value)}
            />
          </label>

          <label className="settings-field dev-manager-field--wide">
            <span>开发版 Hub 追加参数</span>
            <textarea
              value={draft.dev_hub_args}
              onChange={(event) => handleFieldChange('dev_hub_args', event.target.value)}
              placeholder="会直接追加到 corepack pnpm dev:hub 后面"
            />
          </label>

          <label className="settings-field dev-manager-field--wide">
            <span>开发版 Agent 追加参数</span>
            <textarea
              value={draft.dev_agent_args}
              onChange={(event) => handleFieldChange('dev_agent_args', event.target.value)}
              placeholder="会直接追加到 corepack pnpm dev:agent 后面"
            />
          </label>

          <label className="settings-field dev-manager-field--wide">
            <span>开发版 Web 追加参数</span>
            <textarea
              value={draft.dev_web_args}
              onChange={(event) => handleFieldChange('dev_web_args', event.target.value)}
              placeholder="会直接追加到开发版 Web 的 vite 命令后面"
            />
          </label>

          <div className="dev-manager-form-section dev-manager-field--wide">
            <strong>正式版自动恢复配置</strong>
            <p>这些配置不是给当前已运行的正式版实时改端口，而是点击“重启正式版”后，后台助手用它重新拉起正式版 Hub + Agent。</p>
          </div>

          <label className="settings-field">
            <span>正式版 Hub 端口（自动恢复）</span>
            <input
              type="number"
              value={draft.release_hub_port ?? ''}
              onChange={(event) => handlePortChange('release_hub_port', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>正式版 Agent 端口（自动恢复）</span>
            <input
              type="number"
              value={draft.release_agent_port ?? ''}
              onChange={(event) => handlePortChange('release_agent_port', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>正式版 Hub 服务名</span>
            <input
              type="text"
              value={draft.release_hub_service_name}
              onChange={(event) => handleFieldChange('release_hub_service_name', event.target.value)}
              placeholder="PandaHub"
            />
          </label>

          <label className="settings-field">
            <span>正式版 Agent 服务名</span>
            <input
              type="text"
              value={draft.release_agent_service_name}
              onChange={(event) => handleFieldChange('release_agent_service_name', event.target.value)}
              placeholder="PandaAgent"
            />
          </label>

          <label className="settings-field">
            <span>正式版 Agent -&gt; Hub URL（自动恢复）</span>
            <input
              type="text"
              value={draft.release_agent_hub_url}
              onChange={(event) => handleFieldChange('release_agent_hub_url', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>正式版 Agent 直连 URL（自动恢复）</span>
            <input
              type="text"
              value={draft.release_agent_direct_base_url}
              onChange={(event) => handleFieldChange('release_agent_direct_base_url', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>正式版 Agent WS URL（自动恢复）</span>
            <input
              type="text"
              value={draft.release_agent_ws_base_url}
              onChange={(event) => handleFieldChange('release_agent_ws_base_url', event.target.value)}
            />
          </label>

          <label className="settings-field">
            <span>正式版 Agent 名称（自动恢复）</span>
            <input
              type="text"
              value={draft.release_agent_name}
              onChange={(event) => handleFieldChange('release_agent_name', event.target.value)}
              placeholder="留空后默认显示为直连地址 host:port"
            />
          </label>

          <label className="settings-field dev-manager-field--wide">
            <span>正式版 Hub 追加参数（自动恢复）</span>
            <textarea
              value={draft.release_hub_args}
              onChange={(event) => handleFieldChange('release_hub_args', event.target.value)}
              placeholder="会直接追加到 panda hub 后面"
            />
          </label>

          <label className="settings-field dev-manager-field--wide">
            <span>正式版 Agent 追加参数（自动恢复）</span>
            <textarea
              value={draft.release_agent_args}
              onChange={(event) => handleFieldChange('release_agent_args', event.target.value)}
              placeholder="会直接注入 panda agent 命令后面"
            />
          </label>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">开发版运行控制</h3>
            <p className="settings-panel__subtitle">启动、重启、停止开发版 Hub / Agent / Web。进入页面默认不做探测，点击状态测试后仅按端口连通性快速判断。</p>
          </div>
          <div className="settings-actions-row">
            <button
              type="button"
              className="settings-inline-action"
              onClick={() => void actionMutation.mutateAsync('start-development')}
              disabled={isActionBusy}
            >
              {currentAction === 'start-development' && actionMutation.isPending ? '启动中…' : '启动'}
            </button>
            <button
              type="button"
              className="settings-inline-action"
              onClick={() => void actionMutation.mutateAsync('restart-development')}
              disabled={isActionBusy}
            >
              {currentAction === 'restart-development' && actionMutation.isPending ? '重启中…' : '重启'}
            </button>
            <button
              type="button"
              className="settings-ghost-button"
              onClick={() => void actionMutation.mutateAsync('stop-development')}
              disabled={isActionBusy}
            >
              {currentAction === 'stop-development' && actionMutation.isPending ? '停止中…' : '停止'}
            </button>
            <button
              type="button"
              className="settings-ghost-button"
              onClick={() => void actionMutation.mutateAsync('probe-development')}
              disabled={isActionBusy}
            >
              {currentAction === 'probe-development' && actionMutation.isPending ? '测试中…' : '状态测试'}
            </button>
          </div>
        </div>

        <div className="dev-manager-service-grid">
          {devServices.map((service) => (
            <article key={service.key} className={`settings-diagnostic-list__item dev-manager-service-card is-${service.status}`}>
              <strong>{service.label}</strong>
              <span>
                上次测试：
                {' '}
                <strong className={probeResultTone(service.probe?.ok)}>{probeResultLabel(service.probe?.ok)}</strong>
              </span>
              <span>端口：{service.configured_port ?? '未配置'}</span>
              {service.detected_pids.length > 0 ? (
                <span>PID：{service.detected_pids.join(', ')}</span>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">npm 发布、安装与正式版恢复</h3>
            <p className="settings-panel__subtitle">发布最新 npm 包后，可以单独安装正式版包，再按服务优先重启正式版 Hub + Agent。</p>
          </div>
          <div className="settings-actions-row">
            <button
              type="button"
              className="settings-inline-action"
              onClick={() => void actionMutation.mutateAsync('publish-npm')}
              disabled={actionMutation.isPending}
            >
              {currentAction === 'publish-npm' && actionMutation.isPending ? '发布中…' : '发布'}
            </button>
            <button
              type="button"
              className="settings-ghost-button"
              onClick={() => void actionMutation.mutateAsync('install-latest-release-package')}
              disabled={actionMutation.isPending}
            >
              {currentAction === 'install-latest-release-package' && actionMutation.isPending
                ? '安装中…'
                : '安装'}
            </button>
            <button
              type="button"
              className="settings-ghost-button"
              onClick={() => void actionMutation.mutateAsync('restart-release-services')}
              disabled={actionMutation.isPending}
            >
              {currentAction === 'restart-release-services' && actionMutation.isPending
                ? '重启中…'
                : '重启'}
            </button>
            <button
              type="button"
              className="settings-ghost-button"
              onClick={() => void actionMutation.mutateAsync('install-release-services')}
              disabled={actionMutation.isPending}
            >
              {currentAction === 'install-release-services' && actionMutation.isPending
                ? '注册中…'
                : '注册/更新服务'}
            </button>
            <button
              type="button"
              className="settings-ghost-button"
              onClick={() => void actionMutation.mutateAsync('uninstall-release-services')}
              disabled={actionMutation.isPending}
            >
              {currentAction === 'uninstall-release-services' && actionMutation.isPending
                ? '移除中…'
                : '移除服务'}
            </button>
          </div>
        </div>

        <div className="settings-meta">
          <span>当前正式版版本</span>
          <span>{snapshot.current_version ?? '未检测到'}</span>
        </div>
        <div className="settings-meta">
          <span>最近 npm 发布</span>
          <span className={latestPublishJob ? jobStatusTone(latestPublishJob.status) : 'is-muted'}>
            {latestPublishJob ? jobStatusLabel(latestPublishJob.status) : '未执行'}
          </span>
        </div>
        <div className="settings-meta">
          <span>最近正式版安装</span>
          <span className={latestReleasePackageInstallJob ? jobStatusTone(latestReleasePackageInstallJob.status) : 'is-muted'}>
            {latestReleasePackageInstallJob ? jobStatusLabel(latestReleasePackageInstallJob.status) : '未执行'}
          </span>
        </div>
        <div className="settings-meta">
          <span>最近正式版恢复</span>
          <span className={latestReleaseRestartJob ? jobStatusTone(latestReleaseRestartJob.status) : 'is-muted'}>
            {latestReleaseRestartJob ? jobStatusLabel(latestReleaseRestartJob.status) : '未执行'}
          </span>
        </div>
        <div className="settings-meta">
          <span>最近服务注册</span>
          <span className={latestReleaseServiceInstallJob ? jobStatusTone(latestReleaseServiceInstallJob.status) : 'is-muted'}>
            {latestReleaseServiceInstallJob ? jobStatusLabel(latestReleaseServiceInstallJob.status) : '未执行'}
          </span>
        </div>
        <div className="settings-meta">
          <span>最近服务移除</span>
          <span className={latestReleaseServiceUninstallJob ? jobStatusTone(latestReleaseServiceUninstallJob.status) : 'is-muted'}>
            {latestReleaseServiceUninstallJob ? jobStatusLabel(latestReleaseServiceUninstallJob.status) : '未执行'}
          </span>
        </div>
        {releaseServices.map((service) => (
          <article key={service.key} className={`settings-diagnostic-list__item dev-manager-service-card is-${service.status}`}>
            <strong>{service.label}</strong>
            <span>
              当前模式：
              {' '}
              <strong>{service.manager === 'windows-service' ? 'Windows 服务' : '普通进程'}</strong>
            </span>
            <span>服务名：{service.service_name ?? '未配置'}</span>
            <span>
              服务控制器：
              {' '}
              <strong className={service.service_registered ? '' : 'is-muted'}>
                {serviceControllerLabel(service.service_registered ? service.service_status : 'missing')}
              </strong>
            </span>
            <span>
              探测结果：
              {' '}
              <strong className={probeResultTone(service.probe?.ok)}>
                {probeResultLabel(service.probe?.ok)}
              </strong>
            </span>
            <span>端口：{service.configured_port ?? '未配置'}</span>
          </article>
        ))}
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">APK 编译与下载</h3>
            <p className="settings-panel__subtitle">直接用开发版源码产出 release APK，并提供下载入口。</p>
          </div>
          <div className="settings-actions-row">
            <button
              type="button"
              className="settings-inline-action"
              onClick={() => void actionMutation.mutateAsync('build-apk')}
              disabled={actionMutation.isPending}
            >
              {currentAction === 'build-apk' && actionMutation.isPending ? '编译中…' : '编译 APK'}
            </button>
            <button
              type="button"
              className="settings-ghost-button"
              onClick={() => void handleDownloadApk()}
              disabled={!snapshot.apk_artifact}
            >
              下载 APK
            </button>
          </div>
        </div>

        <div className="settings-meta">
          <span>最近构建时间</span>
          <span>{snapshot.apk_artifact ? formatTimestamp(snapshot.apk_artifact.built_at) : '尚未构建'}</span>
        </div>
        <div className="settings-meta">
          <span>版本</span>
          <span>
            {snapshot.apk_artifact
              ? `${snapshot.apk_artifact.version_name ?? '未知'}${snapshot.apk_artifact.version_code ? ` (${snapshot.apk_artifact.version_code})` : ''}`
              : '尚未构建'}
          </span>
        </div>
        <div className="settings-meta">
          <span>文件大小</span>
          <span>{snapshot.apk_artifact ? formatBytes(snapshot.apk_artifact.size_bytes) : '尚未构建'}</span>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">任务日志</h3>
            <p className="settings-panel__subtitle">这里只显示最近一次任务的日志；更早的历史记录仍会保留在后台状态文件中。</p>
          </div>
        </div>

        {statusMessage ? <p className="settings-block__status">{statusMessage}</p> : null}
        {activeJob ? (
          <div className="settings-meta">
            <span>当前运行中</span>
            <span>{activeJob.title} · {jobStatusLabel(activeJob.status)}</span>
          </div>
        ) : null}
        {visibleJob ? (
          <div className="settings-log-list">
            <article key={visibleJob.id} className="settings-log-item dev-manager-job">
              <div className="settings-log-item__meta">
                <strong>{visibleJob.title}</strong>
                <span>{formatTimestamp(visibleJob.started_at ?? visibleJob.created_at)}</span>
              </div>
              <div className={`settings-log-item__kind ${jobStatusTone(visibleJob.status)}`}>
                {jobStatusLabel(visibleJob.status)}
                {visibleJob.disconnect_expected ? ' · 会中断连接' : ''}
              </div>
              {visibleJob.summary ? <div className="dev-manager-job__summary">{visibleJob.summary}</div> : null}
              {visibleJob.logs.length > 0 ? (
                <pre className="settings-log-item__detail">
                  {visibleJob.logs
                    .slice(-16)
                    .map((entry) => `[${formatTimestamp(entry.timestamp)}] ${entry.message}`)
                    .join('\n')}
                </pre>
              ) : null}
            </article>
          </div>
        ) : (
          <p className="settings-block__status">还没有开发版管理任务记录。</p>
        )}
      </section>

      {isDirectoryPickerOpen && agentId ? (
        <SettingsDirectoryPathPicker
          agentId={agentId}
          initialPath={draft.repo_path}
          onClose={() => setIsDirectoryPickerOpen(false)}
          onSelect={handleSelectRepoPath}
        />
      ) : null}
    </div>
  )
}
