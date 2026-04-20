import { resolveTailscalePublicationMode } from '../../../packages/provider-codex/src/tailscale'
import { manageJamiexiongrHubService, startJamiexiongrHub } from './index'

const argv = process.argv.slice(2)
const command = argv[0]?.trim().toLowerCase() ?? ''

if (command === 'service') {
  void manageJamiexiongrHubService({
    argv: argv.slice(1),
  })
} else {
  void startJamiexiongrHub({
    tailscalePublicationMode: resolveTailscalePublicationMode({
      argv,
      envPrefix: 'PANDA_HUB',
    }),
  })
}
