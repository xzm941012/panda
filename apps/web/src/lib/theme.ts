import themeCatalog from './codex-theme-catalog.json'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ThemeAppearance = 'light' | 'dark'
export type ResolvedThemeMode = ThemeAppearance
export type LightThemeId = string
export type DarkThemeId = string
export type LightThemePresetId = LightThemeId
export type DarkThemePresetId = DarkThemeId

export interface ThemeFonts {
  ui: string | null
  code: string | null
}

export interface ThemeSemanticColors {
  diffAdded: string
  diffRemoved: string
  skill: string
}

export interface ThemeVariantTheme {
  accent: string
  contrast: number
  fonts: ThemeFonts
  ink: string
  opaqueWindows: boolean
  semanticColors: ThemeSemanticColors
  surface: string
}

export interface ThemeVariantSource {
  codeThemeId: string
  theme: ThemeVariantTheme
  variant: ThemeAppearance
}

export interface ThemeCatalogEntry {
  id: string
  light?: ThemeVariantSource
  dark?: ThemeVariantSource
}

export interface ThemePreset {
  id: string
  label: string
  codeThemeId: string
  variant: ThemeAppearance
  accent: string
  background: string
  foreground: string
  contrast: number
  opaqueWindows: boolean
  semanticColors: ThemeSemanticColors
  fonts: ThemeFonts
}

export type LightThemePreset = ThemePreset & { variant: 'light' }
export type DarkThemePreset = ThemePreset & { variant: 'dark' }

export interface ThemeSettings {
  mode: ThemeMode
  lightThemeId: LightThemeId
  darkThemeId: DarkThemeId
  uiFontSize: number
  codeFontSize: number
}

export interface ResolvedThemeSettings extends ThemeSettings {
  appearance: ThemeAppearance
  lightTheme: LightThemePreset
  darkTheme: DarkThemePreset
  activeTheme: ThemePreset
  uiFontFamily: string
  codeFontFamily: string
}

export const THEME_STORAGE_KEY = 'panda:theme-settings'
export const DEFAULT_UI_FONT_SIZE = 13
export const DEFAULT_CODE_FONT_SIZE = 12
export const DEFAULT_LIGHT_THEME_ID = 'codex'
export const DEFAULT_DARK_THEME_ID = 'codex'

export const UI_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", sans-serif'

export const CODE_FONT_STACK =
  'ui-monospace, "SFMono-Regular", "SF Mono", "Cascadia Mono", "Cascadia Code", Consolas, monospace'

const FONT_GENERIC_FAMILY_PATTERN =
  /\b(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|emoji|math|fangsong|ui-serif|ui-sans-serif|ui-monospace|ui-rounded)\b/i

const withFontFallback = (value: string | null | undefined, fallback: string) => {
  const input = value?.trim()

  if (!input) {
    return fallback
  }

  return FONT_GENERIC_FAMILY_PATTERN.test(input) ? input : `${input}, ${fallback}`
}

const THEME_LABELS: Record<string, string> = {
  absolutely: 'Absolutely',
  ayu: 'Ayu',
  catppuccin: 'Catppuccin',
  codex: 'Codex',
  dracula: 'Dracula',
  everforest: 'Everforest',
  github: 'GitHub',
  gruvbox: 'Gruvbox',
  linear: 'Linear',
  lobster: 'Lobster',
  material: 'Material',
  matrix: 'Matrix',
  monokai: 'Monokai',
  'night-owl': 'Night Owl',
  nord: 'Nord',
  notion: 'Notion',
  one: 'One',
  oscurange: 'Oscurange',
  proof: 'Proof',
  'rose-pine': 'Rose Pine',
  sentry: 'Sentry',
  solarized: 'Solarized',
  temple: 'Temple',
  'tokyo-night': 'Tokyo Night',
  'vscode-plus': 'VSCode Plus',
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const normalizeHex = (value: string, fallback: string) => {
  const input = value.trim()
  const match = input.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)

  if (!match) {
    return fallback
  }

  const [, hex] = match
  const fullHex =
    hex.length === 3
      ? hex
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : hex

  return `#${fullHex.toUpperCase()}`
}

