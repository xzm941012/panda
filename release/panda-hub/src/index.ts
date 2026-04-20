import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }
import {
  configureTailscaleServe,
  resolveTailscalePublicationMode,
  resolveTailscaleServePort,
  type TailscalePublicationMode,
} from '../../../packages/provider-codex/src/tailscale'
import { ensurePandaHubApiKey } from '../../../packages/provider-codex/src/hub-api-key'
import { printTerminalQr } from '../../../packages/provider-codex/src/terminal-qr'
import { startPandaSessionService } from '../../../packages/provider-codex/src/panda-session-service'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

const resolveBundledWebUiDir = () => {
  const candidates = [
    path.resolve(currentDirectory, 'web'),
    path.resolve(currentDirectory, '../dist/web'),
    path.resolve(currentDirectory, '../web'),
  ]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

export const startJamiexiongrHub = async (options?: {
  tailscalePublicationMode?: TailscalePublicationMode
}) => {
  const publishMode =
    options?.tailscalePublicationMode ??
    resolveTailscalePublicationMode({
      envPrefix: 'PANDA_HUB',
    })
  const port = Number(process.env.PANDA_HUB_PORT ?? 4343)
  const tailscaleServe = configureTailscaleServe({
    enabled: publishMode !== 'disabled',
    mode: publishMode === 'disabled' ? undefined : publishMode,
    serviceName: 'panda-hub',
    localPort: port,
    servePort: resolveTailscaleServePort({
      envPrefix: 'PANDA_HUB',
      defaultPort: 443,
    }),
    logger: console,
  })
  const hubApiKey = await ensurePandaHubApiKey({
    configuredApiKey: process.env.PANDA_HUB_API_KEY ?? null,
    codexHome: process.env.PANDA_CODEX_HOME ?? null,
    logger: console,
  })
  if (hubApiKey.apiKey) {
    process.env.PANDA_HUB_API_KEY = hubApiKey.apiKey
  }

  const webUiDir = resolveBundledWebUiDir()
  const app = await startPandaSessionService({
    serviceName: 'panda-hub',
    mode: 'hub',
    port,
    transport: 'hub-routed',
    version: pkg.version,
    webUiDir,
  })

  if (tailscaleServe.active && tailscaleServe.baseUrl) {
    if (tailscaleServe.mode === 'funnel') {
      console.info(`Panda hub Public HTTPS URL: ${tailscaleServe.baseUrl}`)
      console.info(`Public PWA install URL: ${tailscaleServe.baseUrl}`)
    } else {
      console.info(`Panda hub Tailscale HTTPS URL: ${tailscaleServe.baseUrl}`)
      console.info(`Agent hub URL env: PANDA_HUB_URL=${tailscaleServe.baseUrl}`)
    }
    printTerminalQr(tailscaleServe.baseUrl, {
      logger: console,
      label:
        tailscaleServe.mode === 'funnel'
          ? 'Scan this QR code to open the public Panda hub on your phone:'
          : 'Scan this QR code to open Panda hub on your phone:',
    })
  }

  return app
}

export { manageJamiexiongrHubService } from './service'
