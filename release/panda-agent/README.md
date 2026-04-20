# @jamiexiongr/panda-agent

Published agent runtime for Panda.

## Usage

```bash
panda-agent
panda-agent tailscareserv
panda-agent tailscareserv-pub
```

`tailscareserv` and `--tailscale-serve` both enable automatic tailnet-only `tailscale serve` publishing.

`tailscareserv-pub`, `--tailscale-serve-pub`, and `tailscale-funnel` enable public `tailscale funnel` publishing.

Windows service management:

```powershell
panda-agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4343
panda-agent service status
panda-agent service restart
panda-agent service uninstall
```

`service install` stores the startup args and current `PANDA_*` environment values in the Windows service definition. If you change them later, run `service install` again to update the service.

When enabled, agent startup will:

- detect whether `tailscale` is available and online
- run `tailscale serve --bg` or `tailscale funnel --bg`
- print the generated Tailscale or public HTTPS URL in the startup log
- use the generated `https/wss` URL as the direct agent address unless you already set `PANDA_AGENT_DIRECT_BASE_URL` or `PANDA_AGENT_WS_BASE_URL`

## Environment

- `PANDA_AGENT_PORT`
  Local agent listen port. Default: `4242`
- `PANDA_HUB_URL`
  Optional hub control-plane URL
- `PANDA_AGENT_TAILSCALE_SERVE_PORT`
  Tailscale HTTPS port. Default: same as `PANDA_AGENT_PORT`
- `PANDA_AGENT_TAILSCALE_PUBLISH_MODE`
  Optional publish mode. Supports `serve` or `funnel`
- `PANDA_TAILSCALE_SERVE=1`
  Optional env alternative to the startup flag

## Notes

- Tailscale Serve publishes a tailnet HTTPS address, not a public Internet address.
- Tailscale Funnel publishes a public Internet HTTPS address and corresponding `wss` endpoint.
- If the agent and hub run on the same machine, use different Tailscale HTTPS ports to avoid collisions. The default setup is `hub -> 443`, `agent -> agent port`.
