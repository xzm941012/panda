import { resolveTailscalePublicationMode } from '../../../packages/provider-codex/src/tailscale'

const printUsage = () => {
  console.log(`panda <command>

Commands:
  agent [tailscareserv|tailscareserv-pub] [--hub-url=<url>]    Start the Panda agent service
  hub [tailscareserv|tailscareserv-pub]      Start the Panda hub service with the bundled web UI
  agent service <install|start|stop|restart|status|uninstall> [args...]
                                                Manage the Panda Agent Windows service
  hub service <install|start|stop|restart|status|uninstall> [args...]
                                                Manage the Panda Hub Windows service
  tip      Set PANDA_GROUP_IP=<lan-ip> to auto-fill hub/direct/ws URLs for agent startup
  help     Show this message`)
}

const resolveCliOptionValue = (argv: string[], aliases: string[]) => {
  for (let index = 0; index < argv.length; index += 1) {
    const candidate = argv[index]?.trim() ?? ''
    const normalized = candidate.toLowerCase()

    for (const alias of aliases) {
      if (normalized === alias) {
        return argv[index + 1]?.trim() || null
      }

      if (normalized.startsWith(`${alias}=`)) {
        return candidate.slice(alias.length + 1).trim() || null
      }
    }
  }

  return null
}

const main = async () => {
  const command = process.argv[2]?.trim().toLowerCase() ?? 'help'
  const commandArgs = process.argv.slice(3)
  const agentPublicationMode = resolveTailscalePublicationMode({
    argv: commandArgs,
    envPrefix: 'PANDA_AGENT',
  })
  const hubPublicationMode = resolveTailscalePublicationMode({
    argv: commandArgs,
    envPrefix: 'PANDA_HUB',
  })

  if (command === 'help' || command === '--help' || command === '-h') {
    printUsage()
    return
  }

  if (command === 'agent') {
    const { manageJamiexiongrAgentService, startJamiexiongrAgent } = await import(
      '@jamiexiongr/panda-agent'
    )
    if (commandArgs[0]?.trim().toLowerCase() === 'service') {
      await manageJamiexiongrAgentService({
        argv: commandArgs.slice(1),
      })
      return
    }
    await startJamiexiongrAgent({
      tailscalePublicationMode: agentPublicationMode,
      hubUrl: resolveCliOptionValue(commandArgs, [
        'hub',
        '--hub',
        'hub-url',
        '--hub-url',
        'huburl',
        '--huburl',
      ]),
      argv: commandArgs,
    })
    return
  }

  if (command === 'hub') {
    const { manageJamiexiongrHubService, startJamiexiongrHub } = await import(
      '@jamiexiongr/panda-hub'
    )
    if (commandArgs[0]?.trim().toLowerCase() === 'service') {
      await manageJamiexiongrHubService({
        argv: commandArgs.slice(1),
      })
      return
    }
    await startJamiexiongrHub({
      tailscalePublicationMode: hubPublicationMode,
    })
    return
  }

  console.error(`Unknown command: ${command}`)
  printUsage()
  process.exitCode = 1
}

void main()
