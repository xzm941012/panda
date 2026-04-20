# @jamiexiongr/panda

Combined installer and CLI entry for Panda.

This package is intended for end users who want to run Panda on their own machine and open it from a phone over Tailscale.

## Requirements

- Node.js `>= 20.19.0`
- A desktop installation of Tailscale with CLI access
- Your computer and phone joined to the same tailnet
- Recommended mobile browsers:
  iPhone / iPad with Safari 16.4+;
  Android with a current Chrome stable release

For the complete Chinese install and usage guide in this repository, see `docs/panda-user-guide.md`.

## Install

```bash
npm install -g @jamiexiongr/panda@latest --registry=https://registry.npmjs.org/
```

## Usage

```bash
panda hub
panda hub tailscareserv

panda agent
panda agent tailscareserv
```

`tailscareserv` and `--tailscale-serve` both enable automatic `tailscale serve` publishing.

## Windows Service

Windows only:

```powershell
panda hub service install --name=PandaHub tailscareserv
panda agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4343

panda hub service status
panda agent service status

panda hub service restart
panda agent service restart

panda hub service uninstall
panda agent service uninstall
```

Notes:

- `service install` registers the service for automatic startup.
- Extra startup args after `install` are remembered by the service and reused on restart.
- The current `PANDA_*` environment variables are captured when you run `service install`.
- If you change startup args or `PANDA_*` values later, run `service install` again to update the service definition.

## Notes

- `panda hub tailscareserv` is the quickest path to a mobile-installable HTTPS PWA inside your tailnet.
- `panda agent tailscareserv` makes the agent register `https/wss` direct URLs when no explicit direct URL env vars are set.
- If `tailscale serve` says it is not enabled on your tailnet, open the approval link printed by the CLI and enable Serve for that node.
