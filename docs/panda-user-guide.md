# Panda 用户安装与使用指南

本文面向最终用户，不面向开发者。

如果你只是想在自己的电脑上跑 Panda，然后用手机访问它，请按这份文档操作。

Panda 支持两种常见访问方式：

- 使用 Tailscale / Tailscale Funnel 对外发布，适合手机扫码和 PWA 安装
- 直接使用局域网 IP 访问，适合同一内网里的电脑之间互联

## Panda 是什么

Panda 由两部分组成：

- `Hub`
  提供手机端访问的 Web 界面，也是你扫码后打开的页面。
- `Agent`
  提供本机 AI 编码会话、项目、终端和同步能力。

最常见的使用方式是：

1. 在电脑上启动 `Hub`
2. 在同一台电脑上或另一台电脑上启动 `Agent`
3. 用手机扫描 `Hub` 控制台打印出来的二维码
4. 在手机浏览器里打开 Panda，必要时添加到主屏幕

## 环境要求

### 电脑端

- 操作系统：
  Windows、macOS 或 Linux，只要能安装 Node.js 即可；如果你要使用 Tailscale / Funnel 访问，再额外安装 Tailscale。
- Node.js：
  Panda 的 npm 包要求 `Node.js >= 20.19.0`。
  推荐直接使用 `20.19.3`，这是当前项目锁定版本。
- npm：
  使用随 Node.js 一起安装的 npm 即可，不需要额外安装 pnpm。
- Tailscale：
  如果你要使用手机扫码、tailnet 内 HTTPS 访问、或 Android Chrome 的 PWA 安装，建议安装最新稳定版桌面客户端。
  如果你只是在局域网内直接通过 `http://局域网IP:端口` 访问，可以不安装 Tailscale。
  如果你需要一个保守的“可用最低实践值”，建议使用 `1.52+`，因为 Tailscale 官方说明 `tailscale serve` 的 CLI 形式在 `1.52` 发生过变化；Panda 当前就是基于这一套命令行为来工作的。
  当前本地验证版本是 `1.96.3`。

### 手机端

- 如果你使用 Tailscale 访问，手机必须已经登录到和电脑相同的 Tailscale tailnet。
- iPhone / iPad：
  推荐 `iOS / iPadOS 16.4+`。
  这是当前最稳的 PWA 使用门槛，且从 16.4 开始，iOS/iPadOS 对主屏幕 Web App 与第三方浏览器“添加到主屏幕”的支持更完整。
- Android：
  推荐使用最新稳定版 Chrome。
  如果必须给一个保守版本线，建议 `Chrome 111+`。
- 其他手机浏览器：
  只要是当前版本的现代浏览器，通常都能正常打开 Panda 页面；
  但如果你想获得最稳定的“添加到主屏幕”体验，iPhone/iPad 建议优先用 Safari，Android 建议优先用 Chrome。

如果你走局域网直连模式，手机不需要加入 Tailscale，但它必须和运行 Panda 的电脑处于同一个局域网，并且本机防火墙要放行对应端口。

### Tailscale 侧前提

- 电脑和手机都必须已经加入同一个 tailnet。
- Panda 默认通过 `tailscale serve` 暴露 `Hub`，这样手机打开的是 `https://<machine>.<tailnet>.ts.net`，适合扫码和 tailnet 内访问。
- 如果你的目标是让 Android Chrome 走“安装应用”并完成真正的 PWA 安装，优先使用 `panda hub tailscareserv-pub`，它会改用 `Tailscale Funnel` 暴露公网 HTTPS 地址。
- 如果你的 tailnet 没开 `MagicDNS` 或 `HTTPS certificates`，`tailscale serve` 可能无法正常工作。

## 第一次使用前：打开 Tailscale Serve

如果你打算直接用二维码在手机上打开 Panda，建议先把 Tailscale Serve 所需能力准备好。

### 1. 确认电脑和手机都已经登录 Tailscale

在电脑终端执行：

```powershell
tailscale status
```

能看到当前机器在线即可。

### 2. 在 Tailscale 管理后台打开 MagicDNS 和 HTTPS

