# Panda Windows 服务使用说明

本文面向通过 npm 安装 Panda 正式版的 Windows 用户。

目标：

- 让 `Hub` / `Agent` 可以注册成 Windows 服务
- 支持开机自启动
- 让服务记住启动参数
- 让服务启动时继续读取并沿用 `PANDA_*` 环境变量
- 说明升级后的推荐操作步骤

## 适用范围

当前服务注册能力仅支持 Windows。

支持以下命令入口：

- `panda hub service ...`
- `panda agent service ...`
- `panda-hub service ...`
- `panda-agent service ...`

如果你安装的是总入口包 `@jamiexiongr/panda`，优先使用：

```powershell
panda hub ...
panda agent ...
```

## 一、先更新正式版

先把全局安装的 Panda 升级到最新版本：

```powershell
npm install -g @jamiexiongr/panda@latest --registry=https://registry.npmjs.org/
```

如果你只安装单包，也可以分别升级：

```powershell
npm install -g @jamiexiongr/panda-hub@latest --registry=https://registry.npmjs.org/
npm install -g @jamiexiongr/panda-agent@latest --registry=https://registry.npmjs.org/
```

## 二、配置运行参数

Panda 当前仍然沿用原来的启动方式：

- 启动参数
- `PANDA_*` 环境变量

也就是说，注册成 Windows 服务后，并不会切换成另一套独立配置格式。

### 1. 可以配置哪些环境变量

常见变量包括：

- `PANDA_HUB_PORT`
- `PANDA_AGENT_PORT`
- `PANDA_HUB_URL`
- `PANDA_AGENT_DIRECT_BASE_URL`
- `PANDA_AGENT_WS_BASE_URL`
- `PANDA_AGENT_NAME`
- `PANDA_TAILSCALE_SERVE`
- `PANDA_HUB_TAILSCALE_PUBLISH_MODE`
- `PANDA_AGENT_TAILSCALE_PUBLISH_MODE`

### 2. 可以配到哪里

有两种常见方式：

1. 配到当前 PowerShell 会话
2. 配到 Windows 系统环境变量

例如当前会话里临时设置：

```powershell
$env:PANDA_HUB_PORT='4343'
$env:PANDA_AGENT_PORT='4242'
$env:PANDA_HUB_URL='http://127.0.0.1:4343'
$env:PANDA_AGENT_DIRECT_BASE_URL='http://127.0.0.1:4242'
$env:PANDA_AGENT_WS_BASE_URL='ws://127.0.0.1:4242/ws'
```

如果你希望长期生效，也可以直接配置到 Windows 的系统环境变量里。

## 三、先手动运行确认

注册服务之前，建议先按你准备好的参数手动启动一次，确认配置没有问题。

### Hub

```powershell
panda hub
```

如果你要带额外启动参数，例如：

```powershell
panda hub tailscareserv
```

### Agent

```powershell
panda agent
```

如果你要显式指定 Hub 地址：

```powershell
panda agent --hub-url=http://127.0.0.1:4343
```

这一步确认的是：

- 端口是否正确
- Hub / Agent 是否能启动
- `PANDA_*` 环境变量是否符合预期
- 额外启动参数是否正确

## 四、注册成 Windows 服务

确认手动启动没问题后，再注册服务。

建议顺序：

1. 先注册 Hub
2. 再注册 Agent

### 1. 注册 Hub 服务

```powershell
panda hub service install --name=PandaHub
```

如果 Hub 需要带启动参数：

```powershell
panda hub service install --name=PandaHub tailscareserv
```

### 2. 注册 Agent 服务

```powershell
panda agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4343
```

## 五、服务注册时会保存什么

执行 `service install` 时，当前实现会保存两类信息：

### 1. 启动参数

例如：

```powershell
panda hub service install --name=PandaHub tailscareserv
```

这里的 `tailscareserv` 会被记住。

以后服务自动启动、手动重启时，都会继续使用这个参数。

### 2. 当前生效的 `PANDA_*` 环境变量

例如你执行安装服务前，当前环境里已经有：

```powershell
$env:PANDA_HUB_PORT='4343'
$env:PANDA_AGENT_PORT='4242'
```

那么这些 `PANDA_*` 值也会一起写入服务定义。

也就是说：

- 服务启动时仍然按原来的 `PANDA_*` 逻辑运行
- 不是切换成另一套服务专用配置

### 3. `PANDA_CODEX_HOME` 的默认固化行为

