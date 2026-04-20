import { Fragment, useEffect, useState, type CSSProperties, type DragEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HubConnectionForm } from '../shared/hub-connection-form'
import { DevManagerPanel } from './dev-manager-panel'
import { readHubUrl, resolveConnectionTarget } from '../../lib/client'
import {
  buildAndroidReleaseManifestUrl,
  isAndroidReleaseAvailable,
  openAndroidReleaseDownload,
  readAndroidReleaseManifest,
  readInstalledAppInfo,
} from '../../lib/app-update'
import {
  probeBackendConnection,
  type ConnectionProbeResult,
} from '../../lib/connection-probe'
import {
  createSessionManagedModelOption,
  readStoredCommandExecutionModel,
  readStoredSessionModel,
  readStoredTitleGenerationModel,
  type SessionManagedModelOption,
  writeStoredCommandExecutionModel,
  writeStoredSessionModel,
  writeStoredSessionModelOptions,
  writeStoredTitleGenerationModel,
} from '../../lib/session-composer-preferences'
import {
  clampCodeFontSize,
  clampUiFontSize,
  DARK_THEME_PRESETS,
  LIGHT_THEME_PRESETS,
  type ThemeMode,
} from '../../lib/theme'
import { clearSiteData } from '../../lib/site-data'
import {
  canUseWebPushNotifications,
  disableCompletionWebPushNotifications,
  enableCompletionWebPushNotifications,
  hasActiveWebPushRegistrationHint,
  isAndroidDevice,
  isPwaInstalled,
  readCompletionNotificationPermission,
  refreshCompletionNotificationPermission,
  readStoredCompletionNotificationSettings,
  showCompletionNotification,
  sendCompletionWebPushTestNotification,
  syncCompletionWebPushSubscription,
  requestCompletionNotificationPermission,
  writeStoredCompletionNotificationSettings,
  type CompletionNotificationSettings,
} from '../../lib/notifications'
import {
  appendPwaInstallLog,
  clearPwaInstallLogs,
  collectPwaInstallDiagnostics,
  type PwaInstallDiagnostics,
} from '../../lib/pwa-install-diagnostics'
import {
  readStoredAgentId,
  readStoredSessionId,
  writeStoredAgentId,
  writeStoredSessionId,
} from '../../lib/session-selection'
import { useSessionModelOptions } from '../../lib/use-session-model-options'
import { useHubDirectory } from '../../lib/use-hub-directory'
import {
  getCodexCommandsQueryKey,
  useCodexCommands,
} from '../../lib/use-codex-commands'
import { resetRuntimeConnectionState } from '../../lib/runtime-connection-reset'
import { useRuntimeConfig, writeRuntimeConfig } from '../../lib/runtime-config'
import { useUiStore } from '../../store/ui-store'

type SettingsSection =
  | 'theme'
  | 'models'
  | 'cache'
  | 'notifications'
  | 'installation'
  | 'connection'
  | 'dev-manager'
type ModelDropPosition = 'before' | 'after'
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed'
    platform: string
  }>
}

type ConnectionProbe = ConnectionProbeResult & {
  label: string
}

const DESKTOP_SETTINGS_BREAKPOINT = 980

type SettingsPageProps = {
  mode?: 'page' | 'overlay'
  onRequestClose?: () => void
}

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection
  title: string
  description: string
  icon:
    | 'theme'
    | 'models'
    | 'cache'
    | 'notifications'
    | 'installation'
    | 'connection'
    | 'dev-manager'
}> = [
  {
    id: 'theme',
    title: '主题',
    description: '调整界面的颜色风格。',
    icon: 'theme',
  },
  {
    id: 'models',
    title: '模型维护',
    description: '维护可选模型、默认模型和展示顺序。',
    icon: 'models',
  },
  {
    id: 'cache',
    title: '缓存',
    description: '解决页面没更新的问题。',
    icon: 'cache',
  },
  {
    id: 'notifications',
    title: '移动提醒',
    description: '安装到桌面，并在对话完成后接收系统通知。',
    icon: 'notifications',
  },
  {
    id: 'installation',
    title: '安装诊断',
    description: '判断当前是不是安装版，并分析为什么安装失败。',
    icon: 'installation',
  },
  {
    id: 'connection',
    title: '连接状态',
    description: '查看现在连到哪台设备。',
    icon: 'connection',
  },
  {
    id: 'dev-manager',
    title: '开发版管理',
    description: '维护开发版、npm 发布、自升级和 APK 编译下载。',
    icon: 'dev-manager',
  },
]

const MOBILE_SETTINGS_GROUPS: Array<{
  id: string
  label: string
  sections: SettingsSection[]
}> = [
  {
    id: 'appearance',
    label: '外观与模型',
    sections: ['theme', 'models', 'cache'],
  },
  {
    id: 'notifications',
    label: '提醒与安装',
    sections: ['notifications', 'installation'],
  },
  {
    id: 'connection',
    label: '连接与设备',
    sections: ['connection', 'dev-manager'],
  },
]

const THEME_MODE_OPTIONS: Array<{
  value: ThemeMode
  label: string
  icon: 'sun' | 'moon' | 'system'
}> = [
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
  { value: 'system', label: '系统', icon: 'system' },
]

const previewCode = (
  codeThemeId: string,
  accent: string,
  contrast: number,
  opaqueWindows: boolean,
) => [
  'const pandaTheme = {',
  `  codeThemeId: "${codeThemeId}",`,
  `  accent: "${accent.toLowerCase()}",`,
  `  contrast: ${contrast},`,
  `  opaqueWindows: ${opaqueWindows},`,
  '}',
]

const IconArrowLeft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 6-6 6 6 6" />
  </svg>
)

const IconChevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={open ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
  </svg>
)

const IconGrip = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
  </svg>
)

const IconPlus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
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

const IconArrowUp = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 6-5 5M12 6l5 5M12 6v12" />
  </svg>
)

const IconArrowDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 18-5-5M12 18l5-5M12 18V6" />
  </svg>
)

const SectionIcon = ({
  icon,
}: {
  icon:
    | 'theme'
    | 'models'
    | 'cache'
    | 'notifications'
    | 'installation'
    | 'connection'
    | 'dev-manager'
}) => {
  if (icon === 'cache') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 8.5C5 6.57 8.13 5 12 5s7 1.57 7 3.5S15.87 12 12 12 5 10.43 5 8.5Z" />
        <path d="M5 8.5v7c0 1.93 3.13 3.5 7 3.5s7-1.57 7-3.5v-7" />
        <path d="M5 12c0 1.93 3.13 3.5 7 3.5s7-1.57 7-3.5" />
      </svg>
    )
  }

  if (icon === 'models') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 7.5h14M5 12h14M5 16.5h14" />
        <path d="M8 5.5h.01M8 10h.01M8 14.5h.01" />
      </svg>
    )
  }

  if (icon === 'connection') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9.5 14.5a3.5 3.5 0 0 1 0-5l1.5-1.5a3.5 3.5 0 0 1 5 5L15 14" />
        <path d="M14.5 9.5a3.5 3.5 0 0 1 0 5L13 16a3.5 3.5 0 0 1-5-5L9 10" />
      </svg>
    )
  }

  if (icon === 'dev-manager') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3.75v4.5" />
        <path d="M12 15.75v4.5" />
        <path d="M3.75 12h4.5" />
        <path d="M15.75 12h4.5" />
        <path d="m6.7 6.7 3.1 3.1" />
        <path d="m14.2 14.2 3.1 3.1" />
        <path d="m17.3 6.7-3.1 3.1" />
        <path d="m9.8 14.2-3.1 3.1" />
        <circle cx="12" cy="12" r="2.9" />
      </svg>
    )
  }

  if (icon === 'notifications') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 5.25 1.9 6.83 1.9 6.83H4.6S6.5 14.75 6.5 9.5Z" />
        <path d="M10 18.25a2.1 2.1 0 0 0 4 0" />
      </svg>
    )
  }

  if (icon === 'installation') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3.75v10.5" />
        <path d="m8.5 10.75 3.5 3.5 3.5-3.5" />
        <path d="M5.25 16.75h13.5" />
        <path d="M6 19.25h12" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4.75v2.1M12 17.15v2.1M4.78 4.78l1.49 1.49M17.73 17.73l1.49 1.49M2.75 12h2.1M19.15 12h2.1M4.78 19.22l1.49-1.49M17.73 6.27l1.49-1.49" />
      <circle cx="12" cy="12" r="3.85" />
    </svg>
  )
}

const ThemeIcon = ({
  icon,
  active,
}: {
  icon: 'sun' | 'moon' | 'system'
  active?: boolean
}) => {
  const strokeWidth = active ? 2 : 1.8

  if (icon === 'sun') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.1" />
        <path d="M12 2.75v2.1M12 19.15v2.1M4.78 4.78l1.49 1.49M17.73 17.73l1.49 1.49M2.75 12h2.1M19.15 12h2.1M4.78 19.22l1.49-1.49M17.73 6.27l1.49-1.49" />
      </svg>
    )
  }

  if (icon === 'moon') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20.2 14.1A8.5 8.5 0 1 1 9.9 3.8a6.9 6.9 0 0 0 10.3 10.3Z" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="12" rx="2.4" />
      <path d="M8 19h8" />
    </svg>
  )
}

const ThemePreviewPanel = ({
  title,
  caption,
  accent,
  background,
  foreground,
  lines,
}: {
  title: string
  caption: string
  accent: string
  background: string
  foreground: string
  lines: string[]
}) => (
  <div
    className="theme-preview-panel"
    style={
      {
        '--preview-accent': accent,
        '--preview-background': background,
        '--preview-foreground': foreground,
      } as CSSProperties
    }
  >
    <div className="theme-preview-panel__meta">
      <span>{title}</span>
      <span>{caption}</span>
    </div>
    <pre className="theme-preview-panel__code" aria-label={`${title} 主题预览`}>
      {lines.map((line) => (
        <code key={line}>{line}</code>
      ))}
    </pre>
  </div>
)

const ThemeColorRow = ({
  label,
  value,
}: {
  label: string
  value: string
}) => (
  <div className="settings-row settings-row--token">
    <div className="settings-row__copy">
      <span className="settings-row__label">{label}</span>
    </div>
    <div className="theme-token">
      <span className="theme-token__swatch" style={{ '--token-color': value } as CSSProperties} />
      <span>{value}</span>
    </div>
  </div>
)

const ThemeMetaRow = ({
  label,
  value,
}: {
  label: string
  value: string
}) => (
  <div className="settings-row settings-row--token">
    <div className="settings-row__copy">
      <span className="settings-row__label">{label}</span>
    </div>
    <div className="theme-token">{value}</div>
  </div>
)