按 Tailscale 官方文档的要求，在你的 tailnet 管理后台确认：

1. 打开 DNS 页面
2. 启用 `MagicDNS`
3. 在 `HTTPS Certificates` 里启用 HTTPS

如果你没有这些权限，需要 tailnet 的 Owner / Admin 帮你打开。

更具体地说，你可以直接按下面做：

1. 打开 Tailscale 管理后台：
   [https://login.tailscale.com/admin](https://login.tailscale.com/admin)
2. 进入 DNS 页面：
   [https://login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns)
3. 找到 `MagicDNS`
4. 如果还没开启，点击 `Enable MagicDNS`
5. 在同一页找到 `HTTPS Certificates`
6. 如果还没开启，点击 `Enable HTTPS`
7. 保存或确认页面设置

完成后，回到电脑终端重新执行 `panda hub tailscareserv`。

### 3. 如果启动时提示 Serve 未启用

如果你运行 Panda 时看到类似下面的提示：

```text
Serve is not enabled on your tailnet.
To enable, visit:
https://login.tailscale.com/f/serve?node=...
```

直接在电脑浏览器里打开它打印出来的链接并确认即可。

这是最直接的开通方式。

这个链接通常长这样：

```text
https://login.tailscale.com/f/serve?node=...
```

它就是 Tailscale 官方的 Serve 授权页面。
如果你的 tailnet 已经打开了 `MagicDNS` 和 `HTTPS`，通常只要在这个页面点确认就可以。

### 4. 可选：检查机器页

如果你已经开了 DNS 和 HTTPS，但手机还是打不开，可以再看一下机器页：

1. 打开机器列表：
   [https://login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines)
2. 点击运行 Panda 的那台电脑
3. 确认这台机器当前在线
4. 再回到终端重试 `panda hub tailscareserv`

## 安装

### 推荐安装：总入口

```powershell
npm install -g @jamiexiongr/panda@latest --registry=https://registry.npmjs.org/
```

安装后你会得到一个统一命令：

```powershell
panda
```

### 也可以分别安装

如果你只想单独安装 `Hub` 或 `Agent`，也可以：

```powershell
npm install -g @jamiexiongr/panda-hub@latest --registry=https://registry.npmjs.org/
npm install -g @jamiexiongr/panda-agent@latest --registry=https://registry.npmjs.org/
```

如果你已经装过旧版本，直接再次执行上面的命令即可，npm 会直接升级覆盖，不需要先卸载。

## Windows 开机自启动

如果你是在 Windows 上用 npm 全局安装 Panda，并且希望它像服务一样开机自启动，可以把 Hub / Agent 注册成 Windows 服务。

总入口：

```powershell
panda hub service install --name=PandaHub tailscareserv
panda agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4343
```

如果你是单独安装的包，也可以：

```powershell
panda-hub service install --name=PandaHub tailscareserv
panda-agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4343
```

查看 / 重启 / 卸载服务：

```powershell
panda hub service status
panda hub service restart
panda hub service uninstall

panda agent service status
panda agent service restart
panda agent service uninstall
```

说明：

- `service install` 会把当前启动参数记住，并注册为自动启动服务。
- `service install` 时当前 shell 里的 `PANDA_*` 环境变量也会一起保存到服务配置里。
- 如果当前没有显式设置 `PANDA_CODEX_HOME`，服务注册时会自动固化为当前安装用户的 `~/.codex`，避免 Windows 服务切到 `LocalSystem` 后读到空工作区。
- 如果你后来改了启动参数或 `PANDA_*` 变量，需要重新执行一次 `service install` 来更新服务。
- 如果你更习惯用系统环境变量，也可以先在 Windows 的“系统环境变量”里配置 `PANDA_HUB_PORT`、`PANDA_AGENT_PORT`、`PANDA_HUB_URL` 等，再执行 `service install`。

## 运行

### 最常见：同一台电脑同时跑 Hub 和 Agent

先启动 Hub：

```powershell
panda hub tailscareserv
```

如果你是为了 Android Chrome 的 PWA 安装，建议直接改用：

```powershell
panda hub tailscareserv-pub
```

再启动 Agent：

```powershell
panda agent tailscareserv
```

如果你的手机不在 Tailscale 里，但还需要从 Hub 页面继续直连 Agent，可改用：

```powershell
panda agent tailscareserv-pub
```

说明：

- `tailscareserv` 和 `--tailscale-serve` 是等价的。
- `tailscareserv-pub`、`--tailscale-serve-pub`、`tailscale-funnel` 是 `hub` 和 `agent` 共用的公网发布别名。
- `Hub` 默认本地监听端口是 `4343`。
- `Agent` 默认本地监听端口是 `4242`。
- `Hub` 默认会把 Tailscale HTTPS 暴露到 `443`。
- `Agent` 默认会把 Tailscale HTTPS 暴露到与本地端口相同的端口。
- `tailscareserv` 得到的是 tailnet 内 HTTPS 地址。
- `hub tailscareserv-pub` 得到的是公网 HTTPS 地址，更适合 Android Chrome 安装应用。
- `agent tailscareserv-pub` 会让 Agent 向 Hub 注册公网 `https/wss` 地址，适合手机不在 Tailscale 时继续访问节点。

### 局域网直连：不使用 Tailscale

如果你的目标是在同一个局域网里，让另一台电脑或手机直接访问 Panda，那么不需要带 `tailscareserv` 或 `tailscareserv-pub` 参数。

`panda hub` 自带 Web 页面，所以浏览器直接打开 `Hub` 地址即可，不需要再单独启动一个 `web` 服务。

如果 `Hub` 和 `Agent` 都跑在同一台局域网机器，例如它的 IP 是 `192.168.188.2`：

先启动 Hub：

```powershell
$env:PANDA_HUB_PORT='4343'
panda hub
```

再启动 Agent：

```powershell
$env:PANDA_AGENT_PORT='4242'
$env:PANDA_AGENT_NAME='家正式版'
$env:PANDA_HUB_URL='http://172.16.2.239:4343'
$env:PANDA_AGENT_DIRECT_BASE_URL='http://172.16.2.239:4242'
$env:PANDA_AGENT_WS_BASE_URL='ws://172.16.2.239:4242/ws'
panda agent
```

简化版

```powershell
$env:PANDA_GROUP_IP='172.16.2.239'
$env:PANDA_AGENT_NAME='家正式版'
panda agent
```

局域网内其他设备访问地址：

- Hub / Web 页面：`http://192.168.188.2:4343`
- Agent HTTP 地址：`http://192.168.188.2:4242`
- Agent WebSocket 地址：`ws://192.168.188.2:4242/ws`

如果 `Hub` 和 `Agent` 不在同一台机器：

1. 在 Hub 机器上执行：

```powershell
$env:PANDA_HUB_PORT='4343'
panda hub
```

2. 在 Agent 机器上，把下面命令里的 `192.168.188.2` 改成 Hub 机器的局域网 IP，再把 `192.168.188.3` 改成 Agent 机器自己的局域网 IP：

```powershell
$env:PANDA_AGENT_PORT='4242'
$env:PANDA_HUB_URL='http://192.168.188.2:4343'
$env:PANDA_AGENT_DIRECT_BASE_URL='http://192.168.188.3:4242'
$env:PANDA_AGENT_WS_BASE_URL='ws://192.168.188.3:4242/ws'
panda agent
```

说明：

- `Hub` 和 `Agent` 默认监听在 `0.0.0.0`，所以局域网其他节点可以访问
- 如果机器有多个网卡，建议显式设置 `PANDA_AGENT_DIRECT_BASE_URL` 和 `PANDA_AGENT_WS_BASE_URL`，避免 Agent 向 Hub 注册成错误的地址
- 如果局域网设备访问失败，优先检查操作系统防火墙是否放行了 `4343` 和 `4242`

### 只启动 Hub

如果你想先只确认手机网页能不能打开：

```powershell
panda hub tailscareserv
```

如果你想优先验证 Android PWA 安装链路：

```powershell
panda hub tailscareserv-pub
```

### Hub 和 Agent 不在同一台电脑

先在 Hub 所在机器启动：

```powershell
panda hub tailscareserv
```

记下控制台打印的 `Panda hub Tailscale HTTPS URL`。

再到 Agent 所在机器启动：

```powershell
$env:PANDA_HUB_URL='https://你的-hub-地址.ts.net'
panda agent tailscareserv
```

如果手机走公网访问，而你也希望页面能直连 Agent，可以改用：

```powershell
$env:PANDA_HUB_URL='https://你的-hub-地址.ts.net'
panda agent tailscareserv-pub
```

如果是 macOS / Linux：

```bash
export PANDA_HUB_URL='https://你的-hub-地址.ts.net'
panda agent tailscareserv
```

## 如何使用

### 1. 先看 Hub 控制台

成功启动 `panda hub tailscareserv` 后，控制台通常会打印：

- 本地监听地址
- `Panda hub Tailscale HTTPS URL: https://...`
- 一段二维码

### 2. 用手机扫描二维码

确保手机已经连入相同 tailnet 后：

1. 用手机相机或浏览器扫码
2. 打开二维码对应的 `https://...ts.net` 地址
3. 首次打开时，等待页面加载完成

### 3. 添加到主屏幕

如果你想把 Panda 当成手机上的“准 App”来用：

- iPhone / iPad：
  在 Safari 中打开页面后，点分享菜单，再点“添加到主屏幕”。
- Android：
  在 Chrome 中打开页面后，使用“安装应用”或“添加到主屏幕”。

### 4. 启动 Agent 后查看是否已注册

成功启动 `panda agent tailscareserv` 后，控制台通常会打印：

- `Panda agent Tailscale HTTPS URL: ...`
- `Panda agent will register to hub: ...`

如果注册成功，Hub 页面里应该能看到对应 Agent 和项目数据。

## 常用环境变量

大多数用户直接跑默认值就够了。

如果你需要改端口或显式指定 Hub 地址，可以用这些环境变量：

- `PANDA_HUB_PORT`
  Hub 本地监听端口，默认 `4343`
- `PANDA_AGENT_PORT`
  Agent 本地监听端口，默认 `4242`
- `PANDA_HUB_URL`
  Agent 要注册到的 Hub 地址
- `PANDA_HUB_API_KEY`
  Hub-Agent 控制面认证 key。Hub 启动时会优先读取这个环境变量；如果没设置，会读取本地 key 文件；如果文件也不存在，Hub 会自动生成一个
- `PANDA_HUB_TAILSCALE_SERVE_PORT`
  Hub 对外的 Tailscale HTTPS 端口，默认 `443`
- `PANDA_AGENT_TAILSCALE_SERVE_PORT`
  Agent 对外的 Tailscale HTTPS 端口，默认与 Agent 本地端口相同
- `PANDA_AGENT_TAILSCALE_PUBLISH_MODE`
  `agent` 的发布模式，支持 `serve` 或 `funnel`
- `PANDA_AGENT_DIRECT_BASE_URL`
  Agent 注册给 Hub 的直连 HTTP 地址。局域网多机部署时建议显式设置
- `PANDA_AGENT_WS_BASE_URL`
  Agent 注册给 Hub 的直连 WebSocket 地址。局域网多机部署时建议显式设置
- `PANDA_CODEX_HOME`
  Panda 本地数据目录。Hub 的 API key 文件默认位于 `PANDA_CODEX_HOME/secrets/hub-api-key`；如果没设置这个变量，默认使用 `~/.panda/secrets/hub-api-key`
- `PANDA_TAILSCALE_SERVE=1`
  如果你不想写 `tailscareserv` 参数，也可以用这个环境变量开启 Tailscale Serve
- `PANDA_HUB_TAILSCALE_PUBLISH_MODE`
  `hub` 的发布模式，支持 `serve` 或 `funnel`

示例：

```powershell
$env:PANDA_TAILSCALE_SERVE='1'
panda hub
```

```powershell
$env:PANDA_HUB_TAILSCALE_PUBLISH_MODE='funnel'
panda hub
```

```powershell
$env:PANDA_AGENT_TAILSCALE_PUBLISH_MODE='funnel'
panda agent
```

```powershell
$env:PANDA_HUB_PORT='4343'
panda hub
```

```powershell
$env:PANDA_AGENT_PORT='4242'
$env:PANDA_HUB_URL='http://192.168.188.2:4343'
$env:PANDA_AGENT_DIRECT_BASE_URL='http://192.168.188.2:4242'
$env:PANDA_AGENT_WS_BASE_URL='ws://192.168.188.2:4242/ws'
panda agent
```

## 常见问题

### 1. 扫码后打不开页面

优先检查：

1. 手机是否已经加入同一个 Tailscale tailnet
2. 电脑上的 Tailscale 是否在线
3. 控制台里打印的是不是 `https://...ts.net`
4. `Hub` 进程是否仍在运行

### 2. 提示 `Serve is not enabled on your tailnet`

这是 Tailscale 侧没有开好。

处理方法：

1. 先确认 `MagicDNS` 和 `HTTPS certificates` 已启用
2. 打开 Panda 控制台打印出来的 `https://login.tailscale.com/f/serve?...` 链接
3. 按页面提示完成授权
4. 重新运行 `panda hub tailscareserv`

### 3. 扫码后页面返回 404

通常说明：

- 你启动的不是 `Hub`
- 当前安装的包版本过旧
- Hub 进程本身没完整启动

建议先升级到最新版本后重试：

```powershell
npm install -g @jamiexiongr/panda@latest --registry=https://registry.npmjs.org/
```
### 4. Hub 能打开，但没有 Agent

说明 Web 界面正常，但 Agent 还没接入。

检查：

1. `Agent` 是否已经启动
2. `PANDA_HUB_URL` 是否指向正确的 Hub 地址
3. 如果手机不在 Tailscale 内，而页面又需要直连 Agent，确认 Agent 是否用了 `tailscareserv-pub`
4. 如果 Agent 仍是 `tailscareserv`，确认 Hub、Agent 和手机是否在同一个 tailnet 内可互通

如果你走的是局域网直连模式，再额外检查：

5. Agent 是否把 `PANDA_HUB_URL` 指到了正确的局域网 Hub 地址，例如 `http://192.168.188.2:4343`
6. 如果 `Hub` 和 `Agent` 不在同一台机器，确认 Agent 所在机器也拿到了同一把 `PANDA_HUB_API_KEY`
7. 如果机器有多个网卡，确认 `PANDA_AGENT_DIRECT_BASE_URL` / `PANDA_AGENT_WS_BASE_URL` 没有注册成其他网卡地址

### 5. 端口被占用

如果默认端口冲突，可以改环境变量后再启动：

```powershell
$env:PANDA_HUB_PORT='4543'
panda hub tailscareserv
```

如果你走局域网直连模式，也一样：

```powershell
$env:PANDA_HUB_PORT='4543'
panda hub
```

## 推荐使用顺序

如果你是第一次用 Panda，推荐按下面顺序来：

1. 安装 Tailscale，并让电脑和手机加入同一个 tailnet
2. 在 Tailscale 管理后台打开 `MagicDNS` 和 `HTTPS`
3. 执行：

```powershell
npm install -g @jamiexiongr/panda@latest --registry=https://registry.npmjs.org/
```

4. 执行 `panda hub tailscareserv`
5. 手机扫码，确认页面能打开
6. 执行 `panda agent tailscareserv`
7. 回到手机页面，确认能看到 Agent

## 参考链接

- Node.js 下载：
  [https://nodejs.org/](https://nodejs.org/)
- Tailscale Serve 文档：
  [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale HTTPS 文档：
  [https://tailscale.com/docs/how-to/set-up-https-certificates](https://tailscale.com/docs/how-to/set-up-https-certificates)
- Tailscale Serve 示例：
  [https://tailscale.com/kb/1313/serve-examples](https://tailscale.com/kb/1313/serve-examples)
- WebKit iOS/iPadOS 16.4 Home Screen Web App 说明：
  [https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- Vite 浏览器兼容性说明：
  [https://vite.dev/guide/build](https://vite.dev/guide/build)
