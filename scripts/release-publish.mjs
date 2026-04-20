import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(currentDirectory, '..')
const releaseRoot = path.join(repositoryRoot, 'release')
const registryUrl = 'https://registry.npmjs.org'

const releasePackages = [
  {
    key: 'agent',
    directory: path.join(releaseRoot, 'panda-agent'),
    packageName: '@jamiexiongr/panda-agent',
  },
  {
    key: 'hub',
    directory: path.join(releaseRoot, 'panda-hub'),
    packageName: '@jamiexiongr/panda-hub',
  },
  {
    key: 'meta',
    directory: path.join(releaseRoot, 'panda'),
    packageName: '@jamiexiongr/panda',
  },
]

const appendPublishAuthArgs = (args, otp) => {
  if (otp) {
    return [...args, '--otp', otp]
  }

  return args
}

const createUserConfigForToken = async (token) => {
  if (!token) {
    return null
  }

  const filePath = path.join(
    os.tmpdir(),
    `panda-release-${process.pid}-${Date.now()}.npmrc`,
  )
  const content = `//registry.npmjs.org/:_authToken=${token}\nregistry=${registryUrl}\n`
  await fs.writeFile(filePath, content, 'utf8')
  return filePath
}

const resolveCodexHome = () =>
  process.env.PANDA_CODEX_HOME?.trim()
  || process.env.CODEX_HOME?.trim()
  || path.join(os.homedir(), '.codex')

const readSavedTokenFromCodexHome = async () => {
  const filePath = path.join(
    resolveCodexHome(),
    'state',
    'panda',
    'dev-manager',
    'credentials.json',
  )
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
    const token = typeof parsed?.npm_token === 'string' ? parsed.npm_token.trim() : ''
    return token || null
  } catch {
    return null
  }
}

const resolveUserConfigFromEnvironment = async () => {
  const candidate =
    process.env.PANDA_NPM_PUBLISH_USERCONFIG?.trim() ||
    process.env.NPM_CONFIG_USERCONFIG?.trim() ||
    null
  if (!candidate) {
    return null
  }

  try {
    await fs.access(candidate)
    return candidate
  } catch {
    return null
  }
}

const resolveDefaultUserConfigPath = async () => {
  const candidate = path.join(os.homedir(), '.npmrc')
  try {
    await fs.access(candidate)
    return candidate
  } catch {
    return null
  }
}

const appendUserConfigArgs = (args, userConfigPath) => {
  if (!userConfigPath) {
    return args
  }

  return [...args, '--userconfig', userConfigPath]
}

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    shell: process.platform === 'win32',
    ...options,
  })

  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    const output = stderr || stdout
    throw new Error(output || `${command} ${args.join(' ')} failed`)
  }

  return result
}

const stableSemverPattern = /^(\d+)\.(\d+)\.(\d+)$/

const isStableSemver = (value) =>
  typeof value === 'string' && stableSemverPattern.test(value.trim())

