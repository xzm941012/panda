import {
  buildAgentServiceBaseUrl,
  buildTailscaleHttpsUrl,
  resolveCliOptionValue,
  configureTailscaleServe,
  printTerminalQr,
  resolveAgentEndpointLabel,
  resolveDefaultAgentId,
  resolveAgentGroupHost,
  resolvePandaHubApiKey,
  resolveAgentNetworkIdentity,
  resolveTailscalePublicationMode,
  resolveTailscaleServePort,
  startAgentHubSync,
  startPandaSessionService,
} from '@panda/provider-codex'

const argv = process.argv.slice(2)
const port = Number(process.env.PANDA_AGENT_PORT ?? 4242)
const tailscalePublicationMode = resolveTailscalePublicationMode({
  argv,
  envPrefix: 'PANDA_AGENT',
})
const tailscaleServe = configureTailscaleServe({
  enabled: tailscalePublicationMode !== 'disabled',
  mode: tailscalePublicationMode === 'disabled' ? undefined : tailscalePublicationMode,
  serviceName: 'panda-agent',
  localPort: port,
  servePort: resolveTailscaleServePort({
    envPrefix: 'PANDA_AGENT',
    defaultPort: port,
  }),
  logger: console,
})
const groupHost = resolveAgentGroupHost(process.env.PANDA_GROUP_IP ?? null)
const networkIdentity = resolveAgentNetworkIdentity({
  directBaseUrl: process.env.PANDA_AGENT_DIRECT_BASE_URL ?? null,
  wsBaseUrl: process.env.PANDA_AGENT_WS_BASE_URL ?? null,
  tailscaleIp: process.env.PANDA_AGENT_TAILSCALE_IP ?? null,
  tailscaleDnsName: process.env.PANDA_AGENT_TAILSCALE_DNS_NAME ?? null,
  groupHost,
  port,
})
const groupHubUrl = buildAgentServiceBaseUrl({
  host: groupHost,
  port: Number(process.env.PANDA_HUB_PORT ?? 4343),
})
const configuredHubUrl =
  resolveCliOptionValue({
    argv,
    aliases: ['hub', '--hub', 'hub-url', '--hub-url', 'huburl', '--huburl'],
  }) ??
  process.env.PANDA_HUB_URL?.trim() ??
  groupHubUrl ??
  null
const inferredLocalHubUrl =
  configuredHubUrl
    ? null
    : buildTailscaleHttpsUrl({
        dnsName: tailscaleServe.dnsName ?? networkIdentity.tailscaleDnsName,
        servePort: resolveTailscaleServePort({
          envPrefix: 'PANDA_HUB',
          defaultPort: 443,
        }),
      })
const hubUrl = configuredHubUrl ?? inferredLocalHubUrl
const configuredAgentName =
  resolveCliOptionValue({
    argv,
    aliases: ['agent-name', '--agent-name', 'agentname', '--agentname'],
  })?.trim() ||
  process.env.PANDA_AGENT_NAME?.trim() ||
  null
const agentName =
  configuredAgentName ??
  resolveAgentEndpointLabel({
    directBaseUrl: networkIdentity.directBaseUrl,
    host: networkIdentity.host,
    port,
  }) ??
  networkIdentity.host
const agentId =
  resolveCliOptionValue({
    argv,
    aliases: ['agent-id', '--agent-id', 'agentid', '--agentid'],
  })?.trim() ||
  process.env.PANDA_AGENT_ID?.trim() ||
  resolveDefaultAgentId({
    directBaseUrl: networkIdentity.directBaseUrl,
    agentName,
    host: networkIdentity.host,
    port,
  })

const app = await startPandaSessionService({
  serviceName: 'panda-agent',
  mode: 'direct',
  port,
  transport: 'direct-agent',
  localAgentName: agentName,
  localAgentId: agentId,
  tailscaleIp: networkIdentity.tailscaleIp,
  tailscaleDnsName: networkIdentity.tailscaleDnsName,
  directBaseUrl: networkIdentity.directBaseUrl,
  wsBaseUrl: networkIdentity.wsBaseUrl,
  version: process.env.npm_package_version ?? null,
})

if (hubUrl) {
  if (!configuredHubUrl && inferredLocalHubUrl) {
    console.info(`PANDA_HUB_URL is not configured; defaulting to same-machine hub ${inferredLocalHubUrl}`)
  } else {
    console.info(`Panda agent will register to hub: ${hubUrl}`)
  }

  printTerminalQr(hubUrl, {
    logger: console,
    label: 'Scan this QR code in Panda app to open the configured Panda hub:',
  })

  const hubApiKey = await resolvePandaHubApiKey({
    configuredApiKey: process.env.PANDA_HUB_API_KEY ?? null,
    codexHome: process.env.PANDA_CODEX_HOME ?? null,
  })
  if (hubApiKey.apiKey) {
    process.env.PANDA_HUB_API_KEY = hubApiKey.apiKey
  }

  const hubSync = startAgentHubSync({
    hubUrl,
    hubApiKey: hubApiKey.apiKey,
    localBaseUrl: `http://127.0.0.1:${port}`,
    agentId,
    agentName,
    transport: 'direct-agent',
    heartbeatIntervalMs: Number(process.env.PANDA_AGENT_HEARTBEAT_INTERVAL_MS ?? 15_000),
    networkIdentity,
    version: process.env.npm_package_version ?? null,
    logger: console,
  })

  app.server.once('close', () => {
    hubSync.stop()
  })

  let closing = false
  const shutdown = () => {
    if (closing) {
      return
    }

    closing = true
    hubSync.stop()
    void app.close()
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
} else {
  console.info('PANDA_HUB_URL is not configured; agent will run without hub registration.')
}

if (tailscaleServe.active && tailscaleServe.baseUrl) {
  if (tailscaleServe.mode === 'funnel') {
    console.info(`Panda agent Public HTTPS URL: ${tailscaleServe.baseUrl}`)
  } else {
    console.info(`Panda agent Tailscale HTTPS URL: ${tailscaleServe.baseUrl}`)
  }
  console.info(`Agent will register direct URL to hub as: ${networkIdentity.directBaseUrl}`)
  console.info(`Agent will register websocket URL to hub as: ${networkIdentity.wsBaseUrl}`)
}
