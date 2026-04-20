This directory contains npm release-only packages and build artifacts.

Windows service support for installed release packages lives in:

- `@jamiexiongr/panda`: `panda hub service ...` and `panda agent service ...`
- `@jamiexiongr/panda-hub`: `panda-hub service ...`
- `@jamiexiongr/panda-agent`: `panda-agent service ...`

Service registration stores the current startup args and `PANDA_*` environment variables so the service can auto-start with the same runtime configuration later.
