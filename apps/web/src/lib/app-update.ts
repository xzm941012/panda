import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { isAndroidApp, readPandaPlatform } from './platform'

export type InstalledAppInfo = {
  platform: string
  version: string | null
  build: string | null
  appId: string | null
}

export type AndroidReleaseManifest = {
  platform: 'android'
  version_name: string
  version_code: number
  published_at: string
  apk_url: string
  release_notes: string[]
}

const normalizeUrl = (value: string | null | undefined) => {
  const normalized = value?.trim() ?? ''
  return normalized ? normalized.replace(/\/+$/, '') : ''
}

export const readInstalledAppInfo = async (): Promise<InstalledAppInfo> => {
  if (!isAndroidApp()) {
    return {
      platform: readPandaPlatform(),
      version: null,
      build: null,
      appId: null,
    }
  }

  const info = await App.getInfo()
  return {
    platform: readPandaPlatform(),
    version: info.version ?? null,
    build: info.build ?? null,
    appId: info.id ?? null,
  }
}

export const buildAndroidReleaseManifestUrl = (hubUrl: string) => {
  const normalizedHubUrl = normalizeUrl(hubUrl)
  if (!normalizedHubUrl) {
    return ''
  }

  return new URL('/downloads/android/latest.json', normalizedHubUrl).toString()
}

export const readAndroidReleaseManifest = async (
  hubUrl: string,
): Promise<AndroidReleaseManifest> => {
  const manifestUrl = buildAndroidReleaseManifestUrl(hubUrl)
  if (!manifestUrl) {
    throw new Error('当前还没有配置可用的 Hub 地址。')
  }

  const response = await fetch(manifestUrl, {
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`更新清单请求失败（HTTP ${response.status}）。`)
  }

  const json = (await response.json()) as Partial<AndroidReleaseManifest>
  const releaseNotes = Array.isArray(json.release_notes)
    ? json.release_notes.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      )
    : []

  if (
    json.platform !== 'android' ||
    typeof json.version_name !== 'string' ||
    typeof json.version_code !== 'number' ||
    typeof json.published_at !== 'string' ||
    typeof json.apk_url !== 'string'
  ) {
    throw new Error('Hub 返回的 Android 更新清单格式无效。')
  }

  const resolvedApkUrl = new URL(json.apk_url, manifestUrl).toString()

  return {
    platform: 'android',
    version_name: json.version_name,
    version_code: json.version_code,
    published_at: json.published_at,
    apk_url: resolvedApkUrl,
    release_notes: releaseNotes,
  }
}

const readBuildNumber = (value: string | null) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const isAndroidReleaseAvailable = (
  currentInfo: InstalledAppInfo | null | undefined,
  manifest: AndroidReleaseManifest | null | undefined,
) => {
  if (!currentInfo || !manifest) {
    return false
  }

  const currentBuild = readBuildNumber(currentInfo.build)
  if (typeof currentBuild === 'number') {
    return manifest.version_code > currentBuild
  }

  return manifest.version_name !== currentInfo.version
}

export const openAndroidReleaseDownload = async (apkUrl: string) => {
  if (!apkUrl.trim()) {
    throw new Error('当前没有可用的 APK 下载地址。')
  }

  await Browser.open({
    url: apkUrl,
  })
}
