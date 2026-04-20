# Panda 研究包

这个文件夹包含 `Panda` 的研究与规划材料。`Panda` 是一个面向移动端优先的 Codex 与 Claude Code 远程控制系统。

这里包含：

- `research/00-project-ranking.md`
  外部项目排名，以及为什么选择这 8 个仓库。
- `research/subagent-01-cloudcli-and-ccv.md`
- `research/subagent-02-webui-and-ccremote.md`
- `research/subagent-03-agentrooms-and-codexia.md`
- `research/subagent-04-remote-agent-and-yepanywhere.md`
- `research/subagent-05-vision-and-remodex.md`
  五条彼此独立的研究线。由于当前这个 Codex 运行时并不暴露真正的 GPT-5.4 子代理启动能力，所以这些内容采用了“子代理报告”的写法。
- `docs/panda-architecture.md`
  Panda 的推荐系统架构。
- `docs/panda-requirements.md`
  产品需求、MVP 范围以及分阶段交付计划。
- `docs/panda-codex-run-state.md`
  Codex 会话运行态、thinking UI、停止按钮和 bootstrap/timeline 一致性的专题文档。
- `docs/npm-release.md`
  Panda 的 npm 发布流程、token 获取方式，以及自动发布命令说明。
- `docs/panda-user-guide.md`
  面向最终用户的安装、运行、扫码和手机端使用说明。

已克隆到 `D:\ai\remotecodex` 的外部仓库：

1. `siteboon/claudecodeui`
2. `JessyTsui/Claude-Code-Remote`
3. `d-kimuson/claude-code-viewer`
4. `sugyan/claude-code-webui`
5. `baryhuang/claude-code-by-agents`
6. `milisp/codexia`
7. `coleam00/remote-agentic-coding-system`
8. `kzahel/yepanywhere`

纳入专门研究的本地仓库：

- `D:\ai\vision`
- `D:\ai\remodex`

选择说明：

- `remodex` 如果按照 star 数和近期活跃度来排，本来会非常靠前，但它被排除在外部 top-8 集合之外，因为它已经有一条专门的本地深度研究线。
- `vision` 也被单独处理，因为它已经位于当前工作区中，并且与计划中的架构直接相关。

## 当前开发启动命令

安装依赖：

```powershell
corepack pnpm install
```

启动第一阶段直连开发环境（Web + Agent）：

```powershell
corepack pnpm dev
```

启动第一阶段完整开发环境（Web + Agent + Hub）：

```powershell
corepack pnpm dev:full
```

单独启动：

```powershell
corepack pnpm dev:web
corepack pnpm dev:agent
corepack pnpm dev:hub
```

## Hub-Agent 启动说明

当前 agent 通过环境变量 `PANDA_HUB_URL` 知道自己要注册到哪个 hub。

也就是说：

- hub 地址不是写死在代码里的
- agent 每次启动时都可以指向不同的 hub
- 最适合变化频繁地址的方式，就是启动时通过 VSCode 输入或外部环境变量传入

### 关键环境变量

Hub：

```powershell
$env:PANDA_HUB_PORT='4343'
$env:PANDA_HUB_API_KEY='your-key'
corepack pnpm dev:hub
```

发布态如果要给 Android Chrome 验证 PWA 安装，可使用：

```powershell
panda hub tailscareserv-pub
```

如果手机不在 Tailscale 里，但你仍希望手机通过 Hub 页面直连 Agent，可使用：

```powershell
panda agent tailscareserv-pub
```

Agent：

```powershell
$env:PANDA_AGENT_PORT='4242'
$env:PANDA_HUB_URL='http://127.0.0.1:4343'
$env:PANDA_HUB_API_KEY='your-key'
corepack pnpm dev:agent
```

Web 连接指定 Hub：

```powershell
$env:VITE_PANDA_HUB_URL='http://127.0.0.1:4343'
corepack pnpm dev:web
```

### VSCode 启动方式

仓库里现在把启动入口放回 VSCode `launch`：

- `Dev: Hub`
- `Dev: Agent -> Hub`
- `Dev: Web -> Hub`
- `Dev: Full Local`

其中 `Dev:*` 会在运行时弹出输入框，让你填：

- Hub URL
- Agent 端口
- Agent 直连 HTTP 地址（可选）
- Agent 直连 WebSocket 地址（可选）

其中 Agent 的两个直连地址如果留空，会继续走 agent 侧的自动推断逻辑；如果你是多网卡、跨机器或需要手动指定注册地址的场景，可以在启动时显式填写。

这样 hub 地址变化时，不需要改代码，只需要重新启动并输入新的地址。

### 推荐用法

本机联调：

1. 最省事的是直接运行 `Dev: Full Local`
2. 如果要单独接远端节点，就分别运行 `Dev: Hub`、`Dev: Agent -> Hub`、`Dev: Web -> Hub`

`tasks` 现在只保留 `Setup: Install`，避免和 `launch` 重复。

远端 hub / 多节点 agent：

1. 在 hub 节点启动 hub
2. 在每个 agent 节点启动 agent，并把 `PANDA_HUB_URL` 指向对应 hub
3. 如果 hub 地址变化，只需要重启 agent 并传入新的 `PANDA_HUB_URL`

### 关于“Hub 地址不固定”

这是正常情况，尤其是：

- hub 跑在某个 agent 节点上
- hub 在不同环境里地址不同
- Tailscale DNS 名称、临时 IP、端口可能变化

因此当前建议是：

- 配置入口统一用 `PANDA_HUB_URL`
- 开发时优先用 VSCode 启动输入
- 部署时由系统服务、启动脚本或 CI/CD 注入环境变量

不要把 hub 地址硬编码进 agent 源码。

校验与构建：

```powershell
corepack pnpm typecheck
corepack pnpm build
```

`corepack pnpm build` 会先读取项目根目录的 `.nvmrc`，再通过 `nvm` 自动切换到指定 Node 版本后执行构建。当前锁定版本是 `20.19.3`。

## npm 发布

Panda 的 npm 发布说明、token 获取入口和自动发布脚本用法见：

- `docs/npm-release.md`

最终用户安装和使用说明见：

- `docs/panda-user-guide.md`
