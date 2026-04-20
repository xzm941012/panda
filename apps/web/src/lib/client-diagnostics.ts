import type {
  ClientDiagnosticElementSnapshot,
  ClientDiagnosticPerformanceEntry,
  ClientDiagnosticReport,
  ClientDiagnosticResourceProbe,
  ClientDiagnosticServiceWorker,
  ClientDiagnosticStylesheet,
} from '@panda/protocol'

type NavigatorWithDeviceHints = Navigator & {
  deviceMemory?: number
}

const FEATURE_SUPPORT_CHECKS = [
  {
    key: 'color-mix-oklab',
    property: 'background',
    value: 'color-mix(in oklab, white 50%, black)',
  },
  {
    key: 'color-mix-srgb',
    property: 'background',
    value: 'color-mix(in srgb, white 50%, black)',
  },
  {
    key: 'backdrop-filter',
    property: 'backdrop-filter',
    value: 'blur(12px)',
  },
  {
    key: 'webkit-backdrop-filter',
    property: '-webkit-backdrop-filter',
    value: 'blur(12px)',
  },
  {
    key: 'viewport-dvh',
    property: 'height',
    value: '100dvh',
  },
] as const

const THEME_VARIABLE_NAMES = [
  '--color-surface-base',
  '--color-surface-panel',
  '--color-surface-floating',
  '--color-surface-border',
  '--color-surface-border-soft',
  '--color-text-primary',
  '--color-text-secondary',
  '--color-accent-primary',
  '--color-accent-primary-soft',
] as const

const ELEMENT_SNAPSHOT_SELECTORS = [
  '.conversation-topbar',
  '.topbar-menu',
  '.conversation-run-popover',
  '.chat-composer',
  '.chat-composer__input',
  '.composer-utility-menu__popover',
  '.session-run-panel__command-card',
  '.session-run-panel__input',
  '.session-git-panel__summary',
] as const

const COMPUTED_STYLE_KEYS = [
  'background-color',
  'background-image',
  'backdrop-filter',
  '-webkit-backdrop-filter',
  'border-color',
  'box-shadow',
  'color',
  'display',
  'opacity',
  'position',
] as const

const normalizeText = (value: string | null | undefined, maxLength = 180) => {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

const roundNumber = (value: number) => Number(value.toFixed(2))

const safeCssSupports = (property: string, value: string) => {
  if (typeof window === 'undefined' || typeof window.CSS?.supports !== 'function') {
    return false
  }

  try {
    return window.CSS.supports(property, value)
  } catch {
    return false
  }
}

const readFeatureSupport = () =>
  Object.fromEntries(
    FEATURE_SUPPORT_CHECKS.map((check) => [
      check.key,
      safeCssSupports(check.property, check.value),
    ]),
  )

const readStylesheets = (): ClientDiagnosticStylesheet[] => {
  if (typeof document === 'undefined') {
    return []
  }

  return Array.from(document.styleSheets).map((sheet) => {
    let cssRuleCount: number | null = null
    try {
      cssRuleCount = sheet.cssRules.length
    } catch {
      cssRuleCount = null
    }

    return {
      href: sheet.href ?? null,
      owner_node:
        sheet.ownerNode instanceof Element
          ? sheet.ownerNode.tagName.toLowerCase()
          : null,
      media: sheet.media?.mediaText?.trim() || null,
      disabled: sheet.disabled,
      css_rule_count: cssRuleCount,
    }
  })
}

const collectResourceTargets = () => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return []
  }

  const resources = new Map<string, ClientDiagnosticResourceProbe['kind']>()
  const pushResource = (
    url: string | null | undefined,
    kind: ClientDiagnosticResourceProbe['kind'],
  ) => {
    const trimmedUrl = url?.trim()
    if (!trimmedUrl) {
      return
    }

    try {
      const resolvedUrl = new URL(trimmedUrl, window.location.href)
      if (!/^https?:$/i.test(resolvedUrl.protocol)) {
        return
      }

      resources.set(resolvedUrl.toString(), kind)
    } catch {
      return
    }
  }

  for (const stylesheet of document.styleSheets) {
    pushResource(stylesheet.href, 'stylesheet')
  }

  for (const script of Array.from(document.scripts)) {
    pushResource(script.src, 'script')
  }

  for (const manifestLink of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="manifest"]'))) {
    pushResource(manifestLink.href, 'manifest')
  }

  for (const iconLink of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"]'))) {
    pushResource(iconLink.href, 'icon')
  }

  return Array.from(resources.entries())
    .slice(0, 20)
    .map(([url, kind]) => ({ url, kind }))
}

