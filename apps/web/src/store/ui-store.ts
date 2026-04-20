import { create } from 'zustand'
import {
  createThemeSettingsFromPreset,
  getDarkThemePreset,
  getSystemThemeAppearance,
  getLightThemePreset,
  normalizeThemeSettings,
  readStoredThemeSettings,
  resolveThemeSettings,
  type DarkThemePresetId,
  type LightThemePresetId,
  type ThemeAppearance,
  type ThemeMode,
  type ThemeSettings,
  writeStoredThemeSettings,
} from '../lib/theme'

type PanelTab = 'git' | 'runtime' | 'preview' | 'approvals'

const initialThemeSettings = readStoredThemeSettings()
const initialSystemAppearance = getSystemThemeAppearance()

interface UiState {
  panelTab: PanelTab
  composerText: string
  activeSessionId: string | null
  bottomNavVisible: boolean
  isSettingsOverlayOpen: boolean
  themeSettings: ThemeSettings
  systemAppearance: ThemeAppearance
  resolvedTheme: ReturnType<typeof resolveThemeSettings>
  setPanelTab: (panelTab: PanelTab) => void
  setComposerText: (composerText: string) => void
  setActiveSessionId: (id: string | null) => void
  setBottomNavVisible: (visible: boolean) => void
  openSettingsOverlay: () => void
  closeSettingsOverlay: () => void
  setThemeMode: (mode: ThemeMode) => void
  setLightThemeId: (lightThemeId: LightThemePresetId) => void
  setDarkThemeId: (darkThemeId: DarkThemePresetId) => void
  setUiFontSize: (size: number) => void
  setCodeFontSize: (size: number) => void
  setSystemAppearance: (appearance: ThemeAppearance) => void
}

export const useUiStore = create<UiState>((set) => ({
  panelTab: 'git',
  composerText: '',
  activeSessionId: null,
  bottomNavVisible: true,
  isSettingsOverlayOpen: false,
  themeSettings: initialThemeSettings,
  systemAppearance: initialSystemAppearance,
  resolvedTheme: resolveThemeSettings(initialThemeSettings, initialSystemAppearance),
  setPanelTab: (panelTab) => set({ panelTab }),
  setComposerText: (composerText) => set({ composerText }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setBottomNavVisible: (bottomNavVisible) => set({ bottomNavVisible }),
  openSettingsOverlay: () => set({ isSettingsOverlayOpen: true }),
  closeSettingsOverlay: () => set({ isSettingsOverlayOpen: false }),
  setThemeMode: (mode) =>
    set((state) => {
      const themeSettings = normalizeThemeSettings({
        ...state.themeSettings,
        mode,
      })
      writeStoredThemeSettings(themeSettings)
      return {
        themeSettings,
        resolvedTheme: resolveThemeSettings(themeSettings, state.systemAppearance),
      }
    }),
  setLightThemeId: (lightThemeId) =>
    set((state) => {
      const themeSettings = normalizeThemeSettings(
        createThemeSettingsFromPreset(
          getLightThemePreset(lightThemeId).id,
          state.themeSettings,
          'light',
        ),
      )
      writeStoredThemeSettings(themeSettings)
      return {
        themeSettings,
        resolvedTheme: resolveThemeSettings(themeSettings, state.systemAppearance),
      }
    }),
  setDarkThemeId: (darkThemeId) =>
    set((state) => {
      const themeSettings = normalizeThemeSettings({
        ...createThemeSettingsFromPreset(
          getDarkThemePreset(darkThemeId).id,
          state.themeSettings,
          'dark',
        ),
      })
      writeStoredThemeSettings(themeSettings)
      return {
        themeSettings,
        resolvedTheme: resolveThemeSettings(themeSettings, state.systemAppearance),
      }
    }),
  setUiFontSize: (uiFontSize) =>
    set((state) => {
      const themeSettings = normalizeThemeSettings({
        ...state.themeSettings,
        uiFontSize,
      })
      writeStoredThemeSettings(themeSettings)
      return {
        themeSettings,
        resolvedTheme: resolveThemeSettings(themeSettings, state.systemAppearance),
      }
    }),
  setCodeFontSize: (codeFontSize) =>
    set((state) => {
      const themeSettings = normalizeThemeSettings({
        ...state.themeSettings,
        codeFontSize,
      })
      writeStoredThemeSettings(themeSettings)
      return {
        themeSettings,
        resolvedTheme: resolveThemeSettings(themeSettings, state.systemAppearance),
      }
    }),
  setSystemAppearance: (systemAppearance) =>
    set((state) => ({
      systemAppearance,
      resolvedTheme: resolveThemeSettings(state.themeSettings, systemAppearance),
    })),
}))