const parseSemver = (value) => {
  const match = stableSemverPattern.exec(value.trim())
  if (!match) {
    throw new Error(`Invalid version: ${value}`)
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

const compareSemver = (left, right) => {
  const leftParts = parseSemver(left)
  const rightParts = parseSemver(right)
  if (leftParts.major !== rightParts.major) {
    return leftParts.major - rightParts.major
  }
  if (leftParts.minor !== rightParts.minor) {
    return leftParts.minor - rightParts.minor
  }
  return leftParts.patch - rightParts.patch
}

const bumpVersion = (value, strategy) => {
  const parsed = parseSemver(value)
  if (strategy === 'major') {
    return `${parsed.major + 1}.0.0`
  }
  if (strategy === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'))

const writeJson = async (filePath, value) => {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const packageJsonPath = (directory) => path.join(directory, 'package.json')

const getPublishedVersions = (packageName) => {
  const result = spawnSync(
    'npm',
    appendUserConfigArgs(
      ['view', packageName, 'versions', '--json', '--registry', registryUrl],
      globalThis.__pandaReleaseUserConfigPath ?? null,
    ),
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  )

  if (result.status !== 0) {
    return []
  }

  const payload = result.stdout.trim()
  if (!payload) {
    return []
  }

  try {
    const parsed = JSON.parse(payload)
    if (Array.isArray(parsed)) {
      return parsed.filter(isStableSemver)
    }
    if (typeof parsed === 'string' && isStableSemver(parsed)) {
      return [parsed]
    }
  } catch {
    if (isStableSemver(payload)) {
      return [payload]
    }
  }

  return []
}

const isPublishedVersion = (packageName, version) => {
  const result = spawnSync(
    'npm',
    appendUserConfigArgs(
      ['view', `${packageName}@${version}`, 'version', '--registry', registryUrl],
      globalThis.__pandaReleaseUserConfigPath ?? null,
    ),
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  )

  return result.status === 0 && result.stdout.trim() === version
}

const resolveTargetVersion = async (requestedVersion) => {
  if (requestedVersion && !['patch', 'minor', 'major'].includes(requestedVersion)) {
    if (!isStableSemver(requestedVersion)) {
      throw new Error(
        `Invalid release version: ${requestedVersion}. Expected a stable semver like 1.2.3.`,
      )
    }
    return requestedVersion
  }

  const localVersions = []
  for (const releasePackage of releasePackages) {
    const pkg = await readJson(packageJsonPath(releasePackage.directory))
    if (isStableSemver(pkg.version)) {
      localVersions.push(pkg.version)
    }
  }

  const publishedVersions = releasePackages
    .flatMap((releasePackage) => getPublishedVersions(releasePackage.packageName))

  if (localVersions.length === 0 && publishedVersions.length === 0) {
    throw new Error('Unable to resolve a stable release version from local or published packages.')
  }

  if (publishedVersions.length === 0) {
    return localVersions.sort(compareSemver).at(-1)
  }

  const baseVersion = [...localVersions, ...publishedVersions].sort(compareSemver).at(-1)
  return bumpVersion(baseVersion, requestedVersion ?? 'patch')
}

const ensureNpmLogin = (userConfigPath) => {
  const result = runCommand(
    'npm',
    appendUserConfigArgs(['whoami', '--registry', registryUrl], userConfigPath),
    { stdio: 'pipe' },
  )
  const currentUser = result.stdout.trim()
  if (!currentUser) {
    throw new Error('npm login is required before publishing.')
  }
  return currentUser
}

const isAuthError = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('ENEEDAUTH')
    || message.includes('need auth')
    || message.includes('E401')
    || message.includes('401 Unauthorized')
  )
}

const syncPackageVersions = async (version) => {
  for (const releasePackage of releasePackages) {
    const filePath = packageJsonPath(releasePackage.directory)
    const pkg = await readJson(filePath)
    pkg.version = version

    if (releasePackage.key === 'meta') {
      pkg.dependencies['@jamiexiongr/panda-agent'] = version
      pkg.dependencies['@jamiexiongr/panda-hub'] = version
    }

    await writeJson(filePath, pkg)
  }
}

const main = async () => {
  const requestedVersion = process.argv[2]?.trim() || null
  const publishOtp =
    process.env.NPM_PUBLISH_OTP?.trim() ||
    process.env.NPM_OTP?.trim() ||
    null
  const token = process.env.NODE_AUTH_TOKEN?.trim() || null
  const inheritedUserConfigPath = await resolveUserConfigFromEnvironment()
  const defaultUserConfigPath = await resolveDefaultUserConfigPath()
  const savedToken = await readSavedTokenFromCodexHome()
  const createdUserConfigPaths = []

  /** @type {{ label: string, userConfigPath: string | null }[]} */
  const authCandidates = []
  if (inheritedUserConfigPath) {
    authCandidates.push({
      label: 'inherited-userconfig',
      userConfigPath: inheritedUserConfigPath,
    })
  }
  if (
    defaultUserConfigPath &&
    defaultUserConfigPath !== inheritedUserConfigPath
  ) {
    authCandidates.push({
      label: 'default-userconfig',
      userConfigPath: defaultUserConfigPath,
    })
  }
  if (savedToken) {
    const savedTokenUserConfigPath = await createUserConfigForToken(savedToken)
    if (savedTokenUserConfigPath) {
      createdUserConfigPaths.push(savedTokenUserConfigPath)
      authCandidates.push({
        label: 'saved-token',
        userConfigPath: savedTokenUserConfigPath,
      })
    }
  }
  if (token) {
    const envTokenUserConfigPath = await createUserConfigForToken(token)
    if (envTokenUserConfigPath) {
      createdUserConfigPaths.push(envTokenUserConfigPath)
      authCandidates.push({
        label: 'env-token',
        userConfigPath: envTokenUserConfigPath,
      })
    }
  }
  if (authCandidates.length === 0) {
    throw new Error('NODE_AUTH_TOKEN is missing and no saved npm token was found.')
  }

  let userConfigPath = authCandidates[0]?.userConfigPath ?? null
  globalThis.__pandaReleaseUserConfigPath = userConfigPath

  try {
    let currentUser = null
    let lastAuthError = null
    for (const candidate of authCandidates) {
      globalThis.__pandaReleaseUserConfigPath = candidate.userConfigPath
      try {
        currentUser = ensureNpmLogin(candidate.userConfigPath)
        userConfigPath = candidate.userConfigPath
        break
      } catch (error) {
        if (!isAuthError(error)) {
          throw error
        }
        lastAuthError = error
        console.warn(`npm auth probe failed via ${candidate.label}, trying next source...`)
      }
    }
    if (!currentUser) {
      throw lastAuthError ?? new Error('npm login is required before publishing.')
    }
    console.log(`Publishing with npm user: ${currentUser}`)

    const targetVersion = await resolveTargetVersion(requestedVersion)
    console.log(`Target release version: ${targetVersion}`)

    await syncPackageVersions(targetVersion)

    runCommand('node', [path.join('scripts', 'release-build.mjs')], { stdio: 'inherit' })

    for (const releasePackage of releasePackages) {
      console.log(`\nPacking ${releasePackage.packageName}...`)
      runCommand(
        'npm',
        appendUserConfigArgs(['pack', '--dry-run'], userConfigPath),
        {
          cwd: releasePackage.directory,
          stdio: 'inherit',
        },
      )
    }

    for (const releasePackage of releasePackages) {
      if (isPublishedVersion(releasePackage.packageName, targetVersion)) {
        console.log(`Skipping ${releasePackage.packageName}@${targetVersion}; already published.`)
        continue
      }

      console.log(`\nPublishing ${releasePackage.packageName}@${targetVersion}...`)
      try {
        runCommand(
          'npm',
          appendUserConfigArgs(
            appendPublishAuthArgs(
              ['publish', '--access', 'public', '--registry', registryUrl],
              publishOtp,
            ),
            userConfigPath,
          ),
          {
            cwd: releasePackage.directory,
            stdio: 'inherit',
          },
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('bypass 2fa enabled is required')) {
          throw new Error(
            `${message}\nProvide a fresh OTP via NPM_PUBLISH_OTP/NPM_OTP for interactive publishing, or configure an npm granular access token with bypass 2FA enabled before rerunning the script.`,
          )
        }

        throw error
      }
    }
  } finally {
    delete globalThis.__pandaReleaseUserConfigPath
    for (const filePath of createdUserConfigPaths) {
      await fs.rm(filePath, { force: true }).catch(() => undefined)
    }
  }
}

await main()