const probeResource = async (
  target: Pick<ClientDiagnosticResourceProbe, 'url' | 'kind'>,
): Promise<ClientDiagnosticResourceProbe> => {
  const attemptFetch = async (method: 'HEAD' | 'GET') =>
    fetch(target.url, {
      method,
      cache: 'no-store',
      redirect: 'follow',
    })

  try {
    let response = await attemptFetch('HEAD')
    if (response.status === 405 || response.status === 501) {
      response = await attemptFetch('GET')
    }

    return {
      url: target.url,
      kind: target.kind,
      ok: response.ok,
      status: response.status,
      content_type: response.headers.get('content-type'),
      cache_control: response.headers.get('cache-control'),
      error: null,
    }
  } catch (error) {
    return {
      url: target.url,
      kind: target.kind,
      ok: false,
      status: null,
      content_type: null,
      cache_control: null,
      error: error instanceof Error ? error.message : 'Unknown fetch failure',
    }
  }
}

const readPerformanceEntries = (): ClientDiagnosticPerformanceEntry[] => {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    return []
  }

  return performance
    .getEntriesByType('resource')
    .map((entry) => entry as PerformanceResourceTiming)
    .filter((entry) => {
      const normalizedName = entry.name.toLowerCase()
      return (
        normalizedName.includes('.css') ||
        normalizedName.includes('.js') ||
        normalizedName.includes('manifest') ||
        entry.initiatorType === 'link' ||
        entry.initiatorType === 'script'
      )
    })
    .slice(-40)
    .map((entry) => ({
      name: entry.name,
      initiator_type: entry.initiatorType || null,
      duration_ms: roundNumber(entry.duration),
      transfer_size:
        typeof entry.transferSize === 'number' ? entry.transferSize : null,
      decoded_body_size:
        typeof entry.decodedBodySize === 'number'
          ? entry.decodedBodySize
          : null,
    }))
}

const readThemeVariables = () => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return {}
  }

  const computedStyle = window.getComputedStyle(document.documentElement)
  return Object.fromEntries(
    THEME_VARIABLE_NAMES.map((variableName) => [
      variableName,
      computedStyle.getPropertyValue(variableName).trim() || '(empty)',
    ]),
  )
}

const readElementSnapshot = (
  selector: string,
): ClientDiagnosticElementSnapshot => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return {
      selector,
      found: false,
      text_preview: null,
      rect: null,
      computed: {},
    }
  }

  const element = document.querySelector<HTMLElement>(selector)
  if (!element) {
    return {
      selector,
      found: false,
      text_preview: null,
      rect: null,
      computed: {},
    }
  }

  const rect = element.getBoundingClientRect()
  const computedStyle = window.getComputedStyle(element)
  return {
    selector,
    found: true,
    text_preview: normalizeText(element.textContent),
    rect: {
      x: roundNumber(rect.x),
      y: roundNumber(rect.y),
      width: roundNumber(rect.width),
      height: roundNumber(rect.height),
    },
    computed: Object.fromEntries(
      COMPUTED_STYLE_KEYS.map((key) => [
        key,
        computedStyle.getPropertyValue(key).trim() || '(empty)',
      ]),
    ),
  }
}