Windows 服务默认运行在 `LocalSystem` 账户下，它的 home 目录不是你平时登录用户的目录。

因此当前实现会在执行 `service install` 时：

- 如果你已经显式设置了 `PANDA_CODEX_HOME`，就保存这个值
- 如果你没有设置，就自动保存“当前安装用户”的 `~/.codex`
- 同时也会把 `CODEX_HOME` 对齐到同一个目录，保证底层 `codex app-server` 恢复线程时读取的是同一份 rollout 数据

这样服务启动后仍会读取你自己的工作区数据，而不是落到 `LocalSystem` 的空目录里。

## 六、服务管理命令

### 查看状态

```powershell
panda hub service status
panda agent service status
```

### 启动服务

```powershell
panda hub service start
panda agent service start
```

### 停止服务

```powershell
panda hub service stop
panda agent service stop
```

### 重启服务

```powershell
panda hub service restart
panda agent service restart
```

### 卸载服务

```powershell
panda hub service uninstall
panda agent service uninstall
```

## 七、升级后的推荐步骤

如果你已经注册了服务，升级后建议按下面顺序处理。

### 场景 A：只升级包版本，配置没变

先升级：

```powershell
npm install -g @jamiexiongr/panda@latest --registry=https://registry.npmjs.org/
```

然后重启服务：

```powershell
panda hub service restart
panda agent service restart
```

### 场景 B：升级后连配置也变了

如果你改了下面任一项：

- `PANDA_HUB_PORT`
- `PANDA_AGENT_PORT`
- `PANDA_HUB_URL`
- `PANDA_AGENT_DIRECT_BASE_URL`
- `PANDA_AGENT_WS_BASE_URL`
- `PANDA_AGENT_NAME`
- Hub / Agent 的额外启动参数

那么正确顺序是：

1. 先更新环境变量
2. 再重新执行一次 `service install`

例如：

```powershell
$env:PANDA_HUB_PORT='4543'
$env:PANDA_AGENT_PORT='4542'
$env:PANDA_HUB_URL='http://127.0.0.1:4543'
$env:PANDA_AGENT_DIRECT_BASE_URL='http://127.0.0.1:4542'
$env:PANDA_AGENT_WS_BASE_URL='ws://127.0.0.1:4542/ws'

panda hub service install --name=PandaHub tailscareserv
panda agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4543
```

原因很简单：

- 服务定义里保存的是你执行 `service install` 时的参数和环境变量快照
- 后面如果只改系统环境变量，但不重新执行 `service install`，服务仍可能继续沿用旧配置

## 八、开发版管理里的升级行为

如果你是在 Panda 的“开发版管理”里执行：

- 注册/更新服务
- 安装并运行最新正式版

当前行为是：

### 1. 已注册 Windows 服务时

升级流程会优先：

1. 停止正式版 Windows 服务
2. 执行 `npm install -g @jamiexiongr/panda@latest`
3. 再重新启动 Windows 服务

### 2. 未注册 Windows 服务时

会回退到旧逻辑：

1. 按端口停止当前进程
2. 再用普通命令方式重新拉起 Hub / Agent

## 九、推荐的最小可执行流程

如果你想直接照着执行，下面是一套最小流程。

```powershell
npm install -g @jamiexiongr/panda@latest --registry=https://registry.npmjs.org/

$env:PANDA_HUB_PORT='4343'
$env:PANDA_AGENT_PORT='4242'
$env:PANDA_HUB_URL='http://127.0.0.1:4343'
$env:PANDA_AGENT_DIRECT_BASE_URL='http://127.0.0.1:4242'
$env:PANDA_AGENT_WS_BASE_URL='ws://127.0.0.1:4242/ws'

panda hub
panda agent

panda hub service install --name=PandaHub
panda agent service install --name=PandaAgent --hub-url=http://127.0.0.1:4343

panda hub service status
panda agent service status
```

如果你要走 Tailscale Serve：

```powershell
panda hub service install --name=PandaHub tailscareserv
panda agent service install --name=PandaAgent tailscareserv --hub-url=http://127.0.0.1:4343
```

## 十、排查建议

如果服务注册成功但启动不正常，优先检查：

1. 端口是否被占用
2. `PANDA_*` 变量是否正确
3. `service install` 时是否已经把最新参数重新写入
4. Hub 是否先于 Agent 正常启动
5. `panda hub` / `panda agent` 手动运行是否本身就能成功

建议始终先手动跑通，再注册服务。