const FontTokenRow = ({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) => (
  <div className="settings-row settings-row--token">
    <div className="settings-row__copy">
      <span className="settings-row__label">{label}</span>
    </div>
    <div className={`theme-token theme-token--font ${mono ? 'is-mono' : ''}`}>{value}</div>
  </div>
)

const SizeRow = ({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string
  value: number
  onChange: (nextValue: number) => void
  min: number
  max: number
}) => (
  <div className="settings-row settings-row--size">
    <div className="settings-row__copy">
      <span className="settings-row__label">{label}</span>
    </div>
    <div className="theme-stepper">
      <button type="button" className="theme-stepper__button" onClick={() => onChange(value - 1)} aria-label={`${label} 减小 1px`}>
        -
      </button>
      <label className="theme-stepper__input-wrap">
        <input
          className="theme-stepper__input"
          type="number"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span>px</span>
      </label>
      <button type="button" className="theme-stepper__button" onClick={() => onChange(value + 1)} aria-label={`${label} 增大 1px`}>
        +
      </button>
    </div>
  </div>
)

const moveModelOption = (
  options: SessionManagedModelOption[],
  sourceId: string,
  targetId: string,
  position: ModelDropPosition,
) => {
  if (sourceId === targetId) {
    return options
  }

  const sourceIndex = options.findIndex((option) => option.id === sourceId)
  const targetIndex = options.findIndex((option) => option.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0) {
    return options
  }

  const nextOptions = [...options]
  const [movedOption] = nextOptions.splice(sourceIndex, 1)
  if (!movedOption) {
    return options
  }

  const baseTargetIndex = nextOptions.findIndex((option) => option.id === targetId)
  const insertIndex = position === 'before' ? baseTargetIndex : baseTargetIndex + 1
  nextOptions.splice(insertIndex, 0, movedOption)
  return nextOptions
}

const formatDiagnosticTimestamp = (value: string | null | undefined) => {
  if (!value) {
    return '未记录'
  }

  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    return value
  }

  return timestamp.toLocaleString('zh-CN', {
    hour12: false,
  })
}

const formatConnectionLatency = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '未测得'
  }

  return `${Math.max(0, Math.round(value))} ms`
}

const probeConnection = async (label: string, url: string): Promise<ConnectionProbe> => {
  const result = await probeBackendConnection(url)
  return {
    label,
    ...result,
  }
}

