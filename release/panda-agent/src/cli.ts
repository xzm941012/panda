import {
  resolveCliOptionValue,
  resolveTailscalePublicationMode,
} from '../../../packages/provider-codex/src/tailscale'
import { manageJamiexiongrAgentService, startJamiexiongrAgent } from './index'

const argv = process.argv.slice(2)
const command = argv[0]?.trim().toLowerCase() ?? ''

if (command === 'service') {
  void manageJamiexiongrAgentService({
    argv: argv.slice(1),
  })
} else {
  void startJamiexiongrAgent({
    tailscalePublicationMode: resolveTailscalePublicationMode({
      argv,
      envPrefix: 'PANDA_AGENT',
    }),
    hubUrl: resolveCliOptionValue({
      argv,
      aliases: ['hub', '--hub', 'hub-url', '--hub-url', 'huburl', '--huburl'],
    }),
    argv,
  })
}
