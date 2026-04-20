import { App } from '@capacitor/app'
import { isAndroidApp, isNativeApp } from './platform'

type NativeSafeAreaBridge = {
  getTopInsetPx?: () => number
  getRightInsetPx?: () => number
  getBottomInsetPx?: () => number
  getLeftInsetPx?: () => number
  getKeyboardInsetPx?: () => number
}

declare global {
  interface Window {
    PandaSafeArea?: NativeSafeAreaBridge
  }
}

const DEFAULT_ANDROID_STATUSBAR_TOP_PX = 24
const MAX_ANDROID_STATUSBAR_TOP_PX = 32
const MIN_NATIVE_KEYBOARD_INSET_PX = 72
const NATIVE_SAFE_AREA_CHANGE_EVENT = 'panda:native-safe-area-change'

const toCssPixels = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 0
  }

  const cssPixelRatio =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1

  return Math.max(0, numeric / cssPixelRatio)
}

const toPixelString = (value: unknown) => `${Math.round(toCssPixels(value) * 100) / 100}px`

const toRoundedPixelString = (value: number) => `${Math.round(value * 100) / 100}px`

const toTopInsetPixelString = (value: unknown) => {
  const cssPixels = toCssPixels(value)
  if (!isAndroidApp()) {
    return `${Math.round(cssPixels * 100) / 100}px`
  }

  const stabilizedPixels = Math.min(
    MAX_ANDROID_STATUSBAR_TOP_PX,
    Math.max(DEFAULT_ANDROID_STATUSBAR_TOP_PX, cssPixels + 1),
  )

  return `${Math.round(stabilizedPixels * 100) / 100}px`
}

const getVisualViewportKeyboardInsetPx = () => {
  if (typeof window === 'undefined') {
    return 0
  }

  const viewport = window.visualViewport
  if (!viewport) {
    return 0
  }

  const overlap = window.innerHeight - (viewport.height + viewport.offsetTop)
  if (!Number.isFinite(overlap)) {
    return 0
  }

  return Math.max(0, overlap)
}

const getKeyboardInsetPixelString = (bridge?: NativeSafeAreaBridge) => {
  if (!isNativeApp()) {
    return '0px'
  }

  const visualViewportInsetPx = getVisualViewportKeyboardInsetPx()
  const nativeInsetPx = toCssPixels(bridge?.getKeyboardInsetPx?.())
  const resolvedInsetPx =
    visualViewportInsetPx > 0 ? visualViewportInsetPx : nativeInsetPx

  if (resolvedInsetPx < MIN_NATIVE_KEYBOARD_INSET_PX) {
    return '0px'
  }

  return toRoundedPixelString(resolvedInsetPx)
}

const syncNativeSafeAreaInsets = () => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return
  }

  const bridge = window.PandaSafeArea
  const rootStyle = document.documentElement.style
  if (bridge) {
    rootStyle.setProperty('--native-safe-area-top', toTopInsetPixelString(bridge.getTopInsetPx?.()))
    rootStyle.setProperty('--native-safe-area-right', toPixelString(bridge.getRightInsetPx?.()))
    rootStyle.setProperty('--native-safe-area-bottom', toPixelString(bridge.getBottomInsetPx?.()))
    rootStyle.setProperty('--native-safe-area-left', toPixelString(bridge.getLeftInsetPx?.()))
  }
  rootStyle.setProperty(
    '--native-keyboard-inset-bottom',
    getKeyboardInsetPixelString(bridge),
  )
}

export const startNativeSafeAreaSync = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {}
  }

  const handleSync = () => {
    syncNativeSafeAreaInsets()
  }
  const pendingSyncTimeouts = new Set<number>()
  const scheduleSync = (delay: number) => {
    const timeoutId = window.setTimeout(() => {
      pendingSyncTimeouts.delete(timeoutId)
      handleSync()
    }, delay)
    pendingSyncTimeouts.add(timeoutId)
  }
  const handleFocusChange = () => {
    handleSync()
    scheduleSync(120)
    scheduleSync(280)
  }

  let removeResumeListener: (() => void) | null = null

  handleSync()
  scheduleSync(0)
  scheduleSync(250)
  scheduleSync(800)
  window.addEventListener('load', handleSync, { once: true })
  window.addEventListener('resize', handleSync)
  window.addEventListener('orientationchange', handleSync)
  window.addEventListener(NATIVE_SAFE_AREA_CHANGE_EVENT, handleSync)
  document.addEventListener('visibilitychange', handleSync)
  document.addEventListener('focusin', handleFocusChange, true)
  document.addEventListener('focusout', handleFocusChange, true)
  window.visualViewport?.addEventListener('resize', handleSync)
  window.visualViewport?.addEventListener('scroll', handleSync)
  void App.addListener('resume', handleSync)
    .then((listener) => {
      removeResumeListener = () => {
        void listener.remove()
      }
    })
    .catch(() => {})

  return () => {
    window.removeEventListener('resize', handleSync)
    window.removeEventListener('orientationchange', handleSync)
    window.removeEventListener(NATIVE_SAFE_AREA_CHANGE_EVENT, handleSync)
    document.removeEventListener('visibilitychange', handleSync)
    document.removeEventListener('focusin', handleFocusChange, true)
    document.removeEventListener('focusout', handleFocusChange, true)
    window.visualViewport?.removeEventListener('resize', handleSync)
    window.visualViewport?.removeEventListener('scroll', handleSync)
    for (const timeoutId of pendingSyncTimeouts) {
      window.clearTimeout(timeoutId)
    }
    pendingSyncTimeouts.clear()
    removeResumeListener?.()
  }
}
