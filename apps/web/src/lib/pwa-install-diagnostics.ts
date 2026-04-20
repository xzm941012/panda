type NavigatorWithStandalone = Navigator & {
  standalone?: boolean
}

export type PwaInstallLogKind =
  | 'beforeinstallprompt'
  | 'install-button-click'
  | 'install-prompt-shown'
  | 'install-choice'
  | 'install-unavailable'
  | 'install-error'
  | 'appinstalled'
  | 'visibilitychange'

export type PwaInstallLogEntry = {
  id: string
  timestamp: string
  kind: PwaInstallLogKind
  message: string
  detail: string | null
}

type ManifestIconSummary = {
  src: string
  purpose: string | null
  sizes: string | null
  type: string | null
  ok: boolean
  status: number | null
  error: string | null
}

type ManifestSummary = {
  href: string | null
  present: boolean
  ok: boolean
  error: string | null
  id: string | null
  name: string | null
  shortName: string | null
  startUrl: string | null
  scope: string | null
  display: string | null
  displayOverride: string[]
  themeColor: string | null
  backgroundColor: string | null
  icons: ManifestIconSummary[]
}

type ServiceWorkerSummary = {
  supported: boolean
  controller: boolean
  registrations: Array<{
    scope: string
    activeScriptUrl: string | null
    waitingScriptUrl: string | null
    installingScriptUrl: string | null
  }>
}

type InstallAssessment = {
  label: string
  confidence: 'high' | 'medium' | 'low'
  detail: string
}

export type PwaInstallDiagnostics = {
  capturedAt: string
  environment: {
    href: string | null
    origin: string | null
    secureContext: boolean
    online: boolean | null
    userAgent: string | null
    isAndroid: boolean
    standaloneDisplayMode: boolean
    navigatorStandalone: boolean
  }
  promptState: {
    installPromptAvailable: boolean
    beforeInstallPromptSeen: boolean
    appInstalledSeen: boolean
    lastBeforeInstallPromptAt: string | null
    lastAppInstalledAt: string | null
  }
  manifest: ManifestSummary
  serviceWorker: ServiceWorkerSummary
  assessment: InstallAssessment
  failureReasons: string[]
  successSignals: string[]
  confirmationChecklist: string[]
  logs: PwaInstallLogEntry[]
}

const INSTALL_LOG_KEY = 'panda:pwa-install-log'
const MAX_INSTALL_LOGS = 48

const normalizeText = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

const readStoredLogsInternal = (): PwaInstallLogEntry[] => {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const raw = window.localStorage.getItem(INSTALL_LOG_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null
        }

        const candidate = entry as Partial<PwaInstallLogEntry>
        if (
          typeof candidate.id !== 'string' ||
          typeof candidate.timestamp !== 'string' ||
          typeof candidate.kind !== 'string' ||
          typeof candidate.message !== 'string'
        ) {
          return null
        }

        return {
          id: candidate.id,
          timestamp: candidate.timestamp,
          kind: candidate.kind as PwaInstallLogKind,
          message: candidate.message,
          detail: normalizeText(candidate.detail),
        }
      })
      .filter((entry): entry is PwaInstallLogEntry => Boolean(entry))
      .sort((left, right) => +new Date(right.timestamp) - +new Date(left.timestamp))
  } catch {
    return []
  }
}

const writeStoredLogs = (entries: PwaInstallLogEntry[]) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(INSTALL_LOG_KEY, JSON.stringify(entries.slice(0, MAX_INSTALL_LOGS)))
  } catch {
    // Install diagnostics are best effort only.
  }
}

export const readPwaInstallLogs = () => readStoredLogsInternal()

export const clearPwaInstallLogs = () => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.removeItem(INSTALL_LOG_KEY)
  } catch {
    // Ignore storage failures.
  }
}

export const appendPwaInstallLog = (entry: {
  kind: PwaInstallLogKind
  message: string
  detail?: string | null
}) => {
  const logs = readStoredLogsInternal()
  const nextEntry: PwaInstallLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    kind: entry.kind,
    message: entry.message.trim(),
    detail: normalizeText(entry.detail),
  }
  writeStoredLogs([nextEntry, ...logs])
  return nextEntry
}

const readLatestLogTimestamp = (
  logs: PwaInstallLogEntry[],
  kind: PwaInstallLogKind,
) => logs.find((entry) => entry.kind === kind)?.timestamp ?? null

