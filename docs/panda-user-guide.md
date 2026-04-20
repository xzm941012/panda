# Panda 用户安装与使用指南

这份文档面向实际使用 Panda 的用户，不面向开发者。

如果你的目标是：

- 在电脑上安装 Panda
- 启动 `Hub` 和 `Agent`
- 用手机或浏览器访问 Panda

按这份文档操作即可。

## Panda 是什么

Panda 由两部分组成：

- `Hub`
  提供 Panda 的 Web 页面，手机扫码后打开的就是它。
- `Agent`
  连接你的本机或远程 AI 编码环境、终端和项目。

最常见的使用方式是：

1. 在电脑上启动 `Hub`
2. 在同一台电脑或另一台电脑上启动 `Agent`
3. 用手机或浏览器打开 `Hub`
4. 在页面中连接并使用 `Agent`

## 先看你属于哪种使用场景

Panda 常见有两种访问方式：

### 1. Tailscale 访问

适合：

- 手机扫码打开 Panda
- 使用 `https://...ts.net` 地址访问
- 在 Android Chrome 上验证 PWA 安装

### 2. 局域网直连

适合：

- 电脑和手机在同一个局域网
- 不想安装 Tailscale
- 直接通过 `http://局域网IP:端口` 访问

如果你不确定该选哪种，优先使用 Tailscale。

## 环境要求

### 电脑端

- Node.js `20.19.0` 或更高版本
- npm
- Windows、macOS 或 Linux
- 如果要使用 Tailscale 访问，额外安装 `Tailscale`

推荐 Node.js 版本：

- `20.19.3`

### 手机端

- 如果走 Tailscale 访问，手机必须登录到和电脑相同的 tailnet
- iPhone / iPad 建议使用 Safari
- Android 建议使用最新版 Chrome

如果你走局域网直连，手机不需要安装 Tailscale，但必须和电脑处于同一个局域网。

## 第一步：安装 Panda

推荐直接安装总入口包：

```powershell
npm install -g @jamiexiongr/panda@latest --registry=https://registry.npmjs.org/
```

安装完成后会得到统一命令：

```powershell
panda
```

如果你只想单独安装某一部分，也可以：

```powershell
npm install -g @jamiexiongr/panda-hub@latest --registry=https://registry.npmjs.org/
npm install -g @jamiexiongr/panda-agent@latest --registry=https://registry.npmjs.org/
```

如果你已经装过旧版本，重新执行安装命令即可完成升级。

## 第二步：运行 Panda

### 方案 A：同一台电脑同时运行 Hub 和 Agent

这是最常见的方式。

先启动 Hub：

```powershell
panda hub tailscareserv
```

再启动 Agent：

```powershell
panda agent tailscareserv
```

启动成功后：

- `Hub` 会在终端输出 HTTPS 地址和二维码
- `Agent` 会在终端输出自己的注册地址

你可以直接用手机扫码，或者在浏览器打开 Hub 打印出来的地址。

### 方案 B：局域网直连，不使用 Tailscale

先启动 Hub：

```powershell
panda hub
```

再启动 Agent：

```powershell
$env:PANDA_GROUP_IP='127.0.0.1'
panda agent
```

如果你需要让同一局域网中的其他设备访问 Hub，请在浏览器打开：

```text
http://你的电脑IP:4343
```

## 第三步：手机访问 Panda

### 使用 Tailscale 时

1. 确保电脑和手机都已经登录同一个 Tailscale 网络
2. 启动 `panda hub tailscareserv`
3. 查看终端输出的二维码或 `https://...ts.net` 地址
4. 用手机扫码或手动打开该地址

### 使用局域网直连时

1. 确保手机和电脑在同一个局域网
2. 启动 `panda hub`
3. 在手机浏览器打开：

```text
http://你的电脑IP:4343
```

## Android PWA 安装建议

如果你的目标是让 Android Chrome 更稳定地显示“安装应用”，建议把 `Hub` 改成公网发布模式：

```powershell
panda hub tailscareserv-pub
```

如果手机不在 Tailscale 里，但你仍希望 Panda 页面能继续直连 Agent，可以把 Agent 也切成公网发布模式：

```powershell
panda agent tailscareserv-pub
```

## Hub 和 Agent 不在同一台电脑时怎么启动

先在 Hub 所在机器启动：

