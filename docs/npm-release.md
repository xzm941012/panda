# Panda npm 发布说明

本文记录 Panda 当前的 npm 发布结构、token 获取方式和自动发布步骤。

## 发布包

当前发布 3 个 scoped npm 包：

- `@jamiexiongr/panda-agent`
  单独安装 agent 运行时。
- `@jamiexiongr/panda-hub`
  安装 hub 运行时，并自带打包后的 web UI。
- `@jamiexiongr/panda`
  一条命令安装总入口，依赖前两个包。

## token 在哪里获取

当前 npm 账号如果要求“发布必须 2FA”，那么只 `npm login` 还不够，发布时还需要：

- 一次性 OTP 验证码；或
- 一个允许发布的 granular access token，并开启 `Bypass two-factor authentication`

获取 token 的入口：

1. 打开 [npm 官网账号设置](https://www.npmjs.com/settings/)。
2. 进入 `Access Tokens` 页面。
3. 选择创建 `Granular Access Token`。
4. 给 token 赋予目标包的写权限。
5. 如果你的账号开启了发布 2FA，创建时勾选或启用 `Bypass two-factor authentication`。

官方文档：

- [About access tokens](https://docs.npmjs.com/about-access-tokens)
- [Creating and viewing access tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens)
- [Requiring 2FA for package publishing](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)

## 本地使用 token

推荐写到用户级 npm 配置，不要把 token 写进仓库。

最稳的本机配置方式：

```powershell
npm config set //registry.npmjs.org/:_authToken=你的_npm_token
```

这会写到你自己的用户级 `.npmrc`，不会写进当前仓库。

如果你更习惯手动写，也应该写到用户目录下的 `~/.npmrc`，不要写到仓库根目录。

临时环境变量也可以，但更适合 CI 或一次性流程。

PowerShell:

```powershell
$env:NODE_AUTH_TOKEN='你的 npm token'
```

如果只想临时用 OTP，也可以：

```powershell
$env:NPM_PUBLISH_OTP='当前 6 位验证码'
```

说明：

- `npm config set //registry.npmjs.org/:_authToken=...` 最适合本机长期发布。
- `NODE_AUTH_TOKEN` 更适合 CI 或临时环境。
- `NPM_PUBLISH_OTP` 适合临时手动发布。
- 仓库已把本地 `.npmrc` 和打包出的 `*.tgz` 加入 `.gitignore`。

## 发布命令

先确保已经安装依赖：

```powershell
corepack pnpm install
```

自动构建发布：

```powershell
corepack pnpm release:publish
```

如果要手动指定版本：

```powershell
corepack pnpm release:publish -- 0.1.1
```

如果不指定版本，脚本会：

- 读取本地 `release/*/package.json`
- 查询 npm registry 当前已发布版本
- 自动选择下一个 `patch` 版本

## VSCode 一键任务

如果你想以后只点任务，不手敲命令，仓库已经提供两个 VSCode task：

- `Setup: npm publish token`
  一次性把 npm token 写到你本机用户级 npm 配置里。
- `Release: Publish Panda`
  自动编译并发布 Panda。

使用方式：

1. 先运行一次 `Setup: npm publish token`
2. 后续只运行 `Release: Publish Panda`

`Release: Publish Panda` 内部已经包含构建，所以不需要手动先编译。

## 发布脚本会做什么

`corepack pnpm release:publish` 内部会自动执行：

1. 构建 `apps/web`
2. 打包 `release/panda-agent`
3. 打包 `release/panda-hub`
4. 把 `apps/web/dist` 复制到 `release/panda-hub/dist/web`
5. 打包 `release/panda`
6. 对 3 个包分别执行 `npm pack --dry-run`
7. 依次发布到 `https://registry.npmjs.org`

所以你不需要手动先跑编译，发布脚本已经自动编译。

## 首次发布步骤

1. `npm login`
2. 在 npm 官网创建可发布的 token，或者准备一个新鲜 OTP
3. 在本机配置 token：

```powershell
npm config set //registry.npmjs.org/:_authToken=你的_npm_token
```

4. 执行：

```powershell
corepack pnpm release:publish
```

5. 发布成功后验证：

```powershell
npm view @jamiexiongr/panda-agent version --registry=https://registry.npmjs.org
npm view @jamiexiongr/panda-hub version --registry=https://registry.npmjs.org
npm view @jamiexiongr/panda version --registry=https://registry.npmjs.org
```

## 安装命令

总入口：

```powershell
npm install -g @jamiexiongr/panda --registry=https://registry.npmjs.org
```

单独安装：

```powershell
npm install -g @jamiexiongr/panda-agent --registry=https://registry.npmjs.org
npm install -g @jamiexiongr/panda-hub --registry=https://registry.npmjs.org
```

## 运行命令

总入口安装后：

```powershell
panda agent
panda hub
panda agent tailscareserv
panda agent tailscareserv-pub
panda hub tailscareserv
panda hub tailscareserv-pub
```

单包安装后：

```powershell
panda-agent
panda-hub
panda-agent tailscareserv
panda-agent tailscareserv-pub
panda-hub tailscareserv
panda-hub tailscareserv-pub
```

说明：

- `tailscareserv` 与 `--tailscale-serve` 都可用。
- `tailscareserv-pub`、`--tailscale-serve-pub`、`tailscale-funnel` 会为 `hub` 或 `agent` 启用公网发布模式。
- 启用后，启动脚本会先检测本机 `tailscale` 是否在线，再自动执行 `tailscale serve --bg`。
- 公网发布模式底层走 `tailscale funnel --bg`。
- `hub` 走公网发布时更适合 Android Chrome 的 PWA 安装验证。
- `hub` 默认发布到 Tailscale HTTPS `443` 端口，可用 `PANDA_HUB_TAILSCALE_SERVE_PORT` 覆盖。
- `agent` 默认发布到与 `PANDA_AGENT_PORT` 相同的 Tailscale HTTPS 端口，可用 `PANDA_AGENT_TAILSCALE_SERVE_PORT` 覆盖。
- 也可以不用命令参数，改用环境变量：

```powershell
$env:PANDA_TAILSCALE_SERVE='1'
$env:PANDA_HUB_TAILSCALE_PUBLISH_MODE='funnel'
$env:PANDA_AGENT_TAILSCALE_PUBLISH_MODE='funnel'
```

- `PANDA_TAILSCALE_SERVE='1'` 会得到 tailnet 内可访问的 `https/wss` 地址，不会自动变成公网地址。
- `PANDA_HUB_TAILSCALE_PUBLISH_MODE='funnel'` 会把打包后的 hub/web 暴露为公网 HTTPS 地址。
- `PANDA_AGENT_TAILSCALE_PUBLISH_MODE='funnel'` 会让 agent 向 hub 注册公网 `https/wss` 地址，便于不在 tailnet 内的手机直连 agent。

## 本地验证脚本

日常改代码联调可以直接跑 release CLI 源码，不需要发包也不需要全局安装：

```powershell
corepack pnpm dev:cli:hub
corepack pnpm dev:cli:agent
```

如果要带额外参数，可以直接透传：

```powershell
corepack pnpm dev:cli:hub -- tailscareserv
corepack pnpm dev:cli:hub -- tailscareserv-pub
corepack pnpm dev:cli:agent -- tailscareserv --hub-url=https://example.ts.net
corepack pnpm dev:cli:agent -- tailscareserv-pub --hub-url=https://example.ts.net
```

如果要验证“打包出来的 npm 包”本身，但又不想覆盖全局安装版本，可以用临时包执行脚本：

```powershell
corepack pnpm verify:pkg:hub
corepack pnpm verify:pkg:agent
```

这些脚本会自动：

1. 运行 `release:build`
2. 在对应 `release/*` 目录执行 `npm pack`
3. 用 `npm exec --package <tgz>` 临时执行刚打出来的包

同样支持透传运行参数：

```powershell
corepack pnpm verify:pkg:hub -- tailscareserv
corepack pnpm verify:pkg:hub -- tailscareserv-pub
corepack pnpm verify:pkg:agent -- tailscareserv
corepack pnpm verify:pkg:agent -- tailscareserv-pub
```

说明：

- `dev:cli:*` 更适合日常联调，启动更快。
- `verify:pkg:*` 更适合发版前确认，验证的是实际打包产物。
- 这两组脚本默认使用服务自己的默认端口，不额外改端口。

## Windows 服务注册

如果你是在 Windows 上以 npm 全局安装正式版，并且希望开机自动拉起 Hub / Agent，可以直接把正式版注册为系统服务。

总入口：

```powershell
panda hub service install --name=PandaHub tailscareserv
panda agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4343
```

单包入口：

```powershell
panda-hub service install --name=PandaHub tailscareserv
panda-agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4343
```

常用命令：

```powershell
panda hub service status
panda hub service restart
panda hub service uninstall

panda agent service status
panda agent service restart
panda agent service uninstall
```

说明：

- `service install` 会把服务注册为自动启动。
- `install` 后面跟的启动参数会被记住，后续服务重启继续沿用。
- 当前进程中的 `PANDA_*` 环境变量也会一起写入服务定义。
- 如果你修改了启动参数，或者修改了 `PANDA_HUB_PORT`、`PANDA_HUB_URL`、`PANDA_AGENT_PORT` 这类 `PANDA_*` 变量，需要再次执行一次 `service install` 来更新服务配置。
- 开发版管理页里的“注册/更新服务”与“安装并恢复最新正式版”也遵循同一套约定：已注册服务时，升级流程会优先按 Windows 服务停止和重启。
