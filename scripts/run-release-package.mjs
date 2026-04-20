import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(currentDirectory, '..')

const packageKey = process.argv[2]?.trim()
const binName = process.argv[3]?.trim()
const forwardedArgs = process.argv.slice(4)

if (!packageKey || !binName) {
  console.error('Usage: node ./scripts/run-release-package.mjs <package-key> <bin-name> [args...]')
  process.exit(1)
}

const releaseDirectory = path.join(repositoryRoot, 'release', packageKey)

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  return result
}

runCommand('pnpm', ['release:build'])

const packResult = runCommand('npm', ['pack', '--json'], {
  cwd: releaseDirectory,
  stdio: 'pipe',
})

const packEntries = JSON.parse(packResult.stdout)
const tarballName = Array.isArray(packEntries) ? packEntries[0]?.filename : null

if (typeof tarballName !== 'string' || !tarballName.trim()) {
  console.error(`Failed to resolve tarball name for ${packageKey}.`)
  process.exit(1)
}

const tarballPath = path.join(releaseDirectory, tarballName)
const commandArgs = ['exec', '--yes', '--package', tarballPath, '--', binName, ...forwardedArgs]

const child = spawn('npm', commandArgs, {
  cwd: repositoryRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 0)
})

child.on('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

