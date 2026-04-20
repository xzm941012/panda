import {
  configureTailscaleServe,
  ensurePandaHubApiKey,
  printTerminalQr,
  resolveTailscalePublicationMode,
  resolveTailscaleServePort,
  startPandaSessionService,
} from '@panda/provider-codex'

const argv = process.argv.slice(2)
const port = Number(process.env.PANDA_HUB_PORT ?? 4343)
const tailscalePublicationMode = resolveTailscalePublicationMode({
  argv,
  envPrefix: 'PANDA_HUB',
})
const tailscaleServe = configureTailscaleServe({
  enabled: tailscalePublicationMode !== 'disabled',
  mode: tailscalePublicationMode === 'disabled' ? undefined : tailscalePublicationMode,
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

await startPandaSessionService({
  serviceName: 'panda-hub',
  mode: 'hub',
  port,
  transport: 'hub-routed',
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