const readServiceWorkerDiagnostics = async (): Promise<ClientDiagnosticServiceWorker> => {
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
        active_script_url: registration.active?.scriptURL ?? null,
        waiting_script_url: registration.waiting?.scriptURL ?? null,
        installing_script_url: registration.installing?.scriptURL ?? null,
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

const readCacheDiagnostics = async () => {
  if (typeof window === 'undefined' || !('caches' in window)) {
    return {
      supported: false,
      keys: [],
    }
  }

  try {
    return {
      supported: true,
      keys: await window.caches.keys(),
    }
  } catch {
    return {
      supported: true,
      keys: [],
    }
  }
}

const buildNotes = (report: ClientDiagnosticReport) => {
  const notes: string[] = []

  if (!report.feature_support['color-mix-oklab']) {
    notes.push(
      '当前浏览器不支持 color-mix(in oklab, ...)，混色背景会直接失效，常见现象就是输入区或面板背景透明。',
    )
  }

  if (
    !report.feature_support['backdrop-filter'] &&
    !report.feature_support['webkit-backdrop-filter']
  ) {
    notes.push('当前浏览器不支持 backdrop-filter，磨砂浮层会退化成纯色面板。')
  }

  if (report.service_worker.controller && report.cache.keys.length > 0) {
    notes.push(
      `检测到 ${report.cache.keys.length} 个 Cache Storage 项，若真机页面和桌面不一致，可以先清理缓存再重试。`,
    )
  }

  if (report.stylesheets.length === 0) {
    notes.push('当前页面没有读取到任何样式表对象，需要重点检查 CSS 是否被正确加载。')
  }

  if (report.resource_probes.some((entry) => !entry.ok)) {
    notes.push('至少有一个静态资源探测失败，需要继续检查网络、缓存或 Service Worker 拦截。')
  }

  return notes
}

export const collectClientDiagnostics = async (): Promise<ClientDiagnosticReport> => {
  const resourceTargets = collectResourceTargets()
  const [serviceWorker, cache, resourceProbes] = await Promise.all([
    readServiceWorkerDiagnostics(),
    readCacheDiagnostics(),
    Promise.all(resourceTargets.map((target) => probeResource(target))),
  ])

  const navigatorWithHints = navigator as NavigatorWithDeviceHints
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    device_pixel_ratio: window.devicePixelRatio || 1,
    visual_width: window.visualViewport?.width ?? null,
    visual_height: window.visualViewport?.height ?? null,
    screen_width: window.screen?.width ?? null,
    screen_height: window.screen?.height ?? null,
  }

  const report: ClientDiagnosticReport = {
    captured_at: new Date().toISOString(),
    page: {
      href: window.location.href,
      pathname: window.location.pathname,
      referrer: normalizeText(document.referrer),
      visibility_state: document.visibilityState ?? null,
    },
    environment: {
      user_agent: navigator.userAgent,
      language: navigator.language ?? null,
      languages: Array.isArray(navigator.languages) ? navigator.languages : [],
      platform: navigator.platform ?? null,
      vendor: navigator.vendor ?? null,
      online: typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
      cookie_enabled:
        typeof navigator.cookieEnabled === 'boolean'
          ? navigator.cookieEnabled
          : null,
      secure_context: window.isSecureContext,
      standalone_display_mode: window.matchMedia('(display-mode: standalone)').matches,
      hardware_concurrency:
        typeof navigator.hardwareConcurrency === 'number'
          ? navigator.hardwareConcurrency
          : null,
      device_memory_gb:
        typeof navigatorWithHints.deviceMemory === 'number'
          ? navigatorWithHints.deviceMemory
          : null,
      max_touch_points:
        typeof navigator.maxTouchPoints === 'number'
          ? navigator.maxTouchPoints
          : null,
    },
    viewport,
    feature_support: readFeatureSupport(),
    service_worker: serviceWorker,
    cache,
    manifest: {
      href:
        document.querySelector<HTMLLinkElement>('link[rel~="manifest"]')?.href ??
        null,
      rel:
        document.querySelector<HTMLLinkElement>('link[rel~="manifest"]')?.rel ??
        null,
    },
    stylesheets: readStylesheets(),
    resource_probes: resourceProbes,
    performance_entries: readPerformanceEntries(),
    theme_variables: readThemeVariables(),
    element_snapshots: ELEMENT_SNAPSHOT_SELECTORS.map((selector) =>
      readElementSnapshot(selector),
    ),
    notes: [],
  }

  report.notes = buildNotes(report)
  return report
}