export const SettingsPage = ({
  mode = 'page',
  onRequestClose,
}: SettingsPageProps = {}) => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const runtimeConfig = useRuntimeConfig()
  const { data: snapshot } = useHubDirectory()
  const [isClearingCache, setIsClearingCache] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<SettingsSection>('theme')
  const [expandedMobileSection, setExpandedMobileSection] = useState<SettingsSection | null>(null)
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_SETTINGS_BREAKPOINT,
  )
  const [notificationSettings, setNotificationSettings] = useState<CompletionNotificationSettings>(
    () => readStoredCompletionNotificationSettings(),
  )
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() => readCompletionNotificationPermission())
  const [hasWebPushSupport, setHasWebPushSupport] = useState(() => canUseWebPushNotifications())
  const [hasActiveWebPushRegistration, setHasActiveWebPushRegistration] = useState(
    () => hasActiveWebPushRegistrationHint(),
  )
  const [isSyncingWebPush, setIsSyncingWebPush] = useState(false)
  const [isSendingTestPush, setIsSendingTestPush] = useState(false)
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstallingApp, setIsInstallingApp] = useState(false)
  const [isPwaReady, setIsPwaReady] = useState(() => isPwaInstalled())
  const [isAndroid, setIsAndroid] = useState(() => isAndroidDevice())
  const [installDiagnosticsVersion, setInstallDiagnosticsVersion] = useState(0)
  const themeSettings = useUiStore((state) => state.themeSettings)
  const resolvedTheme = useUiStore((state) => state.resolvedTheme)
  const systemAppearance = useUiStore((state) => state.systemAppearance)
  const setThemeMode = useUiStore((state) => state.setThemeMode)
  const setLightThemeId = useUiStore((state) => state.setLightThemeId)
  const setDarkThemeId = useUiStore((state) => state.setDarkThemeId)
  const setUiFontSize = useUiStore((state) => state.setUiFontSize)
  const setCodeFontSize = useUiStore((state) => state.setCodeFontSize)
  const managedModelOptions = useSessionModelOptions()
  const [preferredModelValue, setPreferredModelValue] = useState(() => readStoredSessionModel())
  const [commandExecutionModelValue, setCommandExecutionModelValue] = useState(
    () => readStoredCommandExecutionModel(),
  )
  const [titleGenerationModelValue, setTitleGenerationModelValue] = useState(
    () => readStoredTitleGenerationModel(),
  )
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [modelDraft, setModelDraft] = useState<SessionManagedModelOption>(() =>
    createSessionManagedModelOption(),
  )
  const [modelMessage, setModelMessage] = useState<string | null>(null)
  const [draggingModelId, setDraggingModelId] = useState<string | null>(null)
  const [modelDropTarget, setModelDropTarget] = useState<{
    modelId: string
    position: ModelDropPosition
  } | null>(null)

  const storedAgentId =
    typeof window === 'undefined'
      ? null
      : readStoredAgentId()
  const lastSessionId =
    typeof window === 'undefined'
      ? null
      : readStoredSessionId()

  const currentAgent =
    snapshot?.agents.find((agent) => agent.id === storedAgentId) ??
    snapshot?.agents[0]
  const currentAgentDirectUrl = currentAgent?.direct_base_url?.trim().replace(/\/+$/, '') ?? ''
  const isNativeShell = runtimeConfig.platform !== 'web'
  const isCacheSectionVisible =
    activeSection === 'cache' || expandedMobileSection === 'cache'
  const codexCommandsScope = currentAgent?.id
    ? { agentId: currentAgent.id }
    : undefined
  const codexCommandsQueryKey = getCodexCommandsQueryKey(codexCommandsScope)

  const connectionQuery = useQuery({
    queryKey: ['settings-connection', runtimeConfig.hubUrl, currentAgent?.id ?? '', currentAgentDirectUrl],
    queryFn: async () => {
      const target = await resolveConnectionTarget()
      const [activeProbe, hubProbe, agentProbe] = await Promise.all([
        probeConnection(target.label, target.baseUrl),
        probeConnection('Panda Hub', readHubUrl()),
        currentAgentDirectUrl
          ? probeConnection(currentAgent?.name ?? '当前节点', currentAgentDirectUrl)
          : Promise.resolve<ConnectionProbe | null>(null),
      ])

      return {
        modeLabel: target.mode === 'hub' ? '通过 Panda Hub' : '直接连接',
        backendLabel: target.label,
        backendUrl: target.baseUrl,
        healthOk: activeProbe.healthOk,
        latencyMs: activeProbe.latencyMs,
        checkedAt: activeProbe.checkedAt,
        activeProbe,
        hubProbe,
        agentProbe,
      }
    },
    enabled: activeSection === 'connection' || expandedMobileSection === 'connection',
    staleTime: 0,
    refetchOnWindowFocus: false,
  })

  const installedAppInfoQuery = useQuery({
    queryKey: ['installed-app-info', runtimeConfig.platform],
    queryFn: () => readInstalledAppInfo(),
    enabled: isNativeShell,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })

  const androidReleaseQuery = useQuery({
    queryKey: ['android-release-manifest', runtimeConfig.hubUrl],
    queryFn: () => readAndroidReleaseManifest(runtimeConfig.hubUrl),
    enabled:
      runtimeConfig.platform === 'android' &&
      Boolean(runtimeConfig.hubUrl) &&
      (activeSection === 'connection' || expandedMobileSection === 'connection'),
    staleTime: 0,
    refetchOnWindowFocus: false,
  })

  const codexCommandsQuery = useCodexCommands({
    enabled: isCacheSectionVisible && Boolean(codexCommandsScope),
    scope: codexCommandsScope,
  })

  const refreshInstallDiagnostics = () => {
    setInstallDiagnosticsVersion((value) => value + 1)
  }

  const installDiagnosticsQuery = useQuery<PwaInstallDiagnostics>({
    queryKey: [
      'pwa-install-diagnostics',
      installDiagnosticsVersion,
      Boolean(installPromptEvent),
      isPwaReady,
    ],
    queryFn: async () =>
      collectPwaInstallDiagnostics({
        installPromptAvailable: Boolean(installPromptEvent),
      }),
    enabled:
      activeSection === 'installation' || expandedMobileSection === 'installation',
    staleTime: 0,
    refetchOnWindowFocus: false,
  })

  const refreshCodexCommandsMutation = useMutation({
    mutationFn: async () => {
      if (!codexCommandsScope) {
        throw new Error('当前没有可用节点，无法刷新命令目录。')
      }

      const target = await resolveConnectionTarget(codexCommandsScope)
      return target.client.refreshCodexCommands()
    },
    onMutate: () => {
      setStatusMessage(null)
    },
    onSuccess: (catalog) => {
      queryClient.setQueryData(codexCommandsQueryKey, catalog)
      setStatusMessage(
        `命令目录已刷新，共 ${catalog.commands.length} 条，CLI 版本 ${catalog.cli_version ?? '未知'}。`,
      )
    },
    onError: (error) => {
      setStatusMessage(
        error instanceof Error ? error.message : '刷新命令目录失败。',
      )
    },
  })

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleResize = () => {
      const nextIsDesktop = window.innerWidth >= DESKTOP_SETTINGS_BREAKPOINT
      setIsDesktop(nextIsDesktop)
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    setStatusMessage(null)
  }, [connectionQuery.data?.backendUrl])

  useEffect(() => {
    if (isDesktop) {
      setExpandedMobileSection(activeSection)
    }
  }, [activeSection, isDesktop])

  useEffect(() => {
    setModelMessage(null)
  }, [activeSection])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPromptEvent(event as BeforeInstallPromptEvent)
      appendPwaInstallLog({
        kind: 'beforeinstallprompt',
        message: '浏览器提供了可调用的安装事件。',
        detail: window.location.href,
      })
      refreshInstallDiagnostics()
    }

    const handleAppInstalled = () => {
      setInstallPromptEvent(null)
      setIsPwaReady(true)
      setNotificationMessage('应用已安装到桌面。')
      appendPwaInstallLog({
        kind: 'appinstalled',
        message: '站点收到 appinstalled 事件。',
        detail: '浏览器报告安装流程已经完成或被接受。',
      })
      refreshInstallDiagnostics()
    }

    const handleVisibilityChange = () => {
      setNotificationPermission(readCompletionNotificationPermission())
      setNotificationSettings(readStoredCompletionNotificationSettings())
      setIsPwaReady(isPwaInstalled())
      setIsAndroid(isAndroidDevice())
      appendPwaInstallLog({
        kind: 'visibilitychange',
        message: `页面切换为 ${document.visibilityState}。`,
        detail: `standalone=${isPwaInstalled() ? 'yes' : 'no'}`,
      })
      refreshInstallDiagnostics()
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (managedModelOptions.length === 0) {
      return
    }

    if (managedModelOptions.some((option) => option.value === preferredModelValue)) {
      return
    }

    const fallbackValue = managedModelOptions[0].value
    writeStoredSessionModel(fallbackValue)
    setPreferredModelValue(fallbackValue)
  }, [managedModelOptions, preferredModelValue])

  useEffect(() => {
    if (managedModelOptions.length === 0) {
      return
    }

    if (managedModelOptions.some((option) => option.value === commandExecutionModelValue)) {
      return
    }

    const fallbackValue =
      managedModelOptions.find((option) => option.value === 'gpt-5.4-mini')?.value ??
      managedModelOptions[0].value
    writeStoredCommandExecutionModel(fallbackValue)
    setCommandExecutionModelValue(fallbackValue)
  }, [commandExecutionModelValue, managedModelOptions])

  useEffect(() => {
    if (managedModelOptions.length === 0) {
      return
    }

    if (managedModelOptions.some((option) => option.value === titleGenerationModelValue)) {
      return
    }

    const fallbackValue =
      managedModelOptions.find((option) => option.value === 'gpt-5.4-mini')?.value ??
      managedModelOptions[0].value
    writeStoredTitleGenerationModel(fallbackValue)
    setTitleGenerationModelValue(fallbackValue)
  }, [managedModelOptions, titleGenerationModelValue])

  useEffect(() => {
    const refreshNotificationEnvironment = () => {
      void refreshCompletionNotificationPermission()
        .then((permission) => {
          setNotificationPermission(permission)
        })
        .catch(() => {
          setNotificationPermission(readCompletionNotificationPermission())
        })
      setHasWebPushSupport(canUseWebPushNotifications())
      setHasActiveWebPushRegistration(hasActiveWebPushRegistrationHint())
    }

    refreshNotificationEnvironment()
    window.addEventListener('focus', refreshNotificationEnvironment)
    document.addEventListener('visibilitychange', refreshNotificationEnvironment)

    return () => {
      window.removeEventListener('focus', refreshNotificationEnvironment)
      document.removeEventListener('visibilitychange', refreshNotificationEnvironment)
    }
  }, [])

  useEffect(() => {
    if (
      notificationPermission !== 'granted' ||
      !notificationSettings.completionNotificationsEnabled ||
      !hasWebPushSupport
    ) {
      return
    }

    let cancelled = false
    setIsSyncingWebPush(true)
    void syncCompletionWebPushSubscription(notificationSettings)
      .then((result) => {
        if (cancelled) {
          return
        }

        setHasActiveWebPushRegistration(result.synced)
      })
      .catch(() => {
        if (cancelled) {
          return
        }

        setHasActiveWebPushRegistration(false)
      })
      .finally(() => {
        if (!cancelled) {
          setIsSyncingWebPush(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    hasWebPushSupport,
    notificationPermission,
    notificationSettings,
  ])

  const handleBack = () => {
    if (mode === 'overlay') {
      onRequestClose?.()
      return
    }

    if (lastSessionId) {
      writeStoredAgentId(currentAgent?.id ?? null)
      writeStoredSessionId(lastSessionId)
      void navigate({ to: '/' })
      return
    }

    void navigate({ to: '/nodes' })
  }

  const navigateFromSettings = (to: '/' | '/nodes' | '/diagnostics') => {
    if (mode === 'overlay') {
      onRequestClose?.()
    }

    void navigate({ to })
  }

  const handleClearCache = async () => {
    setStatusMessage(null)
    setIsClearingCache(true)

    try {
      await clearSiteData()
      setStatusMessage('缓存已清理，正在重新载入…')
      window.setTimeout(() => {
        window.location.replace(`/settings?cache-reset=${Date.now()}`)
      }, 180)
    } catch {
      setIsClearingCache(false)
      setStatusMessage('清理失败，请在浏览器设置中手动清理站点数据。')
    }
  }

  const handleNotificationToggle = async () => {
    setNotificationMessage(null)

    if (isNativeShell) {
      if (notificationPermission === 'granted') {
        setNotificationMessage(
          '当前已经拿到系统通知权限；完成提醒会自动跟随系统权限生效。',
        )
        return
      }

      const permission = await requestCompletionNotificationPermission()
      setNotificationPermission(permission)

      if (permission === 'granted') {
        const nextSettings = {
          completionNotificationsEnabled: true,
        }
        writeStoredCompletionNotificationSettings(nextSettings)
        setNotificationSettings(nextSettings)
        setNotificationMessage('系统通知已开启，后续任务完成会直接走原生通知。')
        return
      }

      if (permission === 'denied') {
        setNotificationMessage('系统通知已被拒绝，请到系统设置里重新开启。')
        return
      }

      setNotificationMessage('还没有拿到通知权限，可以稍后再试一次。')
      return
    }

    if (notificationPermission !== 'granted') {
      const permission = await requestCompletionNotificationPermission()
      setNotificationPermission(permission)

      if (permission === 'granted') {
        if (!hasWebPushSupport) {
          const nextSettings = {
            completionNotificationsEnabled: true,
          }
          writeStoredCompletionNotificationSettings(nextSettings)
          setNotificationSettings(nextSettings)
          setNotificationMessage(
            isNativeShell
              ? '系统通知已开启，任务完成时会直接走原生通知。'
              : '系统通知已开启，但当前环境不支持后台 Web Push。',
          )
          return
        }

        setIsSyncingWebPush(true)
        try {
          const nextSettings = {
            completionNotificationsEnabled: true,
          }
          await enableCompletionWebPushNotifications(nextSettings)
          writeStoredCompletionNotificationSettings(nextSettings)
          setNotificationSettings(nextSettings)
          setHasActiveWebPushRegistration(true)
          setNotificationMessage('系统通知和后台 Web Push 都已开启。')
          return
        } catch (error) {
          setHasActiveWebPushRegistration(false)
          setNotificationMessage(
            error instanceof Error
              ? error.message
              : '通知权限已开启，但 Web Push 订阅失败。',
          )
          return
        } finally {
          setIsSyncingWebPush(false)
        }
      }

      if (permission === 'denied') {
        setNotificationMessage('系统通知已被拒绝，请到浏览器或系统设置里重新开启。')
        return
      }

      setNotificationMessage('还没有拿到通知权限，可以稍后再试一次。')
      return
    }

    if (notificationSettings.completionNotificationsEnabled) {
      setIsSyncingWebPush(true)
      try {
        await disableCompletionWebPushNotifications()
        const nextSettings = {
          completionNotificationsEnabled: false,
        }
        writeStoredCompletionNotificationSettings(nextSettings)
        setNotificationSettings(nextSettings)
        setHasActiveWebPushRegistration(false)
        setNotificationMessage('完成提醒已关闭，后台推送订阅也已移除。')
      } catch (error) {
        setNotificationMessage(
          error instanceof Error ? error.message : '关闭 Web Push 订阅失败。',
        )
      } finally {
        setIsSyncingWebPush(false)
      }
      return
    }

    if (!hasWebPushSupport) {
      const nextSettings = {
        completionNotificationsEnabled: true,
      }
      writeStoredCompletionNotificationSettings(nextSettings)
      setNotificationSettings(nextSettings)
      setNotificationMessage(
        isNativeShell
          ? '原生通知已开启，后续会沿用当前 App 的在线事件提醒。'
          : '当前环境不支持后台 Web Push，只能在页面在线时提醒。',
      )
      return
    }

    setIsSyncingWebPush(true)
    try {
      const nextSettings = {
        completionNotificationsEnabled: true,
      }
      await enableCompletionWebPushNotifications(nextSettings)
      writeStoredCompletionNotificationSettings(nextSettings)
      setNotificationSettings(nextSettings)
      setHasActiveWebPushRegistration(true)
      setNotificationMessage('完成提醒已开启，Hub 会在会话完成后推送到这台手机。')
    } catch (error) {
      setHasActiveWebPushRegistration(false)
      setNotificationMessage(
        error instanceof Error ? error.message : '开启 Web Push 失败。',
      )
    } finally {
      setIsSyncingWebPush(false)
    }
  }

  const handleSendTestPush = async () => {
    setNotificationMessage(null)
    setIsSendingTestPush(true)

    try {
      if (isNativeShell) {
        await showCompletionNotification({
          sessionId: 'settings-test',
          completedAt: new Date().toISOString(),
          title: 'Panda 测试提醒',
          body: '这是一条来自 Android 壳的本地通知测试。',
          url: '/settings',
        })
        setNotificationMessage('测试通知已发出，请看当前设备的系统通知栏。')
        return
      }

      await sendCompletionWebPushTestNotification()
      setNotificationMessage('测试推送已发出，请看手机或当前设备的通知栏。')
    } catch (error) {
      setNotificationMessage(
        error instanceof Error ? error.message : '发送测试推送失败。',
      )
    } finally {
      setIsSendingTestPush(false)
    }
  }

  const handleInstallApp = async () => {
    if (!installPromptEvent) {
      appendPwaInstallLog({
        kind: 'install-unavailable',
        message: '当前页面没有可用的安装事件。',
        detail: isAndroid
          ? '浏览器没有下发 beforeinstallprompt，只能走菜单里的安装应用或添加到主屏幕。'
          : '当前浏览器没有提供可调用的安装对话框。',
      })
      refreshInstallDiagnostics()
      setNotificationMessage(
        isAndroid
          ? '请在浏览器菜单里选择“安装应用”或“添加到主屏幕”。'
          : '当前浏览器没有提供安装弹窗，请使用浏览器的“添加到主屏幕”。',
      )
      return
    }

    setIsInstallingApp(true)
    setNotificationMessage(null)
    appendPwaInstallLog({
      kind: 'install-button-click',
      message: '用户点击了设置页里的安装按钮。',
      detail: '准备调用浏览器安装对话框。',
    })
    refreshInstallDiagnostics()

    try {
      appendPwaInstallLog({
        kind: 'install-prompt-shown',
        message: '已调用浏览器安装对话框。',
        detail: '等待用户在系统安装弹窗里做出选择。',
      })
      await installPromptEvent.prompt()
      const choice = await installPromptEvent.userChoice
      appendPwaInstallLog({
        kind: 'install-choice',
        message:
          choice.outcome === 'accepted'
            ? '用户接受了安装请求。'
            : '用户取消了安装请求。',
        detail: `outcome=${choice.outcome}; platform=${choice.platform}`,
      })
      refreshInstallDiagnostics()
      if (choice.outcome === 'accepted') {
        setNotificationMessage('安装请求已提交，请回到桌面查看。')
      } else {
        setNotificationMessage('你取消了这次安装。')
      }
    } catch (error) {
      appendPwaInstallLog({
        kind: 'install-error',
        message: '调用浏览器安装流程时报错。',
        detail: error instanceof Error ? error.message : 'Unknown install error',
      })
      refreshInstallDiagnostics()
      setNotificationMessage('浏览器没有完成安装流程，请查看下方安装诊断。')
    } finally {
      setInstallPromptEvent(null)
      setIsInstallingApp(false)
      setIsPwaReady(isPwaInstalled())
      refreshInstallDiagnostics()
    }
  }

  const commitManagedModelOptions = (nextOptions: SessionManagedModelOption[]) => {
    writeStoredSessionModelOptions(nextOptions)
    if (!nextOptions.some((option) => option.value === preferredModelValue)) {
      const fallbackValue = nextOptions[0]?.value ?? ''
      if (fallbackValue) {
        writeStoredSessionModel(fallbackValue)
        setPreferredModelValue(fallbackValue)
      }
    }
    if (!nextOptions.some((option) => option.value === commandExecutionModelValue)) {
      const fallbackValue =
        nextOptions.find((option) => option.value === 'gpt-5.4-mini')?.value ??
        nextOptions[0]?.value ??
        ''
      if (fallbackValue) {
        writeStoredCommandExecutionModel(fallbackValue)
        setCommandExecutionModelValue(fallbackValue)
      }
    }
    if (!nextOptions.some((option) => option.value === titleGenerationModelValue)) {
      const fallbackValue =
        nextOptions.find((option) => option.value === 'gpt-5.4-mini')?.value ??
        nextOptions[0]?.value ??
        ''
      if (fallbackValue) {
        writeStoredTitleGenerationModel(fallbackValue)
        setTitleGenerationModelValue(fallbackValue)
      }
    }
  }

  const handleCreateModel = () => {
    setEditingModelId('new')
    setModelDraft(createSessionManagedModelOption())
    setModelMessage(null)
  }

  const handleEditModel = (option: SessionManagedModelOption) => {
    setEditingModelId(option.id)
    setModelDraft({ ...option })
    setModelMessage(null)
  }

  const handleCancelModelEdit = () => {
    setEditingModelId(null)
    setModelDraft(createSessionManagedModelOption())
    setModelMessage(null)
  }

  const handleSaveModel = () => {
    const trimmedLabel = modelDraft.label.trim()
    const trimmedValue = modelDraft.value.trim()
    if (!trimmedLabel || !trimmedValue) {
      setModelMessage('请填写显示名和模型 ID。')
      return
    }

    const duplicateValue = managedModelOptions.find(
      (option) =>
        option.value.toLowerCase() === trimmedValue.toLowerCase() &&
        option.id !== editingModelId,
    )
    if (duplicateValue) {
      setModelMessage(`模型 ID ${trimmedValue} 已存在。`)
      return
    }

    const nextOption: SessionManagedModelOption = {
      ...modelDraft,
      label: trimmedLabel,
      value: trimmedValue,
      description: modelDraft.description?.trim() || null,
    }
    const nextOptions =
      editingModelId === 'new'
        ? [...managedModelOptions, nextOption]
        : managedModelOptions.map((option) =>
            option.id === editingModelId ? nextOption : option,
          )
    commitManagedModelOptions(nextOptions)
    setEditingModelId(null)
    setModelDraft(createSessionManagedModelOption())
    setModelMessage(editingModelId === 'new' ? '模型已添加。' : '模型已更新。')
  }

  const handleDeleteModel = (modelId: string) => {
    const nextOptions = managedModelOptions.filter((option) => option.id !== modelId)
    if (nextOptions.length === 0) {
      setModelMessage('至少保留一个模型。')
      return
    }

    commitManagedModelOptions(nextOptions)
    if (editingModelId === modelId) {
      setEditingModelId(null)
      setModelDraft(createSessionManagedModelOption())
    }
    setModelMessage('模型已删除。')
  }

  const handleSetPreferredModel = (value: string) => {
    writeStoredSessionModel(value)
    setPreferredModelValue(value)
    setModelMessage(`默认模型已切换为 ${value}。`)
  }

  const handleSetCommandExecutionModel = (value: string) => {
    writeStoredCommandExecutionModel(value)
    setCommandExecutionModelValue(value)
    setModelMessage(`命令执行模型已切换为 ${value}。`)
  }

  const handleSetTitleGenerationModel = (value: string) => {
    writeStoredTitleGenerationModel(value)
    setTitleGenerationModelValue(value)
    setModelMessage(`标题生成模型已切换为 ${value}。`)
  }

  const handleMoveModel = (modelId: string, direction: 'up' | 'down') => {
    const index = managedModelOptions.findIndex((option) => option.id === modelId)
    if (index < 0) {
      return
    }

    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= managedModelOptions.length) {
      return
    }

    const target = managedModelOptions[targetIndex]
    if (!target) {
      return
    }

    commitManagedModelOptions(
      moveModelOption(
        managedModelOptions,
        modelId,
        target.id,
        direction === 'up' ? 'before' : 'after',
      ),
    )
  }

  const handleModelDragStart = (
    event: DragEvent<HTMLElement>,
    modelId: string,
  ) => {
    setDraggingModelId(modelId)
    setModelDropTarget(null)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', modelId)
  }

  const handleModelDragOver = (
    event: DragEvent<HTMLElement>,
    modelId: string,
  ) => {
    if (!draggingModelId || draggingModelId === modelId) {
      return
    }

    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    setModelDropTarget((current) =>
      current?.modelId === modelId && current.position === position
        ? current
        : { modelId, position },
    )
  }

  const handleModelDrop = (modelId: string) => {
    if (!draggingModelId || !modelDropTarget || modelDropTarget.modelId !== modelId) {
      return
    }

    commitManagedModelOptions(
      moveModelOption(
        managedModelOptions,
        draggingModelId,
        modelId,
        modelDropTarget.position,
      ),
    )
    setDraggingModelId(null)
    setModelDropTarget(null)
  }

  const handleModelDragEnd = () => {
    setDraggingModelId(null)
    setModelDropTarget(null)
  }

  const editableAppearance = resolvedTheme.appearance
  const editableThemes = editableAppearance === 'light'
    ? LIGHT_THEME_PRESETS
    : DARK_THEME_PRESETS
  const selectedThemeId = editableAppearance === 'light'
    ? themeSettings.lightThemeId
    : themeSettings.darkThemeId
  const selectedTheme = editableThemes.find((theme) => theme.id === selectedThemeId) ?? editableThemes[0]
  const activeTheme = resolvedTheme.activeTheme
  const previewLines = previewCode(
    selectedTheme.codeThemeId,
    selectedTheme.accent,
    selectedTheme.contrast,
    selectedTheme.opaqueWindows,
  )
  const themeStatusLabel = themeSettings.mode === 'system'
    ? `当前跟随系统：${systemAppearance === 'dark' ? '深色' : '浅色'}`
    : `当前固定为${resolvedTheme.appearance === 'dark' ? '深色' : '浅色'}模式`
  const selectedThemeUsageLabel = '当前正在显示'
  const selectedThemeWindowStyleLabel = selectedTheme.opaqueWindows ? '不透明窗口' : '半透明窗口'
  const activeSectionMeta = SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0]
  const pageStyle = {
    '--settings-mobile-sticky-safe-area': isNativeShell ? '0px' : 'var(--app-safe-area-top)',
  } as CSSProperties
  const selectedThemeSummary = `${selectedTheme.label} · ${selectedThemeWindowStyleLabel} · 对比度 ${selectedTheme.contrast}`
  const preferredModel =
    managedModelOptions.find((option) => option.value === preferredModelValue) ??
    managedModelOptions[0] ??
    null
  const commandExecutionModel =
    managedModelOptions.find((option) => option.value === commandExecutionModelValue) ??
    managedModelOptions.find((option) => option.value === 'gpt-5.4-mini') ??
    managedModelOptions[0] ??
    null
  const titleGenerationModel =
    managedModelOptions.find((option) => option.value === titleGenerationModelValue) ??
    managedModelOptions.find((option) => option.value === 'gpt-5.4-mini') ??
    managedModelOptions[0] ??
    null

  const getMobileSectionSummary = (section: SettingsSection) => {
    if (section === 'theme') {
      return resolvedTheme.activeTheme.label
    }

    if (section === 'models') {
      return preferredModel?.label ?? `${managedModelOptions.length} 个模型`
    }

    if (section === 'cache') {
      if (statusMessage) {
        return statusMessage
      }
      return codexCommandsQuery.data
        ? `${codexCommandsQuery.data.commands.length} 条命令`
        : '站点与命令目录'
    }

    if (section === 'notifications') {
      return notificationSettings.completionNotificationsEnabled
        ? '已开启'
        : '未开启'
    }

    if (section === 'installation') {
      return isPwaReady ? '已安装' : '检查状态'
    }

    if (connectionQuery.data?.healthOk) {
      return connectionQuery.data.modeLabel
    }

    return currentAgent?.name ?? '查看链路'
  }

  const renderMobileSections = () => (
    <div className="settings-mobile-layout">
      <div className="settings-mobile-sections" role="list" aria-label="设置分组">
        {MOBILE_SETTINGS_GROUPS.map((group) => (
          <section
            key={group.id}
            className="settings-mobile-group"
            aria-label={group.label}
          >
            {group.sections.map((sectionId) => {
              const section = SETTINGS_SECTIONS.find((item) => item.id === sectionId)
              if (!section) {
                return null
              }

              const isOpen = expandedMobileSection === section.id
              const summary = getMobileSectionSummary(section.id)

              return (
                <Fragment key={section.id}>
                  <button
                    type="button"
                    className={`settings-mobile-row ${isOpen ? 'is-active' : ''}`}
                    data-section={section.id}
                    onClick={() => {
                      setActiveSection(section.id)
                      setExpandedMobileSection((current) =>
                        current === section.id ? null : section.id,
                      )
                    }}
                    aria-expanded={isOpen}
                    aria-controls={`settings-mobile-detail-${section.id}`}
                  >
                    <span
                      className="settings-mobile-row__icon"
                      data-section={section.id}
                      aria-hidden="true"
                    >
                      <SectionIcon icon={section.icon} />
                    </span>
                    <span className="settings-mobile-row__copy">
                      <span className="settings-mobile-row__title">{section.title}</span>
                    </span>
                    <span className="settings-mobile-row__summary">{summary}</span>
                    <span className="settings-mobile-row__chevron" aria-hidden="true">
                      <IconChevron open={false} />
                    </span>
                  </button>

                  {isOpen ? (
                    <section
                      className="settings-mobile-detail settings-mobile-detail--inline"
                      id={`settings-mobile-detail-${section.id}`}
                    >
                      {renderSectionContent(section.id)}
                    </section>
                  ) : null}
                </Fragment>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )

  const renderThemeSection = () => (
    <div className="settings-content-stack">
      <section className="settings-panel settings-panel--hero">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">外观</h3>
            <p className="settings-panel__subtitle">
              先选浅色或深色，再挑一个你喜欢的风格。
            </p>
          </div>
        </div>

        <div className="settings-control-grid">
          <div className="settings-control-block settings-control-block--full">
            <span className="settings-control-block__label">显示方式</span>
            <div className="theme-mode-switch" role="tablist" aria-label="主题模式">
              {THEME_MODE_OPTIONS.map((option) => {
                const isActive = option.value === themeSettings.mode
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`theme-mode-switch__button ${isActive ? 'is-active' : ''}`}
                    onClick={() => setThemeMode(option.value)}
                    role="tab"
                    aria-selected={isActive}
                  >
                    <ThemeIcon icon={option.icon} active={isActive} />
                    <span>{option.label}</span>
                  </button>
                )
              })}
            </div>
            <p className="settings-control-block__hint">{themeStatusLabel}</p>
          </div>
        </div>
      </section>

      <div className="settings-theme-layout">
        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">{editableAppearance === 'light' ? '浅色风格' : '深色风格'}</h3>
            </div>
          </div>

          <div className="settings-theme-selector">
            <label className="settings-select settings-select--wide">
              <select
                value={selectedTheme.id}
                onChange={(event) => {
                  if (editableAppearance === 'light') {
                    setLightThemeId(event.target.value)
                    return
                  }

                  setDarkThemeId(event.target.value)
                }}
                aria-label={editableAppearance === 'light' ? '选择浅色主题' : '选择深色主题'}
              >
                {editableThemes.map((theme) => (
                  <option key={`${theme.variant}-${theme.id}`} value={theme.id}>
                    {theme.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="settings-theme-selector__summary">
              <div className="settings-theme-selector__swatches" aria-hidden="true">
                <span style={{ '--theme-card-color': selectedTheme.background } as CSSProperties} />
                <span style={{ '--theme-card-color': selectedTheme.foreground } as CSSProperties} />
                <span style={{ '--theme-card-color': selectedTheme.accent } as CSSProperties} />
                <span style={{ '--theme-card-color': selectedTheme.semanticColors.diffAdded } as CSSProperties} />
                <span style={{ '--theme-card-color': selectedTheme.semanticColors.diffRemoved } as CSSProperties} />
              </div>
              <div className="settings-theme-selector__copy">
                <strong>{selectedTheme.label}</strong>
                <span>{selectedThemeSummary}</span>
              </div>
              {selectedTheme.id === activeTheme.id && selectedTheme.variant === resolvedTheme.appearance ? (
                <span className="settings-theme-selector__badge">当前</span>
              ) : (
                <span className="settings-theme-selector__badge is-muted">已选</span>
              )}
            </div>
          </div>
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">风格细节</h3>
            </div>
            <div className="theme-status-badge">{selectedThemeUsageLabel}</div>
          </div>

          <ThemePreviewPanel
            title={editableAppearance === 'light' ? '浅色预览' : '深色预览'}
            caption={selectedTheme.label}
            accent={selectedTheme.accent}
            background={selectedTheme.background}
            foreground={selectedTheme.foreground}
            lines={previewLines}
          />

          <div className="settings-list">
            <ThemeMetaRow
              label="代码风格"
              value={selectedTheme.codeThemeId}
            />
            <ThemeMetaRow
              label="当前模式"
              value={selectedTheme.variant}
            />
            <ThemeMetaRow
              label="对比度"
              value={String(selectedTheme.contrast)}
            />
            <ThemeMetaRow
              label="面板质感"
              value={selectedThemeWindowStyleLabel}
            />
            <ThemeColorRow
              label="强调色"
              value={selectedTheme.accent}
            />
            <ThemeColorRow
              label="背景色"
              value={selectedTheme.background}
            />
            <ThemeColorRow
              label="文字色"
              value={selectedTheme.foreground}
            />
            <ThemeColorRow
              label="新增颜色"
              value={selectedTheme.semanticColors.diffAdded}
            />
            <ThemeColorRow
              label="删除颜色"
              value={selectedTheme.semanticColors.diffRemoved}
            />
            <ThemeColorRow
              label="特殊强调"
              value={selectedTheme.semanticColors.skill}
            />
            <FontTokenRow
              label="界面字体"
              value={selectedTheme.fonts.ui ?? 'null'}
            />
            <FontTokenRow
              label="代码字体"
              value={selectedTheme.fonts.code ?? 'null'}
              mono
            />
          </div>
        </section>
      </div>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">字号</h3>
          </div>
        </div>
        <div className="settings-list">
          <SizeRow
            label="界面字号"
            value={themeSettings.uiFontSize}
            onChange={(value) => setUiFontSize(clampUiFontSize(value))}
            min={11}
            max={18}
          />
          <SizeRow
            label="代码字号"
            value={themeSettings.codeFontSize}
            onChange={(value) => setCodeFontSize(clampCodeFontSize(value))}
            min={10}
            max={18}
          />
        </div>
      </section>
    </div>
  )

  const renderModelsSection = () => (
    <div className="settings-content-stack">
      <section className="settings-panel settings-panel--hero">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">模型列表</h3>
          </div>
          <button
            type="button"
            className="settings-inline-action"
            onClick={handleCreateModel}
          >
            <IconPlus />
            新增模型
          </button>
        </div>

        <div className="settings-summary-strip">
          <div className="settings-summary-strip__item">
            <span>首位模型</span>
            <strong>{managedModelOptions[0]?.label ?? '未配置'}</strong>
          </div>
          <div className="settings-summary-strip__item">
            <span>当前默认</span>
            <strong>{preferredModel?.label ?? '未配置'}</strong>
          </div>
          <div className="settings-summary-strip__item">
            <span>命令执行模型</span>
            <strong>{commandExecutionModel?.label ?? '未配置'}</strong>
          </div>
          <div className="settings-summary-strip__item">
            <span>标题生成模型</span>
            <strong>{titleGenerationModel?.label ?? '未配置'}</strong>
          </div>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">模型角色</h3>
          </div>
        </div>

        <div className="settings-model-editor__grid">
          <label className="settings-field">
            <span>默认模型</span>
            <select
              value={preferredModelValue}
              onChange={(event) => handleSetPreferredModel(event.target.value)}
            >
              {managedModelOptions.map((option) => (
                <option key={option.id} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>命令执行模型</span>
            <select
              value={commandExecutionModelValue}
              onChange={(event) => handleSetCommandExecutionModel(event.target.value)}
            >
              {managedModelOptions.map((option) => (
                <option key={option.id} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>标题生成模型</span>
            <select
              value={titleGenerationModelValue}
              onChange={(event) => handleSetTitleGenerationModel(event.target.value)}
            >
              {managedModelOptions.map((option) => (
                <option key={option.id} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">维护模型</h3>
          </div>
        </div>

        {modelMessage ? (
          <div className="settings-inline-status" role="alert">
            {modelMessage}
          </div>
        ) : null}

        <div className="settings-model-list" role="list" aria-label="模型列表">
          {managedModelOptions.map((option, index) => {
            const isDragging = draggingModelId === option.id
            const dropBefore =
              modelDropTarget?.modelId === option.id &&
              modelDropTarget.position === 'before'
            const dropAfter =
              modelDropTarget?.modelId === option.id &&
              modelDropTarget.position === 'after'
            const isPreferred = option.value === preferredModelValue

            return (
              <article
                key={option.id}
                className={`settings-model-card ${isDragging ? 'is-dragging' : ''} ${dropBefore ? 'is-drop-before' : ''} ${dropAfter ? 'is-drop-after' : ''}`}
                draggable
                onDragStart={(event) => handleModelDragStart(event, option.id)}
                onDragOver={(event) => handleModelDragOver(event, option.id)}
                onDrop={(event) => {
                  event.preventDefault()
                  handleModelDrop(option.id)
                }}
                onDragEnd={handleModelDragEnd}
                role="listitem"
              >
                <div className="settings-model-card__main">
                  <span className="settings-model-card__grip" aria-hidden="true">
                    <IconGrip />
                  </span>
                  <div className="settings-model-card__copy">
                    <div className="settings-model-card__title-row">
                      <strong>{option.label}</strong>
                      {isPreferred ? (
                        <span className="settings-model-card__badge">默认</span>
                      ) : null}
                    </div>
                    <code className="settings-model-card__value">{option.value}</code>
                  </div>
                </div>

                <div className="settings-model-card__actions">
                  <button
                    type="button"
                    className={`settings-mini-button settings-model-card__primary-action ${isPreferred ? 'is-active' : ''}`}
                    onClick={() => handleSetPreferredModel(option.value)}
                  >
                    设为默认
                  </button>
                  <div className="settings-model-card__icon-actions">
                    <button
                      type="button"
                      className="settings-icon-button"
                      onClick={() => handleMoveModel(option.id, 'up')}
                      disabled={index === 0}
                      aria-label={`上移 ${option.label}`}
                    >
                      <IconArrowUp />
                    </button>
                    <button
                      type="button"
                      className="settings-icon-button"
                      onClick={() => handleMoveModel(option.id, 'down')}
                      disabled={index === managedModelOptions.length - 1}
                      aria-label={`下移 ${option.label}`}
                    >
                      <IconArrowDown />
                    </button>
                    <button
                      type="button"
                      className="settings-icon-button"
                      onClick={() => handleEditModel(option)}
                      aria-label={`编辑 ${option.label}`}
                    >
                      <IconEdit />
                    </button>
                    <button
                      type="button"
                      className="settings-icon-button is-danger"
                      onClick={() => handleDeleteModel(option.id)}
                      disabled={managedModelOptions.length <= 1}
                      aria-label={`删除 ${option.label}`}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>

        {editingModelId ? (
          <div className="settings-model-editor">
            <div className="settings-model-editor__header">
              <strong>{editingModelId === 'new' ? '新增模型' : '编辑模型'}</strong>
            </div>

            <div className="settings-model-editor__grid">
              <label className="settings-field">
                <span>显示名</span>
                <input
                  type="text"
                  value={modelDraft.label}
                  onChange={(event) =>
                    setModelDraft((current) => ({
                      ...current,
                      label: event.target.value,
                    }))
                  }
                  placeholder="例如：gpt-5.4"
                />
              </label>

              <label className="settings-field">
                <span>模型 ID</span>
                <input
                  type="text"
                  value={modelDraft.value}
                  onChange={(event) =>
                    setModelDraft((current) => ({
                      ...current,
                      value: event.target.value,
                    }))
                  }
                  placeholder="例如：gpt-5.4"
                />
              </label>
            </div>

            <div className="settings-model-editor__actions">
              <button
                type="button"
                className="settings-ghost-button"
                onClick={handleCancelModelEdit}
              >
                取消
              </button>
              <button
                type="button"
                className="settings-inline-action"
                onClick={handleSaveModel}
              >
                保存
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )

  const renderCacheSection = () => (
    <div className="settings-content-stack">
      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">页面缓存</h3>
          </div>
        </div>

        <div className="settings-summary-strip">
          <div className="settings-summary-strip__item">
            <span>适合什么时候用</span>
            <strong>页面资源或本地缓存异常</strong>
          </div>
          <div className="settings-summary-strip__item">
            <span>常见表现</span>
            <strong>样式没更新、列表卡旧、页面反复异常</strong>
          </div>
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">清理缓存</h3>
          </div>
        </div>

        <button
          type="button"
          className="settings-action"
          onClick={() => void handleClearCache()}
          disabled={isClearingCache}
        >
          <div className="settings-action__copy">
            <strong>清理并刷新</strong>
            <span>删除页面资源缓存和本地会话缓存，强制重新加载最新页面。</span>
          </div>
          <span className="settings-action__state">{isClearingCache ? '处理中…' : '→'}</span>
        </button>

        {statusMessage ? <p className="settings-block__status">{statusMessage}</p> : null}
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">移动端诊断</h3>
          </div>
        </div>

        <button
          type="button"
          className="settings-action"
          onClick={() => navigateFromSettings('/diagnostics')}
        >
          <div className="settings-action__copy">
            <strong>打开安卓诊断页</strong>
            <span>在手机上检查样式能力、资源加载、Service Worker 和缓存状态，并可上传到后端日志。</span>
          </div>
          <span className="settings-action__state">→</span>
        </button>
      </section>

      <section className="settings-panel">
        <div className="settings-panel__header">
          <div>
            <h3 className="settings-panel__title">命令目录缓存</h3>
          </div>
        </div>

        <div className="settings-meta">
          <span>当前 CLI</span>
          <span>{codexCommandsQuery.data?.cli_version ?? '检测中…'}</span>
        </div>
        <div className="settings-meta">
          <span>最近刷新</span>
          <span>{codexCommandsQuery.data?.loaded_at ?? '尚未生成'}</span>
        </div>
        <div className="settings-meta">
          <span>命令数量</span>
          <span>
            {codexCommandsQuery.data ? `${codexCommandsQuery.data.commands.length} 条` : '检测中…'}
          </span>
        </div>

        <button
          type="button"
          className="settings-action"
          onClick={() => void refreshCodexCommandsMutation.mutateAsync()}
          disabled={refreshCodexCommandsMutation.isPending}
        >
          <div className="settings-action__copy">
            <strong>刷新命令目录</strong>
            <span>重新从当前 Codex CLI 对应版本拉取命令并覆盖本地缓存文件。</span>
          </div>
          <span className="settings-action__state">
            {refreshCodexCommandsMutation.isPending ? '刷新中…' : '→'}
          </span>
        </button>
      </section>
    </div>
  )

  const renderConnectionSection = () => {
    const installedAppInfo = installedAppInfoQuery.data
    const androidRelease = androidReleaseQuery.data
    const hasAndroidRelease = Boolean(androidRelease?.apk_url)
    const hasAvailableAndroidRelease = isAndroidReleaseAvailable(
      installedAppInfo,
      androidRelease,
    )
    const androidReleaseManifestUrl = buildAndroidReleaseManifestUrl(runtimeConfig.hubUrl)

    return (
      <div className="settings-content-stack">
        {isNativeShell ? (
          <section className="settings-panel settings-panel--hero">
            <div className="settings-panel__header">
              <div>
                <h3 className="settings-panel__title">Hub 连接配置</h3>
              </div>
            </div>

            <div className="settings-summary-strip">
              <div className="settings-summary-strip__item">
                <span>当前 Hub</span>
                <strong>{runtimeConfig.hubUrl || '未配置'}</strong>
              </div>
              <div className="settings-summary-strip__item">
                <span>首启状态</span>
                <strong>{runtimeConfig.onboardingCompleted ? '已完成' : '未完成'}</strong>
              </div>
              <div className="settings-summary-strip__item">
                <span>App 形态</span>
                <strong>Capacitor Android</strong>
              </div>
            </div>
          </section>
        ) : (
          <section className="settings-panel settings-panel--hero">
            <div className="settings-panel__header">
              <div>
                <h3 className="settings-panel__title">网页端连接基线</h3>
              </div>
            </div>

            <div className="settings-summary-strip">
              <div className="settings-summary-strip__item">
                <span>当前网页入口</span>
                <strong>{runtimeConfig.hubUrl || '未检测到'}</strong>
              </div>
              <div className="settings-summary-strip__item">
                <span>地址来源</span>
                <strong>浏览器访问地址</strong>
              </div>
              <div className="settings-summary-strip__item">
                <span>缓存策略</span>
                <strong>同源页面 + 本地查询缓存</strong>
              </div>
            </div>
          </section>
        )}

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">
                {isNativeShell ? '重新设置 Hub' : '当前访问方式'}
              </h3>
            </div>
          </div>

          {isNativeShell ? (
            <HubConnectionForm
              title="输入新的 Hub 地址"
              description="扫码或手动输入后，保存即可让 APK 用新地址重新建立连接。"
              currentHubUrl={runtimeConfig.hubUrl}
              initialHubUrl={runtimeConfig.hubUrl}
              hint="保存后会清理旧的查询缓存、会话定位和连接判定缓存，避免继续误连到旧 Hub。"
              saveLabel="保存并重连"
              savingLabel="正在保存地址"
              saveDescription="新的 Hub 地址会持久化到本机，后续重新打开 APK 会继续沿用。"
              saveSuccessMessage="Hub 地址已保存，连接缓存和旧会话定位已重置。"
              onSaveSuccess={async (result) => {
                await writeRuntimeConfig({
                  hubUrl: result.url,
                  onboardingCompleted: true,
                })
                await resetRuntimeConnectionState(queryClient)
                void connectionQuery.refetch()
                void androidReleaseQuery.refetch()
                void installedAppInfoQuery.refetch()
              }}
            />
          ) : (
            <>
              <div className="settings-meta">
                <span>当前 Hub 地址</span>
                <span>{runtimeConfig.hubUrl || '未检测到'}</span>
              </div>
              <div className="settings-meta">
                <span>可修改性</span>
                <span>网页端跟随浏览器打开的地址，不额外保存本地覆盖配置。</span>
              </div>
            </>
          )}
        </section>

        {runtimeConfig.platform === 'android' ? (
          <section className="settings-panel">
            <div className="settings-panel__header">
              <div>
                <h3 className="settings-panel__title">App 升级</h3>
              </div>
              <div className="settings-actions-row">
                <button
                  type="button"
                  className="settings-inline-action"
                  onClick={() => {
                    void installedAppInfoQuery.refetch()
                    void androidReleaseQuery.refetch()
                  }}
                >
                  刷新版本
                </button>
              </div>
            </div>

            <div className="settings-meta">
              <span>当前版本</span>
              <span>{installedAppInfo?.version ?? '检测中…'}</span>
            </div>
            <div className="settings-meta">
              <span>当前 build</span>
              <span>{installedAppInfo?.build ?? '检测中…'}</span>
            </div>
            <div className="settings-meta">
              <span>应用包名</span>
              <span>{installedAppInfo?.appId ?? '检测中…'}</span>
            </div>
            <div className="settings-meta">
              <span>更新清单</span>
              <span>{androidReleaseManifestUrl || '等待 Hub 地址'}</span>
            </div>
            <div className="settings-meta">
              <span>最新发布</span>
              <span>
                {androidReleaseQuery.isLoading
                  ? '检测中…'
                  : androidRelease
                    ? `${androidRelease.version_name} (${androidRelease.version_code})`
                    : androidReleaseQuery.error instanceof Error
                      ? androidReleaseQuery.error.message
                      : '未检测到'}
              </span>
            </div>
            <div className="settings-meta">
              <span>升级状态</span>
              <span className={hasAvailableAndroidRelease ? 'is-ok' : 'is-muted'}>
                {hasAvailableAndroidRelease
                  ? '发现新版本'
                  : hasAndroidRelease
                    ? '当前已是最新'
                    : '等待发布 APK'}
              </span>
            </div>
            {androidRelease?.published_at ? (
              <div className="settings-meta">
                <span>发布时间</span>
                <span>{formatDiagnosticTimestamp(androidRelease.published_at)}</span>
              </div>
            ) : null}

            <button
              type="button"
              className="settings-action"
              onClick={() => {
                if (!androidRelease?.apk_url) {
                  return
                }

                void openAndroidReleaseDownload(androidRelease.apk_url)
              }}
              disabled={!androidRelease?.apk_url}
            >
              <div className="settings-action__copy">
                <strong>{hasAvailableAndroidRelease ? '下载并覆盖安装新版 APK' : '打开最新 APK 下载地址'}</strong>
                <span>
                  通过同一个 `applicationId` 和固定签名覆盖安装，旧配置和本地数据会保留，不需要卸载重装。
                </span>
              </div>
              <span className="settings-action__state">
                {androidRelease?.apk_url ? '→' : '未就绪'}
              </span>
            </button>

            {androidRelease?.release_notes.length ? (
              <div className="settings-diagnostic-list">
                {androidRelease.release_notes.map((note) => (
                  <div key={note} className="settings-diagnostic-list__item">
                    <strong>发布说明</strong>
                    <span>{note}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="settings-panel settings-panel--hero">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">当前设备</h3>
            </div>
          </div>

          <div className="settings-summary-strip">
            <div className="settings-summary-strip__item">
              <span>设备名称</span>
              <strong>{currentAgent?.name ?? '未选择节点'}</strong>
            </div>
            <div className="settings-summary-strip__item">
              <span>连接方式</span>
              <strong>{connectionQuery.data?.modeLabel ?? '检测中…'}</strong>
            </div>
            <div className="settings-summary-strip__item">
              <span>当前链路延迟</span>
              <strong className={connectionQuery.data?.healthOk ? 'is-ok' : 'is-muted'}>
                {connectionQuery.isLoading
                  ? '检测中…'
                  : formatConnectionLatency(connectionQuery.data?.latencyMs)}
              </strong>
            </div>
          </div>
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">当前链路</h3>
            </div>
            <div className="settings-actions-row">
              <button
                type="button"
                className="settings-inline-action"
                onClick={() => {
                  void connectionQuery.refetch()
                }}
              >
                刷新延迟
              </button>
            </div>
          </div>

          <div className="settings-meta">
            <span>服务名称</span>
            <span>{connectionQuery.data?.backendLabel ?? '检测中…'}</span>
          </div>
          <div className="settings-meta">
            <span>服务地址</span>
            <span>{connectionQuery.data?.backendUrl ?? '检测中…'}</span>
          </div>
          <div className="settings-meta">
            <span>当前状态</span>
            <span className={connectionQuery.data?.healthOk ? 'is-ok' : 'is-muted'}>
              {connectionQuery.isLoading
                ? '检测中…'
                : connectionQuery.data?.healthOk
                  ? '在线'
                  : connectionQuery.data?.activeProbe.error ?? '无法连接'}
            </span>
          </div>
          <div className="settings-meta">
            <span>当前延迟</span>
            <span>{formatConnectionLatency(connectionQuery.data?.latencyMs)}</span>
          </div>
          <div className="settings-meta">
            <span>最近探测</span>
            <span>{formatDiagnosticTimestamp(connectionQuery.data?.checkedAt)}</span>
          </div>
          <div className="settings-meta">
            <span>设备标识</span>
            <span>{currentAgent?.id ?? '未选择节点'}</span>
          </div>
          <div className="settings-meta">
            <span>最近会话</span>
            <span>{lastSessionId ?? '未选择会话'}</span>
          </div>
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">延迟对比</h3>
            </div>
          </div>

          <div className="settings-meta">
            <span>Hub 延迟</span>
            <span>{formatConnectionLatency(connectionQuery.data?.hubProbe.latencyMs)}</span>
          </div>
          <div className="settings-meta">
            <span>Hub 状态</span>
            <span className={connectionQuery.data?.hubProbe.healthOk ? 'is-ok' : 'is-muted'}>
              {connectionQuery.data?.hubProbe.healthOk
                ? '在线'
                : connectionQuery.data?.hubProbe.error ?? '无法连接'}
            </span>
          </div>
          <div className="settings-meta">
            <span>Hub 地址</span>
            <span>{connectionQuery.data?.hubProbe.url ?? '检测中…'}</span>
          </div>
          <div className="settings-meta">
            <span>当前 Agent 延迟</span>
            <span>{formatConnectionLatency(connectionQuery.data?.agentProbe?.latencyMs)}</span>
          </div>
          <div className="settings-meta">
            <span>当前 Agent 状态</span>
            <span className={connectionQuery.data?.agentProbe?.healthOk ? 'is-ok' : 'is-muted'}>
              {connectionQuery.data?.agentProbe
                ? connectionQuery.data.agentProbe.healthOk
                  ? '在线'
                  : connectionQuery.data.agentProbe.error ?? '无法连接'
                : '未选择节点'}
            </span>
          </div>
          <div className="settings-meta">
            <span>当前 Agent 地址</span>
            <span>{connectionQuery.data?.agentProbe?.url || currentAgentDirectUrl || '未配置'}</span>
          </div>
        </section>
      </div>
    )
  }

  const renderNotificationsSection = () => {
    const installStatusLabel = isNativeShell
      ? '原生 APK'
      : isPwaReady
        ? '已安装'
        : '未安装'
    const permissionLabel =
      notificationPermission === 'granted'
        ? '已允许'
        : notificationPermission === 'denied'
          ? '已拒绝'
          : notificationPermission === 'default'
            ? '待授权'
            : '不支持'
    const webPushChannelLabel = isNativeShell
      ? notificationPermission === 'granted'
        ? '原生通知'
        : '等待授权'
      : !hasWebPushSupport
      ? '不支持'
      : isSyncingWebPush
        ? '同步中'
        : hasActiveWebPushRegistration
          ? '已连接'
          : notificationSettings.completionNotificationsEnabled &&
              notificationPermission === 'granted'
            ? '待连接'
            : '未连接'
    const reminderLabel = isNativeShell
      ? notificationPermission === 'granted'
        ? '已开启'
        : '待授权'
      :
      notificationPermission === 'granted' &&
      notificationSettings.completionNotificationsEnabled
        ? hasActiveWebPushRegistration
          ? '后台可达'
          : hasWebPushSupport
            ? '前台兜底'
            : '仅前台'
        : '未开启'
    const reminderModeLabel = isNativeShell
      ? '原生系统通知'
      : hasWebPushSupport
      ? hasActiveWebPushRegistration
        ? 'Hub Web Push + 系统通知'
        : '系统通知，后台通道待建立'
      : '系统通知（仅页面在线）'
    const lockscreenLabel = isNativeShell
      ? notificationPermission === 'granted'
        ? '通常可见，细节取决于系统设置'
        : '先授予通知权限'
      : hasActiveWebPushRegistration
      ? isPwaReady
        ? '已具备条件'
        : '大多可见，安装后更稳'
      : hasWebPushSupport
        ? '先建立后台通道'
        : '当前环境很难稳定锁屏提醒'
    const actionDisabled =
      notificationPermission === 'unsupported' ||
      (!isNativeShell && isSyncingWebPush)
    const actionTitle = isNativeShell
      ? notificationPermission === 'granted'
        ? '系统通知已开启'
        : '申请通知权限'
      : notificationPermission === 'granted' &&
          notificationSettings.completionNotificationsEnabled
        ? '关闭完成提醒'
        : isSyncingWebPush
          ? '正在建立后台提醒'
          : '开启完成提醒'
    const actionDescription =
      notificationPermission === 'unsupported'
        ? '当前环境不支持系统通知，需要 HTTPS、Service Worker 和受支持浏览器。'
        : isNativeShell
          ? notificationPermission === 'granted'
            ? '首次连接时也会自动申请；这里主要用于补检查权限状态。'
            : '如果首次连接时错过了授权，这里可以补申请一次。'
        : hasWebPushSupport
          ? '开启后会向 Hub 注册这台设备，后台或锁屏时也能收到完成提醒。'
          : '当前环境只能在页面在线时提醒，建议安装到桌面并使用支持 Web Push 的浏览器。'
    const actionStateLabel = isNativeShell
      ? notificationPermission === 'unsupported'
        ? '不可用'
        : notificationPermission === 'granted'
          ? '已开启'
          : '→'
      : notificationPermission === 'unsupported'
        ? '不可用'
        : isSyncingWebPush
          ? '同步中…'
          : notificationPermission === 'granted' &&
              notificationSettings.completionNotificationsEnabled
            ? hasActiveWebPushRegistration
              ? '已连接'
              : hasWebPushSupport
                ? '待连接'
                : '已开启'
            : '→'
    const canSendTestPush = isNativeShell
      ? notificationPermission === 'granted'
      :
      notificationPermission === 'granted' &&
      notificationSettings.completionNotificationsEnabled &&
      hasActiveWebPushRegistration &&
      !isSyncingWebPush
    const testActionDescription = isNativeShell
      ? '直接在当前 APK 里发一条本地测试通知，确认系统权限和展示链路正常。'
      : hasActiveWebPushRegistration
      ? '立刻让 Hub 给当前这台设备发一条测试通知，用来确认后台链路是否真的可达。'
      : '只有当前设备已经完成 Web Push 注册后，才能发送测试通知。'

    return (
      <div className="settings-content-stack">
        <section className="settings-panel settings-panel--hero">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">安卓优先提醒</h3>
            </div>
          </div>

          <div className="settings-summary-strip">
            <div className="settings-summary-strip__item">
              <span>桌面安装</span>
              <strong>{installStatusLabel}</strong>
            </div>
            <div className="settings-summary-strip__item">
              <span>系统通知权限</span>
              <strong>{permissionLabel}</strong>
            </div>
            <div className="settings-summary-strip__item">
              <span>完成提醒</span>
              <strong>{reminderLabel}</strong>
            </div>
            <div className="settings-summary-strip__item">
              <span>后台 Web Push</span>
              <strong>{webPushChannelLabel}</strong>
            </div>
          </div>
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">
                {isNativeShell ? '当前交付形态' : '安装到桌面'}
              </h3>
            </div>
          </div>

          <div className="settings-meta">
            <span>推荐平台</span>
            <span>
              {isNativeShell
                ? '当前已经是 Android APK'
                : isAndroid
                  ? 'Android 当前设备'
                  : 'Android 效果最佳'}
            </span>
          </div>
          <div className="settings-meta">
            <span>当前形态</span>
            <span>
              {isNativeShell
                ? '本地前端壳 + 局域网后端'
                : isPwaReady
                  ? '已是桌面应用'
                  : '浏览器标签页'}
            </span>
          </div>

          <button
            type="button"
            className="settings-action"
            onClick={() => void handleInstallApp()}
            disabled={isNativeShell || isPwaReady || isInstallingApp}
          >
            <div className="settings-action__copy">
              <strong>
                {isNativeShell
                  ? '已经是可安装 APK'
                  : isPwaReady
                    ? '已经安装'
                    : '安装到桌面'}
              </strong>
              <span>
                {isNativeShell
                  ? '当前无需再走 PWA 安装链路，后续升级直接下载新版 APK 覆盖安装即可。'
                  : isPwaReady
                  ? '现在可以直接从桌面图标进入 Panda。'
                  : '安装后更像应用，系统通知和锁屏提醒也更稳定。'}
              </span>
            </div>
            <span className="settings-action__state">
              {isNativeShell ? '✓' : isPwaReady ? '✓' : isInstallingApp ? '处理中…' : '→'}
            </span>
          </button>
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">对话完成提醒</h3>
            </div>
          </div>

          <div className="settings-meta">
            <span>提醒方式</span>
            <span>{reminderModeLabel}</span>
          </div>
          <div className="settings-meta">
            <span>锁屏可见</span>
            <span>{lockscreenLabel}</span>
          </div>
          <div className="settings-meta">
            <span>后台通道</span>
            <span>{webPushChannelLabel}</span>
          </div>
          <div className="settings-meta">
            <span>触发时机</span>
            <span>
              {isNativeShell
                ? 'App 在线时收到完成事件后，直接发原生系统通知'
                : hasWebPushSupport
                  ? 'Hub 收到对话完成后主动推送'
                  : '页面在线时收到完成事件后提醒'}
            </span>
          </div>

          <button
            type="button"
            className="settings-action"
            onClick={() => void handleNotificationToggle()}
            disabled={actionDisabled}
          >
            <div className="settings-action__copy">
              <strong>{actionTitle}</strong>
              <span>{actionDescription}</span>
            </div>
            <span className="settings-action__state">{actionStateLabel}</span>
          </button>

          <button
            type="button"
            className="settings-action"
            onClick={() => void handleSendTestPush()}
            disabled={!canSendTestPush || isSendingTestPush}
          >
            <div className="settings-action__copy">
              <strong>
                {isNativeShell
                  ? isSendingTestPush
                    ? '正在发送测试通知'
                    : '发送测试通知'
                  : isSendingTestPush
                    ? '正在发送测试推送'
                    : '发送测试推送'}
              </strong>
              <span>{testActionDescription}</span>
            </div>
            <span className="settings-action__state">
              {isSendingTestPush ? '发送中…' : canSendTestPush ? '→' : '未就绪'}
            </span>
          </button>

          {notificationMessage ? (
            <p className="settings-block__status">{notificationMessage}</p>
          ) : null}
        </section>
      </div>
    )
  }

  const renderInstallationSection = () => {
    const diagnostics = installDiagnosticsQuery.data
    const promptLabel = diagnostics?.promptState.installPromptAvailable
      ? '可主动触发'
      : diagnostics?.promptState.beforeInstallPromptSeen
        ? '本地曾出现'
        : '未出现'
    const appInstalledLabel = diagnostics?.promptState.appInstalledSeen ? '记录到过' : '未记录到'
    const manifestLabel = diagnostics?.manifest.ok ? '正常' : diagnostics?.manifest.present ? '读取失败' : '缺失'
    const serviceWorkerLabel = diagnostics?.serviceWorker.registrations.length
      ? `${diagnostics.serviceWorker.registrations.length} 个注册`
      : diagnostics?.serviceWorker.supported
        ? '未注册'
        : '不支持'

    return (
      <div className="settings-content-stack">
        <section className="settings-panel settings-panel--hero">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">安装结果判断</h3>
            </div>
          </div>

          <div className="settings-summary-strip">
            <div className="settings-summary-strip__item">
              <span>当前研判</span>
              <strong>{diagnostics?.assessment.label ?? '检测中…'}</strong>
            </div>
            <div className="settings-summary-strip__item">
              <span>安装事件</span>
              <strong>{promptLabel}</strong>
            </div>
            <div className="settings-summary-strip__item">
              <span>appinstalled</span>
              <strong>{appInstalledLabel}</strong>
            </div>
          </div>
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">当前状态</h3>
            </div>
            <div className="settings-actions-row">
              <button
                type="button"
                className="settings-inline-action"
                onClick={() => {
                  void installDiagnosticsQuery.refetch()
                }}
              >
                刷新诊断
              </button>
              <button
                type="button"
                className="settings-ghost-button"
                onClick={() => {
                  clearPwaInstallLogs()
                  refreshInstallDiagnostics()
                }}
              >
                清空日志
              </button>
            </div>
          </div>

          <div className="settings-meta">
            <span>当前窗口形态</span>
            <span>
              {diagnostics
                ? diagnostics.environment.standaloneDisplayMode ||
                    diagnostics.environment.navigatorStandalone
                  ? '独立窗口 / 主屏幕入口'
                  : '浏览器标签页'
                : '检测中…'}
            </span>
          </div>
          <div className="settings-meta">
            <span>系统级安装研判</span>
            <span>{diagnostics?.assessment.label ?? '检测中…'}</span>
          </div>
          <div className="settings-meta">
            <span>研判置信度</span>
            <span>{diagnostics?.assessment.confidence ?? '检测中…'}</span>
          </div>
          <div className="settings-meta">
            <span>当前说明</span>
            <span>{diagnostics?.assessment.detail ?? '正在分析…'}</span>
          </div>
          <div className="settings-meta">
            <span>最近抓取时间</span>
            <span>{formatDiagnosticTimestamp(diagnostics?.capturedAt)}</span>
          </div>
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">PWA 条件与安装信号</h3>
            </div>
          </div>

          <div className="settings-meta">
            <span>安全上下文</span>
            <span>{diagnostics?.environment.secureContext ? '是' : '否'}</span>
          </div>
          <div className="settings-meta">
            <span>manifest</span>
            <span>{manifestLabel}</span>
          </div>
          <div className="settings-meta">
            <span>manifest display</span>
            <span>{diagnostics?.manifest.display ?? '未声明'}</span>
          </div>
          <div className="settings-meta">
            <span>Service Worker</span>
            <span>{serviceWorkerLabel}</span>
          </div>
          <div className="settings-meta">
            <span>当前可主动触发安装</span>
            <span>{diagnostics?.promptState.installPromptAvailable ? '可以' : '不可以'}</span>
          </div>
          <div className="settings-meta">
            <span>最近 beforeinstallprompt</span>
            <span>{formatDiagnosticTimestamp(diagnostics?.promptState.lastBeforeInstallPromptAt)}</span>
          </div>
          <div className="settings-meta">
            <span>最近 appinstalled</span>
            <span>{formatDiagnosticTimestamp(diagnostics?.promptState.lastAppInstalledAt)}</span>
          </div>
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">为什么当前可能安装失败</h3>
            </div>
          </div>

          {installDiagnosticsQuery.isLoading ? (
            <p className="settings-block__status">正在收集安装诊断…</p>
          ) : diagnostics?.failureReasons.length ? (
            <div className="settings-diagnostic-list">
              {diagnostics.failureReasons.map((reason, index) => (
                <div key={`${index}-${reason}`} className="settings-diagnostic-list__item">
                  <strong>原因 {index + 1}</strong>
                  <span>{reason}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-block__status">
              当前没有发现明显的前端侧阻断条件；如果仍无法完成系统级安装，更像是浏览器策略、安装链路回退或平台侧判断导致。
            </p>
          )}
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">成功信号与人工确认</h3>
            </div>
          </div>

          {diagnostics?.successSignals.length ? (
            <div className="settings-diagnostic-list">
              {diagnostics.successSignals.map((reason, index) => (
                <div key={`${index}-${reason}`} className="settings-diagnostic-list__item">
                  <strong>信号 {index + 1}</strong>
                  <span>{reason}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="settings-diagnostic-list">
            {diagnostics?.confirmationChecklist.map((item, index) => (
              <div key={`${index}-${item}`} className="settings-diagnostic-list__item">
                <strong>确认 {index + 1}</strong>
                <span>{item}</span>
              </div>
            )) ?? null}
          </div>
        </section>

        <section className="settings-panel">
          <div className="settings-panel__header">
            <div>
              <h3 className="settings-panel__title">浏览器安装事件日志</h3>
            </div>
          </div>

          {installDiagnosticsQuery.isLoading ? (
            <p className="settings-block__status">正在读取日志…</p>
          ) : diagnostics?.logs.length ? (
            <div className="settings-log-list">
              {diagnostics.logs.map((entry) => (
                <article key={entry.id} className="settings-log-item">
                  <div className="settings-log-item__meta">
                    <strong>{entry.message}</strong>
                    <span>{formatDiagnosticTimestamp(entry.timestamp)}</span>
                  </div>
                  <div className="settings-log-item__kind">{entry.kind}</div>
                  {entry.detail ? (
                    <pre className="settings-log-item__detail">{entry.detail}</pre>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <p className="settings-block__status">
              还没有本地安装日志。后续在这个页面触发安装、刷新页面、出现 beforeinstallprompt 或 appinstalled 后，这里会自动积累证据。
            </p>
          )}
        </section>
      </div>
    )
  }

  const renderSectionContent = (section: SettingsSection) => {
    if (section === 'models') {
      return renderModelsSection()
    }

    if (section === 'cache') {
      return renderCacheSection()
    }

    if (section === 'notifications') {
      return renderNotificationsSection()
    }

    if (section === 'installation') {
      return renderInstallationSection()
    }

    if (section === 'connection') {
      return renderConnectionSection()
    }

    if (section === 'dev-manager') {
      return (
        <DevManagerPanel
          isActive={activeSection === 'dev-manager' || expandedMobileSection === 'dev-manager'}
          agentId={currentAgent?.id ?? null}
        />
      )
    }

    return renderThemeSection()
  }

  return (
    <div
      className="conversation-page settings-screen settings-screen--workspace"
      style={pageStyle}
    >
      <div className="conversation-main settings-screen__main settings-screen__workspace-main">
        <div className="settings-screen__body">
          <div className="settings-shell">
            <header className="settings-page-header">
              <button
                type="button"
                className="settings-card__back"
                onClick={handleBack}
                aria-label="返回会话"
              >
                <IconArrowLeft />
              </button>
              <div className="settings-page-header__copy">
                <h1 className="settings-page-header__title">设置</h1>
              </div>
            </header>

            {isDesktop ? (
              <div className="settings-workspace">
                <aside className="settings-sidebar">
                  <div className="settings-sidebar__title">设置</div>
                  <nav className="settings-sidebar__nav" aria-label="设置导航">
                    {SETTINGS_SECTIONS.map((section) => {
                      const isActive = section.id === activeSection
                      return (
                        <button
                          key={section.id}
                          type="button"
                          className={`settings-sidebar__item ${isActive ? 'is-active' : ''}`}
                          onClick={() => setActiveSection(section.id)}
                        >
                          <SectionIcon icon={section.icon} />
                          <span>{section.title}</span>
                        </button>
                      )
                    })}
                  </nav>
                </aside>

                <main className="settings-stage">
                  <header className="settings-stage__header">
                    <div>
                      <h2 className="settings-stage__title">{activeSectionMeta.title}</h2>
                      <p className="settings-stage__description">{activeSectionMeta.description}</p>
                    </div>
                  </header>
                  {renderSectionContent(activeSection)}
                </main>
              </div>
            ) : (
              renderMobileSections()
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
