# Panda npm 发布说明

这份文档面向 Panda 的发布维护者，说明当前 npm 包结构、发布前准备、发布命令和验证方式。

## 当前发布哪些包

Panda 目前发布 3 个 npm 包：

- `@jamiexiongr/panda`
  总入口包，安装后得到 `panda` 命令。
- `@jamiexiongr/panda-agent`
  Agent 独立运行时，安装后得到 `panda-agent` 命令。
- `@jamiexiongr/panda-hub`
  Hub 独立运行时，安装后得到 `panda-hub` 命令。

其中：

- `@jamiexiongr/panda` 依赖 `@jamiexiongr/panda-agent` 和 `@jamiexiongr/panda-hub`
- 对最终用户来说，通常只需要安装 `@jamiexiongr/panda`

## 发布前准备

发布前请确认以下条件已经满足：

- 已安装 Node.js
- 已安装项目依赖
- 拥有 npm 发布权限
- 已准备好可用于发布的 npm token，或准备好 OTP

安装依赖：

```powershell
corepack pnpm install
```

## npm token 从哪里获取

如果 npm 账号对发布启用了 2FA，那么仅执行 `npm login` 通常还不够。你需要以下其中一种：

- 一次性 OTP 验证码
- 可发布的 `Granular Access Token`

推荐使用 `Granular Access Token`，并开启允许发布的权限。

获取方式：

1. 打开 [npm 账号设置](https://www.npmjs.com/settings/)
2. 进入 `Access Tokens`
3. 创建 `Granular Access Token`
4. 给目标包授予写权限
5. 如果账号开启了发布 2FA，同时启用 `Bypass two-factor authentication`

官方文档：

- [About access tokens](https://docs.npmjs.com/about-access-tokens)
- [Creating and viewing access tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens)
- [Requiring 2FA for package publishing](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)

## 如何在本机配置 token

推荐写入用户级 npm 配置，不要写进仓库。

最常用方式：

```powershell
npm config set //registry.npmjs.org/:_authToken=你的_npm_token
```

这样会写入你本机用户目录下的 npm 配置，不会写进当前仓库。

如果你只想临时发布，也可以使用环境变量。

PowerShell：

```powershell
$env:NODE_AUTH_TOKEN='你的_npm_token'
```

如果你用的是 OTP：

```powershell
$env:NPM_PUBLISH_OTP='当前6位验证码'
```

建议：

- 本机长期发布优先使用 `npm config set`
- CI 或一次性流程优先使用 `NODE_AUTH_TOKEN`
- 临时人工发布可使用 `NPM_PUBLISH_OTP`

## 一条命令发布

安装依赖完成后，直接执行：

```powershell
corepack pnpm release:publish
```

如果要手动指定版本号：

```powershell
corepack pnpm release:publish -- 0.1.30
```

如果不传版本号，发布脚本会自动：

1. 读取 `release/*/package.json`
2. 查询 npm registry 当前版本
3. 选择下一个 `patch` 版本

## 发布脚本会自动做什么

`corepack pnpm release:publish` 会自动完成以下步骤：

1. 构建 `apps/web`
2. 打包 `release/panda-agent`
3. 打包 `release/panda-hub`
4. 把 `apps/web/dist` 复制到 `release/panda-hub/dist/web`
5. 打包 `release/panda`
6. 对 3 个包执行 `npm pack --dry-run`
7. 发布到 `https://registry.npmjs.org`

也就是说，正常情况下不需要手动先执行构建。

## 推荐发布流程

建议按这个顺序操作：

1. 安装依赖

```powershell
corepack pnpm install
```

2. 配置 npm token

```powershell
npm config set //registry.npmjs.org/:_authToken=你的_npm_token
```

3. 执行发布

```powershell
corepack pnpm release:publish
```

4. 发布完成后验证版本

```powershell
npm view @jamiexiongr/panda-agent version --registry=https://registry.npmjs.org
npm view @jamiexiongr/panda-hub version --registry=https://registry.npmjs.org
npm view @jamiexiongr/panda version --registry=https://registry.npmjs.org
```

## 发布前本地验证

如果你想先验证 CLI 本身是否正常运行，可以直接执行源码版入口：

```powershell
corepack pnpm dev:cli:hub
corepack pnpm dev:cli:agent
```

如果要透传参数：

```powershell
corepack pnpm dev:cli:hub -- tailscareserv
corepack pnpm dev:cli:hub -- tailscareserv-pub
corepack pnpm dev:cli:agent -- tailscareserv --hub-url=https://example.ts.net
corepack pnpm dev:cli:agent -- tailscareserv-pub --hub-url=https://example.ts.net
```

## 发布前验证打包产物

如果你想验证“真正打包出来的 npm 包”能不能正常运行，但又不想覆盖本机全局安装版本，可以使用：

```powershell
corepack pnpm verify:pkg:hub
corepack pnpm verify:pkg:agent
```

这些脚本会自动：

1. 执行 `release:build`
2. 在对应目录执行 `npm pack`
3. 通过 `npm exec --package <tgz>` 运行刚刚打出来的包

同样支持透传参数：

```powershell
corepack pnpm verify:pkg:hub -- tailscareserv
corepack pnpm verify:pkg:hub -- tailscareserv-pub
corepack pnpm verify:pkg:agent -- tailscareserv
corepack pnpm verify:pkg:agent -- tailscareserv-pub
```

## VSCode 一键任务

仓库里已经准备了两个常用任务：

- `Setup: npm publish token`
  把 npm token 写入本机用户级 npm 配置
- `Release: Publish Panda`
  自动构建并发布 Panda

如果你习惯用 VSCode，可以先运行一次 `Setup: npm publish token`，后续直接运行 `Release: Publish Panda`。

## 安装命令参考

总入口包：

```powershell
npm install -g @jamiexiongr/panda --registry=https://registry.npmjs.org
```

单独安装：

```powershell
npm install -g @jamiexiongr/panda-agent --registry=https://registry.npmjs.org
npm install -g @jamiexiongr/panda-hub --registry=https://registry.npmjs.org
```

## 运行命令参考

总入口安装后：

```powershell
panda hub
panda agent
panda hub tailscareserv
panda agent tailscareserv
panda hub tailscareserv-pub
panda agent tailscareserv-pub
```

单包安装后：

```powershell
panda-hub
panda-agent
panda-hub tailscareserv
panda-agent tailscareserv
panda-hub tailscareserv-pub
panda-agent tailscareserv-pub
```

说明：

- `tailscareserv` 与 `--tailscale-serve` 等价
- `tailscareserv-pub`、`--tailscale-serve-pub`、`tailscale-funnel` 都表示公网发布模式
- `hub` 使用公网发布模式时，更适合 Android Chrome 的 PWA 安装验证

## Windows 服务注册参考

如果你是在 Windows 上安装正式版，并希望让 Hub / Agent 开机自动启动，可以注册为系统服务。

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

常用管理命令：

```powershell
panda hub service status
panda hub service restart
panda hub service uninstall

panda agent service status
panda agent service restart
panda agent service uninstall
```

说明：

- `service install` 会注册为自动启动服务
- `install` 后面的启动参数会被保存
- 当前 shell 中的 `PANDA_*` 环境变量也会一起保存
- 如果启动参数或 `PANDA_*` 变量发生变化，需要重新执行一次 `service install`

## 发布后建议检查

发布成功后，建议至少再做一次：

1. `npm view` 确认版本已更新
2. 新开一个终端，用全局安装方式安装最新版本
3. 实际运行一次 `panda hub` 或 `panda agent`
4. 如有需要，再验证 `tailscareserv` 或 Windows 服务流程
