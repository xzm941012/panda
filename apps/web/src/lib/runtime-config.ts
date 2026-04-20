import { useSyncExternalStore } from 'react'
import { Preferences } from '@capacitor/preferences'
import { isNativeApp, readPandaPlatform, type PandaPlatform } from './platform'

const DEV_WEB_PORTS = new Set(['4173', '4174'])
const RUNTIME_CONFIG_GROUP = 'PandaMobile'
const HUB_URL_STORAGE_KEY = 'hub_url'
const ONBOARDING_COMPLETED_STORAGE_KEY = 'onboarding_completed'

export type PandaRuntimeConfig = {
  platform: PandaPlatform
  hubUrl: string
  onboardingCompleted: boolean
}

const listeners = new Set<() => void>()

let currentRuntimeConfig: PandaRuntimeConfig = {
  platform: readPandaPlatform(),
  hubUrl: '',
  onboardingCompleted: false,
}
let runtimeConfigReady = false

const emitRuntimeConfigChange = () => {
  for (const listener of listeners) {
    listener()
  }
}

const subscribeRuntimeConfig = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const normalizeUrl = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  if (!normalized) {
    return ''
  }

  try {
    return new URL(normalized).toString().replace(/\/+$/, '')
  } catch {
    return normalized.replace(/\/+$/, '')
  }
}

const getCurrentOrigin = () => {
  if (typeof window === 'undefined') {
    return null
  }

  return window.location.origin || null
}

const getDefaultBaseUrl = (port: number) => {
  if (typeof window === 'undefined') {
    return `http://localhost:${port}`
  }

  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
  const hostname = window.location.hostname || 'localhost'
  return `${protocol}//${hostname}:${port}`
}

export const getDefaultAgentUrl = () =>
  normalizeUrl(import.meta.env.VITE_PANDA_AGENT_URL ?? getDefaultBaseUrl(4242))

export const getDefaultWebHubUrl = () => {
  const configuredUrl = normalizeUrl(import.meta.env.VITE_PANDA_HUB_URL)
  if (configuredUrl) {
    return configuredUrl
  }

  const currentOrigin = getCurrentOrigin()
  if (!currentOrigin) {
    return 'http://localhost:4343'
  }

  const currentPort = window.location.port.trim()
  if (DEV_WEB_PORTS.has(currentPort)) {
    return getDefaultBaseUrl(4343)
  }

  return normalizeUrl(currentOrigin)
}

const getDefaultMobileHubUrl = () =>
  normalizeUrl(import.meta.env.VITE_PANDA_MOBILE_DEFAULT_HUB_URL)

const shouldForceRuntimeOnboardingInDev = () => {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return false
  }

  const params = new URLSearchParams(window.location.search)
  const value = params.get('onboarding') ?? params.get('runtimeOnboarding')
  return value === '1' || value === 'true'
}

const createDefaultRuntimeConfig = (): PandaRuntimeConfig => {
  const platform = readPandaPlatform()
  if (platform === 'web') {
    return {
      platform,
      hubUrl: getDefaultWebHubUrl(),
      onboardingCompleted: true,
    }
  }

  const defaultHubUrl = getDefaultMobileHubUrl()
  return {
    platform,
    hubUrl: defaultHubUrl,
    onboardingCompleted: Boolean(defaultHubUrl),
  }
}

const readStoredValue = async (key: string) => {
  if (isNativeApp()) {
    const { value } = await Preferences.get({ key })
    return value
  }

  if (typeof window === 'undefined') {
    return null
  }

  try {
    return window.localStorage.getItem(`panda:runtime:${key}`)
  } catch {
    return null
  }
}

const writeStoredValue = async (key: string, value: string | null) => {
  if (isNativeApp()) {
    if (value === null) {
      await Preferences.remove({ key })
      return
    }

    await Preferences.set({ key, value })
    return
  }

  if (typeof window === 'undefined') {
    return
  }

  try {
    if (value === null) {
      window.localStorage.removeItem(`panda:runtime:${key}`)
      return
    }

    window.localStorage.setItem(`panda:runtime:${key}`, value)
  } catch {
    // Ignore best-effort persistence failures.
  }
}

export const initializeRuntimeConfig = async () => {
  const defaults = createDefaultRuntimeConfig()

  if (isNativeApp()) {
    await Preferences.configure({ group: RUNTIME_CONFIG_GROUP })
  }

  const [storedHubUrl, storedOnboardingCompleted] = await Promise.all([
    readStoredValue(HUB_URL_STORAGE_KEY),
    readStoredValue(ONBOARDING_COMPLETED_STORAGE_KEY),
  ])

  const hubUrl =
    defaults.platform === 'web'
      ? defaults.hubUrl
      : normalizeUrl(storedHubUrl) || defaults.hubUrl
  const onboardingCompleted =
    defaults.platform === 'web'
      ? true
      : storedOnboardingCompleted === 'true' || Boolean(hubUrl && defaults.onboardingCompleted)

  currentRuntimeConfig = {
    platform: defaults.platform,
    hubUrl,
    onboardingCompleted,
  }
  runtimeConfigReady = true
  emitRuntimeConfigChange()
  return currentRuntimeConfig
}

export const isRuntimeConfigInitialized = () => runtimeConfigReady

export const readRuntimeConfig = () => currentRuntimeConfig

export const readRuntimeHubUrl = () => normalizeUrl(currentRuntimeConfig.hubUrl)

export const requiresRuntimeOnboarding = () => {
  const config = readRuntimeConfig()
  if (config.platform === 'web') {
    return shouldForceRuntimeOnboardingInDev()
  }

  return !config.hubUrl || !config.onboardingCompleted
}

export const writeRuntimeConfig = async (
  update: Partial<Pick<PandaRuntimeConfig, 'hubUrl' | 'onboardingCompleted'>>,
) => {
  const nextHubUrl =
    update.hubUrl === undefined
      ? currentRuntimeConfig.hubUrl
      : normalizeUrl(update.hubUrl)
  const nextOnboardingCompleted =
    update.onboardingCompleted ?? currentRuntimeConfig.onboardingCompleted

  currentRuntimeConfig = {
    ...currentRuntimeConfig,
    hubUrl: nextHubUrl,
    onboardingCompleted: nextOnboardingCompleted,
  }

  if (currentRuntimeConfig.platform !== 'web') {
    await Promise.all([
      writeStoredValue(HUB_URL_STORAGE_KEY, nextHubUrl || null),
      writeStoredValue(
        ONBOARDING_COMPLETED_STORAGE_KEY,
        nextOnboardingCompleted ? 'true' : 'false',
      ),
    ])
  }

  emitRuntimeConfigChange()
  return currentRuntimeConfig
}

export const resetRuntimeConnectionConfig = async () => {
  const defaults = createDefaultRuntimeConfig()
  currentRuntimeConfig = defaults

  if (defaults.platform !== 'web') {
    await Promise.all([
      writeStoredValue(HUB_URL_STORAGE_KEY, defaults.hubUrl || null),
      writeStoredValue(
        ONBOARDING_COMPLETED_STORAGE_KEY,
        defaults.onboardingCompleted ? 'true' : 'false',
      ),
    ])
  }

  emitRuntimeConfigChange()
  return currentRuntimeConfig
}

export const useRuntimeConfig = () =>
  useSyncExternalStore(
    subscribeRuntimeConfig,
    readRuntimeConfig,
    readRuntimeConfig,
  )
