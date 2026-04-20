import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(currentDirectory, '..')
const androidProjectRoot = path.join(repositoryRoot, 'apps', 'mobile', 'android')
const releaseRoot = path.join(repositoryRoot, 'release')

const mode = process.argv[2] === 'debug' ? 'debug' : 'release'
const publishToHub = process.argv.includes('--publish')

const pad = (value) => String(value).padStart(2, '0')
const now = new Date()
const versionCode =
  process.env.PANDA_ANDROID_VERSION_CODE ??
  `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}`

const rootPackageJson = JSON.parse(
  await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
)
const versionName = process.env.PANDA_ANDROID_VERSION_NAME ?? rootPackageJson.version ?? '0.1.0'

const resolvePreferredJavaHome = () => {
  const candidates = [
    process.env.JAVA_HOME,
    'C:\\Program Files\\Java\\jdk-21',
  ].filter(Boolean)

  return candidates.find((candidate) => candidate && candidate.toLowerCase().includes('jdk-21'))
    ?? candidates[0]
    ?? null
}

const preferredJavaHome = resolvePreferredJavaHome()
const resolveAndroidSdkRoot = () => {
  const candidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    'D:\\ai\\android\\sdk',
  ].filter(Boolean)

  return candidates[0] ?? null
}

const androidSdkRoot = resolveAndroidSdkRoot()
const commandEnv = preferredJavaHome
  ? {
      ...process.env,
      JAVA_HOME: preferredJavaHome,
      PATH: `${path.join(preferredJavaHome, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      ...(androidSdkRoot
        ? {
            ANDROID_HOME: androidSdkRoot,
            ANDROID_SDK_ROOT: androidSdkRoot,
          }
        : null),
    }
  : {
      ...process.env,
      ...(androidSdkRoot
        ? {
            ANDROID_HOME: androidSdkRoot,
            ANDROID_SDK_ROOT: androidSdkRoot,
          }
        : null),
    }

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: commandEnv,
    ...options,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const copyFile = async (sourcePath, targetPath) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.copyFile(sourcePath, targetPath)
}

runCommand('pnpm', ['--dir', path.join('apps', 'web'), 'build:mobile'])
runCommand('pnpm', ['--dir', path.join('apps', 'mobile'), 'exec', 'cap', 'sync', 'android'])

if (androidSdkRoot) {
  await fs.writeFile(
    path.join(androidProjectRoot, 'local.properties'),
    `sdk.dir=${androidSdkRoot.replace(/\\/g, '\\\\')}\n`,
    'utf8',
  )
}

if (mode === 'release') {
  runCommand('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join('scripts', 'android-ensure-keystore.ps1'),
    '-ProjectRoot',
    repositoryRoot,
  ])
}

const gradleTask = mode === 'debug' ? 'assembleDebug' : 'assembleRelease'
runCommand(
  path.join(androidProjectRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
  [
    gradleTask,
    '--no-daemon',
    `-PPANDA_ANDROID_VERSION_CODE=${versionCode}`,
    `-PPANDA_ANDROID_VERSION_NAME=${versionName}`,
  ],
  {
    cwd: androidProjectRoot,
  },
)

const apkSourcePath = path.join(
  androidProjectRoot,
  'app',
  'build',
  'outputs',
  'apk',
  mode,
  `app-${mode}.apk`,
)
const localArtifactPath = path.join(
  releaseRoot,
  'android',
  `panda-android-${mode}.apk`,
)

await copyFile(apkSourcePath, localArtifactPath)

if (mode === 'release') {
  const manifest = {
    platform: 'android',
    version_name: versionName,
    version_code: Number(versionCode),
    published_at: new Date().toISOString(),
    apk_url: '/downloads/android/panda-android-release.apk',
    release_notes: [
      '共享 apps/web 前端资源的 Capacitor Android 壳。',
      '首次启动支持本地保存 Hub 地址，并沿用现有 WebSocket 重连链路。',
      '可通过新版 APK 覆盖安装升级，保留本地配置与缓存。',
    ],
  }

  const releaseAndroidRoot = path.join(releaseRoot, 'android')
  await fs.mkdir(releaseAndroidRoot, { recursive: true })
  await fs.writeFile(
    path.join(releaseAndroidRoot, 'latest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )

  if (publishToHub) {
    const hubDownloadRoot = path.join(
      releaseRoot,
      'panda-hub',
      'dist',
      'downloads',
      'android',
    )
    await copyFile(localArtifactPath, path.join(hubDownloadRoot, 'panda-android-release.apk'))
    await fs.writeFile(
      path.join(hubDownloadRoot, 'latest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
  }
}

console.log(`Android ${mode} APK ready: ${localArtifactPath}`)