const fetchJson = async (url: string) => {
  const response = await fetch(url, {
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return (await response.json()) as Record<string, unknown>
}

const probeIcon = async (url: string): Promise<{
  ok: boolean
  status: number | null
  error: string | null
}> => {
  try {
    let response = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
    })
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
      })
    }

    return {
      ok: response.ok,
      status: response.status,
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : 'Unknown fetch failure',
    }
  }
}

const readManifestSummary = async (): Promise<ManifestSummary> => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return {
      href: null,
      present: false,
      ok: false,
      error: 'Document is unavailable.',
      id: null,
      name: null,
      shortName: null,
      startUrl: null,
      scope: null,
      display: null,
      displayOverride: [],
      themeColor: null,
      backgroundColor: null,
      icons: [],
    }
  }

  const manifestLink = document.querySelector<HTMLLinkElement>('link[rel~="manifest"]')
  const manifestHref = normalizeText(manifestLink?.href)
  if (!manifestHref) {
    return {
      href: null,
      present: false,
      ok: false,
      error: '页面没有 manifest 链接。',
      id: null,
      name: null,
      shortName: null,
      startUrl: null,
      scope: null,
      display: null,
      displayOverride: [],
      themeColor: null,
      backgroundColor: null,
      icons: [],
    }
  }

  try {
    const manifest = await fetchJson(manifestHref)
    const rawIcons = Array.isArray(manifest.icons) ? manifest.icons : []
    const icons = await Promise.all(
      rawIcons.slice(0, 8).map(async (icon) => {
        const candidate = icon as Record<string, unknown>
        const srcValue = normalizeText(
          typeof candidate.src === 'string' ? candidate.src : null,
        )
        if (!srcValue) {
          return {
            src: '(missing)',
            purpose: normalizeText(typeof candidate.purpose === 'string' ? candidate.purpose : null),
            sizes: normalizeText(typeof candidate.sizes === 'string' ? candidate.sizes : null),
            type: normalizeText(typeof candidate.type === 'string' ? candidate.type : null),
            ok: false,
            status: null,
            error: 'Icon src is missing.',
          }
        }

        const resolvedUrl = new URL(srcValue, manifestHref).toString()
        const probe = await probeIcon(resolvedUrl)
        return {
          src: resolvedUrl,
          purpose: normalizeText(typeof candidate.purpose === 'string' ? candidate.purpose : null),
          sizes: normalizeText(typeof candidate.sizes === 'string' ? candidate.sizes : null),
          type: normalizeText(typeof candidate.type === 'string' ? candidate.type : null),
          ok: probe.ok,
          status: probe.status,
          error: probe.error,
        }
      }),
    )

    return {
      href: manifestHref,
      present: true,
      ok: true,
      error: null,
      id: normalizeText(typeof manifest.id === 'string' ? manifest.id : null),
      name: normalizeText(typeof manifest.name === 'string' ? manifest.name : null),
      shortName: normalizeText(
        typeof manifest.short_name === 'string' ? manifest.short_name : null,
      ),
      startUrl: normalizeText(
        typeof manifest.start_url === 'string' ? manifest.start_url : null,
      ),
      scope: normalizeText(typeof manifest.scope === 'string' ? manifest.scope : null),
      display: normalizeText(typeof manifest.display === 'string' ? manifest.display : null),
      displayOverride: Array.isArray(manifest.display_override)
        ? manifest.display_override.filter((value): value is string => typeof value === 'string')
        : [],
      themeColor: normalizeText(
        typeof manifest.theme_color === 'string' ? manifest.theme_color : null,
      ),
      backgroundColor: normalizeText(
        typeof manifest.background_color === 'string' ? manifest.background_color : null,
      ),
      icons,
    }
  } catch (error) {
    return {
      href: manifestHref,
      present: true,
      ok: false,
      error: error instanceof Error ? error.message : 'Manifest fetch failed.',
      id: null,
      name: null,
      shortName: null,
      startUrl: null,
      scope: null,
      display: null,
      displayOverride: [],
      themeColor: null,
      backgroundColor: null,
      icons: [],
    }
  }
}

