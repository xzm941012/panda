import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(currentDirectory, '..')
const releaseRoot = path.join(repositoryRoot, 'release')

const releasePackages = [
  {
    directory: path.join(releaseRoot, 'panda-agent'),
    entries: ['src/index.ts', 'src/cli.ts'],
  },
  {
    directory: path.join(releaseRoot, 'panda-hub'),
    entries: ['src/index.ts', 'src/cli.ts'],
  },
  {
    directory: path.join(releaseRoot, 'panda'),
    entries: ['src/cli.ts'],
  },
]

const externalPackageNames = [
  'fastify',
  '@fastify/compress',
  '@fastify/cors',
  '@fastify/websocket',
  '@jamiexiongr/panda-agent',
  '@jamiexiongr/panda-hub',
  'node-windows',
  'web-push',
]

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

const ensureCleanDirectory = async (targetDirectory) => {
  await fs.rm(targetDirectory, { recursive: true, force: true })
  await fs.mkdir(targetDirectory, { recursive: true })
}

const copyDirectoryContents = async (sourceDirectory, targetDirectory) => {
  await fs.cp(sourceDirectory, targetDirectory, { recursive: true, force: true })
}

const buildReleasePackage = (targetDirectory, entries) => {
  runCommand('pnpm', [
    'exec',
    'tsup',
    ...entries.map((entry) => path.join(targetDirectory, entry)),
    '--format',
    'esm',
    '--platform',
    'node',
    '--target',
    'node20',
    ...externalPackageNames.flatMap((packageName) => ['--external', packageName]),
    '--out-dir',
    path.join(targetDirectory, 'dist'),
    '--clean',
  ])
}

const main = async () => {
  runCommand('pnpm', ['--dir', path.join('apps', 'web'), 'build'])

  for (const releasePackage of releasePackages) {
    buildReleasePackage(releasePackage.directory, releasePackage.entries)
  }

  const hubWebTargetDirectory = path.join(releaseRoot, 'panda-hub', 'dist', 'web')
  await ensureCleanDirectory(hubWebTargetDirectory)
  await copyDirectoryContents(
    path.join(repositoryRoot, 'apps', 'web', 'dist'),
    hubWebTargetDirectory,
  )
}

await main()
