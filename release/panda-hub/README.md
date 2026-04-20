# @jamiexiongr/panda-hub

Published hub runtime for Panda, including the built web UI.

## Usage

```bash
panda-hub
panda-hub tailscareserv
```

`tailscareserv` and `--tailscale-serve` both enable automatic `tailscale serve` publishing.

Windows service management:

```powershell
panda-hub service install --name=PandaHub tailscareserv
panda-hub service status
panda-hub service restart
panda-hub service uninstall
```

`service install` stores the startup args and current `PANDA_*` environment values in the Windows service definition. If you change them later, run `service install` again to update the service.

When enabled, hub startup will:

- detect whether `tailscale` is available and online
- run `tailscale serve --bg`
- print the generated Tailscale HTTPS URL in the startup log

## Environment

- `PANDA_HUB_PORT`
  Local hub listen port. Default: `4343`
- `PANDA_HUB_TAILSCALE_SERVE_PORT`
  Tailscale HTTPS port. Default: `443`
- `PANDA_TAILSCALE_SERVE=1`
  Optional env alternative to the startup flag

## Notes

- Tailscale Serve publishes a tailnet HTTPS address, not a public Internet address.
- This is the recommended way to run the installable PWA on mobile, because the bundled hub serves the built web assets over HTTPS.