const readServiceWorkerSummary = async (): Promise<ServiceWorkerSummary> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return {
      supported: false,
      controller: false,
      registrations: [],
    }
  }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    return {
      supported: true,
      controller: Boolean(navigator.serviceWorker.controller),
      registrations: registrations.map((registration) => ({
        scope: registration.scope,
        activeScriptUrl: registration.active?.scriptURL ?? null,
        waitingScriptUrl: registration.waiting?.scriptURL ?? null,
        installingScriptUrl: registration.installing?.scriptURL ?? null,
      })),
    }
  } catch {
    return {
      supported: true,
      controller: Boolean(navigator.serviceWorker.controller),
      registrations: [],
    }
  }
}

const buildAssessment = (options: {
  standaloneDisplayMode: boolean
  navigatorStandalone: boolean
  installPromptAvailable: boolean
  beforeInstallPromptSeen: boolean
  appInstalledSeen: boolean
}): InstallAssessment => {
  const launchedStandalone =
    options.standaloneDisplayMode || options.navigatorStandalone

  if (launchedStandalone && options.appInstalledSeen) {
    return {
      label: '较像已安装应用',
      confidence: 'medium',
      detail:
        '当前页面正以独立窗口打开，并且这个站点记录到过 appinstalled 事件，更像是真正安装后的应用入口。',
    }
  }

  if (launchedStandalone) {
    return {
      label: '更像主屏幕快捷方式',
      confidence: 'medium',
      detail:
        '当前页面虽然已脱离浏览器标签页，但站点本地没有观测到 appinstalled 事件，无法证明系统级安装已经完成，更像是主屏幕快捷方式。',
    }
  }

  if (options.installPromptAvailable) {
    return {
      label: '可触发安装流程',
      confidence: 'high',
      detail:
        '浏览器已经提供 beforeinstallprompt 事件，设置页里的安装按钮可以主动弹出安装流程。',
    }
  }

  if (options.beforeInstallPromptSeen) {
    return {
      label: '浏览器曾允许安装',
      confidence: 'low',
      detail:
        '站点历史上收到过 beforeinstallprompt，但当前页面没有可用的安装事件，可能需要刷新页面、重新访问或等待浏览器重新评估。',
    }
  }

  return {
    label: '当前不像可安装应用',
    confidence: 'medium',
    detail:
      '浏览器当前没有给出可用的安装事件，页面更像普通标签页或只能走“添加到主屏幕”的快捷方式链路。',
  }
}

const buildFailureReasons = (options: {
  secureContext: boolean
  manifest: ManifestSummary
  serviceWorker: ServiceWorkerSummary
  installPromptAvailable: boolean
  beforeInstallPromptSeen: boolean
  appInstalledSeen: boolean
  launchedStandalone: boolean
  logs: PwaInstallLogEntry[]
}) => {
  const reasons: string[] = []

  if (!options.secureContext) {
    reasons.push('当前页面不是安全上下文，Chrome 不会提供完整的 PWA 安装链路。')
  }

  if (!options.manifest.present) {
    reasons.push('页面没有 manifest 链接，浏览器无法把当前站点识别为可安装 Web App。')
  } else if (!options.manifest.ok) {
    reasons.push(`manifest 读取失败：${options.manifest.error ?? '未知错误'}。`)
  } else {
    if (!options.manifest.display || options.manifest.display === 'browser') {
      reasons.push('manifest 没有声明 standalone/minimal-ui 显示模式，浏览器更可能只给快捷方式。')
    }

    if (!options.manifest.name && !options.manifest.shortName) {
      reasons.push('manifest 缺少 name/short_name，安装身份信息不完整。')
    }

    const has192 = options.manifest.icons.some(
      (icon) => icon.ok && (icon.sizes ?? '').includes('192x192'),
    )
    const has512 = options.manifest.icons.some(
      (icon) => icon.ok && (icon.sizes ?? '').includes('512x512'),
    )
    if (!has192 || !has512) {
      reasons.push('manifest 图标里缺少可访问的 192x192 或 512x512 图标，Android 安装链路可能会退化。')
    }

    const brokenIcons = options.manifest.icons.filter((icon) => !icon.ok)
    if (brokenIcons.length > 0) {
      reasons.push(`有 ${brokenIcons.length} 个 manifest 图标资源探测失败，安装时可能因为图标拉取失败而退化或失败。`)
    }
  }

  if (!options.serviceWorker.supported) {
    reasons.push('当前浏览器不支持 Service Worker，无法满足完整的 PWA 安装条件。')
  } else if (options.serviceWorker.registrations.length === 0) {
    reasons.push('当前页面没有检测到 Service Worker 注册，Chrome 往往不会提供完整安装流程。')
  }

  if (
    !options.installPromptAvailable &&
    !options.launchedStandalone &&
    options.secureContext &&
    options.manifest.ok &&
    options.serviceWorker.registrations.length > 0
  ) {
    reasons.push('浏览器当前没有下发 beforeinstallprompt，设置页按钮无法主动触发安装，只能走浏览器菜单的安装/添加到主屏幕入口。')
  }

  const acceptedLog = options.logs.find(
    (entry) =>
      entry.kind === 'install-choice' &&
      entry.detail?.toLowerCase().includes('accepted'),
  )
  if (acceptedLog && !options.appInstalledSeen) {
    reasons.push('站点记录到用户接受过安装请求，但没有后续 appinstalled 事件，更像是浏览器回退成快捷方式，或系统级安装没有完成。')
  }

  if (options.launchedStandalone && !options.appInstalledSeen) {
    reasons.push('当前虽然是独立窗口形态，但没有观测到 appinstalled，不能把它视为已经完成系统级安装。')
  }

  return reasons
}

