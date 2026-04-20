import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(currentDirectory, '..')

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

runCommand('pnpm', ['--dir', path.join('apps', 'web'), 'build:mobile'])
runCommand('pnpm', ['--dir', path.join('apps', 'mobile'), 'exec', 'cap', 'sync', 'android'])