const hexToRgb = (hex: string) => {
  const safeHex = normalizeHex(hex, '#000000').slice(1)
  return {
    r: Number.parseInt(safeHex.slice(0, 2), 16),
    g: Number.parseInt(safeHex.slice(2, 4), 16),
    b: Number.parseInt(safeHex.slice(4, 6), 16),
  }
}

const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`

const mixHex = (source: string, target: string, ratio: number) => {
  const a = hexToRgb(source)
  const b = hexToRgb(target)
  const weight = clamp(ratio, 0, 1)

  return rgbToHex(
    a.r + (b.r - a.r) * weight,
    a.g + (b.g - a.g) * weight,
    a.b + (b.b - a.b) * weight,
  )
}

const getRelativeLuminance = (hex: string) => {
  const { r, g, b } = hexToRgb(hex)

  const transform = (channel: number) => {
    const normalized = channel / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }

  return (
    transform(r) * 0.2126 +
    transform(g) * 0.7152 +
    transform(b) * 0.0722
  )
}

const getReadableTextColor = (hex: string) =>
  getRelativeLuminance(hex) > 0.5 ? '#0D1117' : '#FFFFFF'

const withTransparency = (hex: string, ratio: number) => {
  const percentage = Math.round(clamp(ratio, 0, 1) * 100)
  return percentage >= 100
    ? hex
    : `color-mix(in srgb, ${hex} ${percentage}%, transparent)`
}

const themeCatalogEntries = (themeCatalog as { themes: ThemeCatalogEntry[] }).themes

const buildThemePreset = (
  entry: ThemeCatalogEntry,
  variant: ThemeAppearance,
): ThemePreset | null => {
  const source = variant === 'light' ? entry.light : entry.dark
  if (!source) {
    return null
  }

  return {
    id: entry.id,
    label: THEME_LABELS[entry.id] ?? entry.id,
    codeThemeId: source.codeThemeId,
    variant,
    accent: normalizeHex(source.theme.accent, '#0169CC'),
    background: normalizeHex(source.theme.surface, '#FFFFFF'),
    foreground: normalizeHex(source.theme.ink, '#0D0D0D'),
    contrast: clamp(Number(source.theme.contrast), 0, 100),
    opaqueWindows: Boolean(source.theme.opaqueWindows),
    semanticColors: {
      diffAdded: normalizeHex(source.theme.semanticColors.diffAdded, '#00A240'),
      diffRemoved: normalizeHex(source.theme.semanticColors.diffRemoved, '#E02E2A'),
      skill: normalizeHex(source.theme.semanticColors.skill, '#751ED9'),
    },
    fonts: {
      ui: source.theme.fonts.ui?.trim() || null,
      code: source.theme.fonts.code?.trim() || null,
    },
  }
}

export const LIGHT_THEME_PRESETS: LightThemePreset[] = themeCatalogEntries
  .map((entry) => buildThemePreset(entry, 'light'))
  .filter((preset): preset is LightThemePreset => Boolean(preset))

export const DARK_THEME_PRESETS: DarkThemePreset[] = themeCatalogEntries
  .map((entry) => buildThemePreset(entry, 'dark'))
  .filter((preset): preset is DarkThemePreset => Boolean(preset))

export const DARK_THEME_PALETTE: DarkThemePreset =
  DARK_THEME_PRESETS.find((preset) => preset.id === DEFAULT_DARK_THEME_ID) ??
  DARK_THEME_PRESETS[0]!

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  mode: 'system',
  lightThemeId: DEFAULT_LIGHT_THEME_ID,
  darkThemeId: DEFAULT_DARK_THEME_ID,
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
}

export const clampUiFontSize = (value: number) => clamp(Number(value), 11, 18)
export const clampCodeFontSize = (value: number) => clamp(Number(value), 10, 18)

export const getSystemThemeAppearance = (): ThemeAppearance =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'

export const getLightThemePreset = (themeId: LightThemeId) =>
  LIGHT_THEME_PRESETS.find((preset) => preset.id === themeId) ?? LIGHT_THEME_PRESETS[0]!

export const getDarkThemePreset = (themeId: DarkThemeId) =>
  DARK_THEME_PRESETS.find((preset) => preset.id === themeId) ?? DARK_THEME_PRESETS[0]!

export const createThemeSettingsFromPreset = (
  themeId: string,
  currentSettings: ThemeSettings = DEFAULT_THEME_SETTINGS,
  appearance: ThemeAppearance = 'light',
): ThemeSettings =>
  appearance === 'dark'
    ? {
        ...currentSettings,
        darkThemeId: getDarkThemePreset(themeId).id,
      }
    : {
        ...currentSettings,
        lightThemeId: getLightThemePreset(themeId).id,
      }

export const normalizeThemeSettings = (value: Partial<ThemeSettings> | undefined): ThemeSettings => ({
  mode:
    value?.mode === 'light' || value?.mode === 'dark' || value?.mode === 'system'
      ? value.mode
      : DEFAULT_THEME_SETTINGS.mode,
  lightThemeId: getLightThemePreset(value?.lightThemeId ?? DEFAULT_LIGHT_THEME_ID).id,
  darkThemeId: getDarkThemePreset(value?.darkThemeId ?? DEFAULT_DARK_THEME_ID).id,
  uiFontSize: clampUiFontSize(value?.uiFontSize ?? DEFAULT_THEME_SETTINGS.uiFontSize),
  codeFontSize: clampCodeFontSize(value?.codeFontSize ?? DEFAULT_THEME_SETTINGS.codeFontSize),
})

export const sanitizeThemeSettings = normalizeThemeSettings

export const readStoredThemeSettings = (): ThemeSettings => {
  if (typeof window === 'undefined') {
    return DEFAULT_THEME_SETTINGS
  }

  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (!raw) {
      return DEFAULT_THEME_SETTINGS
    }

    return normalizeThemeSettings(JSON.parse(raw) as Partial<ThemeSettings>)
  } catch {
    return DEFAULT_THEME_SETTINGS
  }
}

export const writeStoredThemeSettings = (settings: ThemeSettings) => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify(normalizeThemeSettings(settings)),
    )
  } catch {
    // Ignore storage failures; theme persistence is best-effort only.
  }
}

export const resolveThemeMode = (
  themeMode: ThemeMode,
  systemMode: ResolvedThemeMode,
): ResolvedThemeMode => (themeMode === 'system' ? systemMode : themeMode)

export const resolveThemeSettings = (
  settings: ThemeSettings,
  systemAppearance: ThemeAppearance = getSystemThemeAppearance(),
): ResolvedThemeSettings => {
  const normalized = normalizeThemeSettings(settings)
  const appearance = resolveThemeMode(normalized.mode, systemAppearance)
  const lightTheme = getLightThemePreset(normalized.lightThemeId)
  const darkTheme = getDarkThemePreset(normalized.darkThemeId)
  const activeTheme = appearance === 'dark' ? darkTheme : lightTheme

  return {
    ...normalized,
    appearance,
    lightTheme,
    darkTheme,
    activeTheme,
    uiFontFamily: withFontFallback(activeTheme.fonts.ui, UI_FONT_STACK),
    codeFontFamily: withFontFallback(activeTheme.fonts.code, CODE_FONT_STACK),
  }
}

export const subscribeToSystemTheme = (
  listener: (appearance: ThemeAppearance) => void,
) => {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const handleChange = () => {
    listener(mediaQuery.matches ? 'dark' : 'light')
  }

  handleChange()
  mediaQuery.addEventListener('change', handleChange)

  return () => {
    mediaQuery.removeEventListener('change', handleChange)
  }
}

const buildThemeVariables = (
  settings: ThemeSettings,
  resolvedMode: ResolvedThemeMode,
) => {
  const resolved = resolveThemeSettings(settings, resolvedMode)
  const source = resolved.activeTheme
  const isDark = resolvedMode === 'dark'
  const contrastDelta = (source.contrast - (isDark ? 60 : 45)) / 100

  const success = source.semanticColors.diffAdded
  const danger = source.semanticColors.diffRemoved
  const skill = source.semanticColors.skill
  const successRgb = hexToRgb(success)
  const dangerRgb = hexToRgb(danger)
  const skillRgb = hexToRgb(skill)
  const accentRgb = hexToRgb(source.accent)
  const backgroundRgb = hexToRgb(source.background)
  const foregroundRgb = hexToRgb(source.foreground)

  const surfaceBase = source.background
  const surfaceElevated = isDark
    ? mixHex(source.background, '#FFFFFF', 0.05 + contrastDelta * 0.08)
    : mixHex(source.background, '#FFFFFF', 0.42 + contrastDelta * 0.16)
  const surfacePanel = isDark
    ? mixHex(source.background, '#FFFFFF', 0.07 + contrastDelta * 0.08)
    : mixHex(source.background, '#FFFFFF', 0.78 + contrastDelta * 0.1)
  const surfaceRaised = isDark
    ? mixHex(source.background, '#FFFFFF', 0.1 + contrastDelta * 0.08)
    : mixHex(source.background, '#FFFFFF', 0.56 + contrastDelta * 0.14)
  const surfacePanelStrong = isDark
    ? mixHex(source.background, '#FFFFFF', 0.14 + contrastDelta * 0.08)
    : mixHex(source.background, source.foreground, 0.1 + contrastDelta * 0.12)
  const surfaceSidebar = isDark
    ? mixHex(source.background, '#000000', 0.08 - contrastDelta * 0.06)
    : mixHex(source.background, source.foreground, 0.03 + contrastDelta * 0.08)
  const surfaceSidebarElevated = isDark
    ? mixHex(source.background, '#FFFFFF', 0.08 + contrastDelta * 0.06)
    : mixHex(source.background, source.foreground, 0.06 + contrastDelta * 0.08)
  const surfaceBorder = isDark
    ? mixHex(source.background, '#FFFFFF', 0.14 + contrastDelta * 0.08)
    : mixHex(source.background, source.foreground, 0.14 + contrastDelta * 0.1)
  const surfaceBorderStrong = isDark
    ? mixHex(source.background, '#FFFFFF', 0.22 + contrastDelta * 0.08)
    : mixHex(source.background, source.foreground, 0.22 + contrastDelta * 0.1)
  const surfaceBorderSoft = isDark
    ? mixHex(source.background, '#FFFFFF', 0.08 + contrastDelta * 0.04)
    : mixHex(source.background, source.foreground, 0.1 + contrastDelta * 0.08)
  const textPrimary = source.foreground
  const textSecondary = isDark
    ? mixHex(source.foreground, source.background, 0.28 - contrastDelta * 0.1)
    : mixHex(source.foreground, source.background, 0.5 - contrastDelta * 0.14)
  const textMuted = isDark
    ? mixHex(source.foreground, source.background, 0.46 - contrastDelta * 0.1)
    : mixHex(source.foreground, source.background, 0.64 - contrastDelta * 0.14)
  const textTertiary = mixHex(source.foreground, source.background, isDark ? 0.58 : 0.74)
  const accentPrimary = source.accent
  const accentSecondary = isDark
    ? mixHex(source.accent, '#FFFFFF', 0.18)
    : mixHex(source.accent, '#FFFFFF', 0.24)
  const accentPrimarySoft = isDark
    ? mixHex(source.accent, source.background, 0.78)
    : mixHex(source.accent, source.background, 0.88)
  const accentSecondarySoft = isDark
    ? mixHex(source.accent, source.background, 0.84)
    : mixHex(source.accent, source.background, 0.92)
  const accentContrast = getReadableTextColor(accentPrimary)
  const inlineCodeBackground = isDark
    ? mixHex(source.background, '#FFFFFF', 0.1)
    : mixHex(source.background, source.foreground, 0.08)
  const codeBackground = isDark
    ? mixHex(source.background, '#000000', 0.06)
    : mixHex(source.background, source.foreground, 0.035)
  const codeMutedBackground = isDark
    ? mixHex(source.background, '#FFFFFF', 0.05)
    : mixHex(source.background, source.foreground, 0.06)
  const codeGutterBackground = isDark
    ? mixHex(source.background, '#FFFFFF', 0.03)
    : mixHex(source.background, source.foreground, 0.085)
  const codeMetaBackground = isDark
    ? mixHex(source.background, '#FFFFFF', 0.065)
    : mixHex(source.background, source.foreground, 0.05)
  const codeMetaText = mixHex(source.foreground, source.background, isDark ? 0.42 : 0.68)
  const tooltipBase = isDark
    ? mixHex(source.background, '#FFFFFF', 0.08)
    : mixHex(source.foreground, source.background, 0.18)
  const hoverSurface = isDark
    ? mixHex(source.background, '#FFFFFF', 0.08)
    : mixHex(source.background, source.foreground, 0.06)
  const pressedSurface = isDark
    ? mixHex(source.background, '#FFFFFF', 0.12)
    : mixHex(source.background, source.foreground, 0.1)
  const divider = isDark
    ? mixHex(source.background, '#FFFFFF', 0.14 + contrastDelta * 0.05)
    : mixHex(source.background, source.foreground, 0.12 + contrastDelta * 0.08)

  const windowOpacity = source.opaqueWindows ? 1 : isDark ? 0.92 : 0.95
  const sidebarOpacity = source.opaqueWindows ? 1 : isDark ? 0.94 : 0.965
  const tooltipOpacity = source.opaqueWindows ? 1 : 0.94

  return {
    '--theme-id': source.id,
    '--theme-code-theme-id': source.codeThemeId,
    '--theme-window-opaque': source.opaqueWindows ? '1' : '0',
    '--theme-accent': accentPrimary,
    '--theme-accent-rgb': `${accentRgb.r} ${accentRgb.g} ${accentRgb.b}`,
    '--theme-background': source.background,
    '--theme-background-rgb': `${backgroundRgb.r} ${backgroundRgb.g} ${backgroundRgb.b}`,
    '--theme-foreground': source.foreground,
    '--theme-foreground-rgb': `${foregroundRgb.r} ${foregroundRgb.g} ${foregroundRgb.b}`,
    '--theme-shadow-rgb': isDark ? '0 0 0' : '39 28 17',
    '--theme-ui-font': resolved.uiFontFamily,
    '--theme-code-font': resolved.codeFontFamily,
    '--theme-ui-font-size': `${resolved.uiFontSize}px`,
    '--theme-code-font-size': `${resolved.codeFontSize}px`,
    '--color-surface-base': surfaceBase,
    '--color-surface-elevated': surfaceElevated,
    '--color-surface-panel': surfacePanel,
    '--color-surface-raised': surfaceRaised,
    '--color-surface-panel-strong': surfacePanelStrong,
    '--color-surface-sidebar': withTransparency(surfaceSidebar, sidebarOpacity),
    '--color-surface-sidebar-elevated': withTransparency(surfaceSidebarElevated, sidebarOpacity),
    '--color-surface-border': surfaceBorder,
    '--color-surface-border-strong': surfaceBorderStrong,
    '--color-surface-border-soft': surfaceBorderSoft,
    '--color-surface-overlay': withTransparency(surfacePanelStrong, windowOpacity),
    '--color-surface-floating': withTransparency(surfacePanel, windowOpacity),
    '--color-surface-tooltip': withTransparency(tooltipBase, tooltipOpacity),
    '--color-surface-code': codeBackground,
    '--color-surface-code-muted': codeMutedBackground,
    '--color-surface-code-gutter': codeGutterBackground,
    '--color-surface-code-meta': codeMetaBackground,
    '--color-surface-inline-code': inlineCodeBackground,
    '--color-surface-hover': hoverSurface,
    '--color-surface-pressed': pressedSurface,
    '--color-surface-danger-soft': withTransparency(danger, isDark ? 0.14 : 0.08),
    '--color-surface-success-soft': withTransparency(success, isDark ? 0.14 : 0.08),
    '--color-text-primary': textPrimary,
    '--color-text-secondary': textSecondary,
    '--color-text-muted': textMuted,
    '--color-text-tertiary': textTertiary,
    '--color-text-on-accent': accentContrast,
    '--color-text-link': accentPrimary,
    '--color-text-link-hover': accentSecondary,
    '--color-text-danger': danger,
    '--color-text-success': success,
    '--color-accent-primary': accentPrimary,
    '--color-accent-primary-soft': accentPrimarySoft,
    '--color-accent-secondary': accentSecondary,
    '--color-accent-secondary-soft': accentSecondarySoft,
    '--color-accent-contrast': accentContrast,
    '--color-accent-primary-rgb': `${accentRgb.r} ${accentRgb.g} ${accentRgb.b}`,
    '--color-success': success,
    '--color-warning': mixHex(source.accent, success, 0.35),
    '--color-danger': danger,
    '--color-status-online': accentPrimary,
    '--color-status-offline': isDark ? '#76808A' : '#A5ACA4',
    '--color-skill': skill,
    '--color-skill-rgb': `${skillRgb.r} ${skillRgb.g} ${skillRgb.b}`,
    '--color-code-keyword': skill,
    '--color-code-title': accentPrimary,
    '--color-code-string': mixHex(success, source.foreground, isDark ? 0.26 : 0.18),
    '--color-code-number': mixHex(skill, accentPrimary, 0.36),
    '--color-code-comment': mixHex(source.foreground, source.background, isDark ? 0.52 : 0.72),
    '--color-code-meta-text': codeMetaText,
    '--color-code-add': success,
    '--color-code-add-rgb': `${successRgb.r} ${successRgb.g} ${successRgb.b}`,
    '--color-code-add-bg': withTransparency(success, isDark ? 0.16 : 0.11),
    '--color-code-remove': danger,
    '--color-code-remove-rgb': `${dangerRgb.r} ${dangerRgb.g} ${dangerRgb.b}`,
    '--color-code-remove-bg': withTransparency(danger, isDark ? 0.18 : 0.11),
    '--color-divider': divider,
    '--color-overlay-scrim': source.opaqueWindows
      ? isDark
        ? 'rgba(8, 10, 12, 0.66)'
        : 'rgba(23, 20, 17, 0.14)'
      : isDark
        ? 'rgba(8, 10, 12, 0.54)'
        : 'rgba(23, 20, 17, 0.09)',
    '--shadow-soft': isDark
      ? '0 24px 54px rgba(0, 0, 0, 0.34)'
      : '0 24px 54px rgba(24, 18, 12, 0.08)',
    '--shadow-panel': isDark
      ? '0 10px 26px rgba(0, 0, 0, 0.24)'
      : '0 10px 26px rgba(37, 23, 10, 0.06)',
    '--shadow-sm': isDark
      ? '0 2px 12px rgba(0, 0, 0, 0.18)'
      : '0 2px 12px rgba(37, 23, 10, 0.05)',
    '--shadow-overlay': isDark
      ? '0 20px 44px rgba(0, 0, 0, 0.36)'
      : '0 18px 40px rgba(42, 26, 12, 0.1)',
    '--font-display': resolved.uiFontFamily,
    '--font-sans': resolved.uiFontFamily,
    '--font-mono': resolved.codeFontFamily,
    '--font-size-ui-base': `${resolved.uiFontSize}px`,
    '--font-size-code-base': `${resolved.codeFontSize}px`,
  } as Record<string, string>
}

export const applyThemeToDocument = (
  settings: ThemeSettings,
  systemAppearance: ThemeAppearance = getSystemThemeAppearance(),
) => {
  if (typeof document === 'undefined') {
    return
  }

  const resolved = resolveThemeSettings(settings, systemAppearance)
  const variables = buildThemeVariables(resolved, resolved.appearance)
  const root = document.documentElement

  root.dataset.theme = resolved.appearance
  root.dataset.uiTheme = resolved.appearance
  root.dataset.themeId = resolved.activeTheme.id
  root.dataset.codeThemeId = resolved.activeTheme.codeThemeId
  root.dataset.windowStyle = resolved.activeTheme.opaqueWindows ? 'opaque' : 'soft'
  root.style.colorScheme = resolved.appearance

  for (const [key, value] of Object.entries(variables)) {
    root.style.setProperty(key, value)
  }
}
