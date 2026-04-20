import { Capacitor } from '@capacitor/core'

export type PandaPlatform = 'web' | 'android' | 'ios'

const readCapacitorPlatform = () => {
  try {
    const platform = Capacitor.getPlatform?.()
    if (platform === 'android' || platform === 'ios') {
      return platform
    }
  } catch {
    // Fall back to browser heuristics.
  }

  return 'web'
}

export const readPandaPlatform = (): PandaPlatform => readCapacitorPlatform()

export const isNativePlatform = () => {
  try {
    return Capacitor.isNativePlatform?.() === true
  } catch {
    return false
  }
}

export const isAndroidApp = () =>
  readPandaPlatform() === 'android' && isNativePlatform()

export const isIosApp = () => readPandaPlatform() === 'ios' && isNativePlatform()

export const isNativeApp = () => isAndroidApp() || isIosApp()