export const collectPwaInstallDiagnostics = async (options?: {
  installPromptAvailable?: boolean
}): Promise<PwaInstallDiagnostics> => {
  const logs = readStoredLogsInternal()
  const [manifest, serviceWorker] = await Promise.all([
    readManifestSummary(),
    readServiceWorkerSummary(),
  ])

  const navigatorWithStandalone = navigator as NavigatorWithStandalone
  const standaloneDisplayMode =
    typeof window !== 'undefined' &&
    window.matchMedia('(display-mode: standalone)').matches
  const navigatorStandalone = navigatorWithStandalone.standalone === true
  const beforeInstallPromptSeen = logs.some((entry) => entry.kind === 'beforeinstallprompt')
  const appInstalledSeen = logs.some((entry) => entry.kind === 'appinstalled')
  const installPromptAvailable = options?.installPromptAvailable === true
  const launchedStandalone = standaloneDisplayMode || navigatorStandalone

  const successSignals: string[] = []
  if (window.isSecureContext) {
    successSignals.push('当前是安全上下文。')
  }
  if (manifest.ok) {
    successSignals.push('manifest 可读取。')
  }
  if (serviceWorker.registrations.length > 0) {
    successSignals.push(`检测到 ${serviceWorker.registrations.length} 个 Service Worker 注册。`)
  }
  if (installPromptAvailable) {
    successSignals.push('浏览器已提供可调用的安装事件。')
  }
  if (appInstalledSeen) {
    successSignals.push('站点本地记录到过 appinstalled 事件。')
  }

  const confirmationChecklist = [
    '从桌面图标打开后，确认没有浏览器地址栏或标签栏。',
    '到 Android“设置 -> 应用”里搜索 Panda，若能搜到，更像系统级安装。',
    '到应用抽屉里搜索 Panda；若只在桌面可见而应用抽屉里没有，更像快捷方式。',
    '如果日志里只有“添加到主屏幕”链路，没有 appinstalled，通常不能认定为真正安装完成。',
  ]

  return {
    capturedAt: new Date().toISOString(),
    environment: {
      href: typeof window === 'undefined' ? null : window.location.href,
      origin: typeof window === 'undefined' ? null : window.location.origin,
      secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
      online:
        typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
          ? navigator.onLine
          : null,
      userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
      isAndroid:
        typeof navigator !== 'undefined' ? /Android/i.test(navigator.userAgent) : false,
      standaloneDisplayMode,
      navigatorStandalone,
    },
    promptState: {
      installPromptAvailable,
      beforeInstallPromptSeen,
      appInstalledSeen,
      lastBeforeInstallPromptAt: readLatestLogTimestamp(logs, 'beforeinstallprompt'),
      lastAppInstalledAt: readLatestLogTimestamp(logs, 'appinstalled'),
    },
    manifest,
    serviceWorker,
    assessment: buildAssessment({
      standaloneDisplayMode,
      navigatorStandalone,
      installPromptAvailable,
      beforeInstallPromptSeen,
      appInstalledSeen,
    }),
    failureReasons: buildFailureReasons({
      secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
      manifest,
      serviceWorker,
      installPromptAvailable,
      beforeInstallPromptSeen,
      appInstalledSeen,
      launchedStandalone,
      logs,
    }),
    successSignals,
    confirmationChecklist,
    logs,
  }
}