```powershell
panda hub tailscareserv
```

记下终端输出的 Hub 地址，再到 Agent 所在机器执行：

```powershell
$env:PANDA_HUB_URL='https://你的-hub-地址.ts.net'
panda agent tailscareserv
```

如果是 macOS / Linux：

```bash
export PANDA_HUB_URL='https://你的-hub-地址.ts.net'
panda agent tailscareserv
```

## Windows 开机自启动

如果你在 Windows 上通过 npm 全局安装了 Panda，并希望开机自动运行，可以注册成 Windows 服务。

总入口安装后：

```powershell
panda hub service install --name=PandaHub tailscareserv
panda agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4343
```

查看、重启、卸载服务：

```powershell
panda hub service status
panda hub service restart
panda hub service uninstall

panda agent service status
panda agent service restart
panda agent service uninstall
```

说明：

- `service install` 会记住你当前的启动参数
- 当前 shell 中的 `PANDA_*` 环境变量也会一起写入服务配置
- 如果你改了参数或环境变量，重新执行一次 `service install` 即可更新

## 常用环境变量

大多数用户直接用默认值即可。

如果你需要改端口或显式指定连接地址，最常用的是这些：

- `PANDA_HUB_PORT`
  Hub 本地端口，默认 `4343`
- `PANDA_AGENT_PORT`
  Agent 本地端口，默认 `4242`
- `PANDA_HUB_URL`
  Agent 要注册到的 Hub 地址
- `PANDA_HUB_API_KEY`
  Hub 与 Agent 的认证 key
- `PANDA_AGENT_DIRECT_BASE_URL`
  Agent 对外注册的 HTTP 地址
- `PANDA_AGENT_WS_BASE_URL`
  Agent 对外注册的 WebSocket 地址
- `PANDA_CODEX_HOME`
  Panda 本地数据目录

示例：

```powershell
$env:PANDA_HUB_PORT='4543'
panda hub
```

```powershell
$env:PANDA_AGENT_PORT='4242'
$env:PANDA_HUB_URL='http://192.168.188.2:4343'
$env:PANDA_AGENT_DIRECT_BASE_URL='http://192.168.188.3:4242'
$env:PANDA_AGENT_WS_BASE_URL='ws://192.168.188.3:4242/ws'
panda agent
```

## 常见问题

### 1. 安装后找不到 `panda` 命令

通常是 npm 全局安装目录没有加入系统 `PATH`。重新打开终端后再试；如果仍不行，检查 Node.js 和 npm 的全局安装路径配置。

### 2. 手机扫码后打不开页面

优先检查：

1. `Hub` 是否仍在运行
2. 手机和电脑是否在同一个 tailnet
3. 终端输出的是否为 `https://...ts.net`
4. Tailscale 是否在线

### 3. 提示 `Serve is not enabled on your tailnet`

这是 Tailscale 侧尚未启用 Serve。

处理方式：

1. 打开终端里打印出的授权链接
2. 按页面提示启用 Serve
3. 重新运行 `panda hub tailscareserv`

### 4. 页面能打开，但没有 Agent

通常是以下原因之一：

1. `Agent` 还没启动
2. `PANDA_HUB_URL` 指向错误
3. `Hub` 和 `Agent` 不在同一个网络环境中
4. 局域网模式下，Agent 没有把自己的直连地址注册正确

### 5. 端口被占用

改一个端口后重新启动即可：

```powershell
$env:PANDA_HUB_PORT='4543'
panda hub
```

## 推荐上手顺序

如果你是第一次使用 Panda，建议按下面顺序操作：

1. 安装 Node.js
2. 如果要手机扫码访问，再安装并登录 Tailscale
3. 执行：

```powershell
npm install -g @jamiexiongr/panda@latest --registry=https://registry.npmjs.org/
```

4. 启动 `panda hub tailscareserv`
5. 用手机确认页面可以打开
6. 启动 `panda agent tailscareserv`
7. 回到页面确认 Agent 已出现

## 参考链接

- Node.js 下载：
  [https://nodejs.org/](https://nodejs.org/)
- Tailscale Serve 文档：
  [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale HTTPS 文档：
  [https://tailscale.com/docs/how-to/set-up-https-certificates](https://tailscale.com/docs/how-to/set-up-https-certificates)
