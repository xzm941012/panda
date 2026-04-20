# Panda 第一阶段最终架构设计

## 1. 结论先行

第一阶段的 Panda 应该被正式定型为：

- 一个运行在每台开发机上的 `Panda Agent`
- 一个可选的、只做聚合和注册的 `Panda Hub`
- 一个移动端优先的 `Panda Web PWA`
- 一个与 provider 解耦的适配器层，但第一阶段只实现 `CodexAdapter`

技术路线最终建议如下：

- 前端语言：`TypeScript`
- 前端框架：`React 19 + Vite`
- 前端形态：`PWA`
- 后端语言：`TypeScript`
- Agent / Hub 运行时：`Node.js 22 LTS`
- Agent / Hub HTTP 层：`Fastify`
- 实时通信：`原生 WebSocket`
- 本地终端与进程：`node-pty`
- 数据库存储：`SQLite`
- 数据访问：`better-sqlite3 + 手写 SQL migration`
- 共享协议：`zod schema + TypeScript types`
- 包管理与 monorepo：`pnpm workspaces`

这个组合是当前最适合 Panda 第一阶段的平衡点：

- 足够轻
- Windows / macOS / Linux 都能跑
- 对 PTY、git、文件系统、WebSocket 的支持成熟
- 前后端统一 TypeScript，开发速度快
- 后续迁移到原生移动端时，协议和业务层可直接复用

## 2. 为什么不选别的

### 不选 Bun 作为主后端

原因不是 Bun 不好，而是 Panda 第一阶段更看重：

- `node-pty` 的稳定性
- Windows 兼容
- git / 文件监听 / 子进程生态成熟度

这件事上，Node.js 更稳。

### 不选 Rust 作为 Agent 主语言

Rust 很适合做长期高性能守护进程，但 Panda 第一阶段的关键不是极致性能，而是尽快把这些能力一起打穿：

- 会话扫描
- PTY
- git
- 预览
- WebSocket
- 多 agent 注册

如果一开始上 Rust，交付速度会被明显拖慢，尤其是 provider 适配层还在快速试错阶段。

### 不选 Next.js / Electron / Tauri 作为第一阶段前端基础

Panda 第一阶段最重要的是：

- 手机浏览器可直接访问
- 页面安装成 PWA
- 后面可快速包成原生壳

所以第一阶段应先做纯 Web PWA。

桌面壳和原生壳都不是现在的主路径。

## 3. 最终系统拓扑

```text
手机 / 平板 / 桌面浏览器
          |
          | HTTPS / WSS over Tailscale
          v
     Panda Web PWA
          |
          | 读取机群列表、打开会话、发送命令
          |
   ┌──────┴───────────────┐
   |                      |
   v                      v
Panda Hub(可选)       Panda Agent(直连模式)
   |                      |
   | agent 注册           | 本地发现会话 / 管理 git / PTY / preview
   | 聚合索引             |
   | 通知路由             |
   └──────────────┬───────┘
                  |
                  v
            多个 Panda Agent
                  |
                  v
       Codex CLI / Codex App / git / dev server
```

第一阶段的关键原则：

- Hub 不是必须
- 没有 Hub 时，PWA 可以直接连某一台 Agent
- 有 Hub 时，Hub 主要负责注册表、聚合和后续通知，不负责吞掉所有实时流
- 低延迟实时会话流默认应直连 Agent

## 4. 仓库结构最终建议

建议直接按下面的 monorepo 结构开工：

```text
panda/
  apps/
    web/                 # Panda Web PWA
    agent/               # Panda Agent
    hub/                 # Panda Hub，可选但同仓开发
  packages/
    protocol/            # zod schema、事件、DTO、能力模型
    sdk/                 # Web 端访问 agent/hub 的 API 客户端
    provider-codex/      # 第一阶段唯一 provider 适配器
    design-tokens/       # 颜色、字号、spacing、motion token
  docs/
  research/
```

第一阶段不要把包拆得过细。

不要一开始就出现十几个 packages。真正需要从第一天独立出来的只有四类：

- 应用
- 协议
- SDK
- Provider

## 5. 前端最终方案

## 5.1 技术选型

- `React 19`
- `Vite`
- `TypeScript`
- `TanStack Router`
- `TanStack Query`
- `Zustand`
- `Tailwind CSS v4`
- 少量 `Radix UI` 无样式 primitives

### 为什么这样选

`React + Vite` 足够轻，也足够快。

`TanStack Router` 适合多页面、多面板、深链接的远程控制台，不会像纯前端状态机那样很快失控。

`TanStack Query` 用来管理：

- agent 列表
- 项目列表
- 会话列表
- git 状态
- 预览状态

`Zustand` 只用于本地 UI 状态，例如：

- 当前选中的 agent / project / session
- 面板开合
- 草稿 prompt
- 移动端 drawer / sheet 状态

不要在第一阶段引入更重的前端状态框架。

## 5.2 UI 架构

Web 端按下面的信息架构设计：

- `/agents`
- `/agents/:agentId`
- `/agents/:agentId/projects/:projectId`
- `/agents/:agentId/sessions/:sessionId`
- `/settings`

核心布局：

- 左侧为 agent / project / session 导航
- 中间为会话时间线
- 右侧为 git / files / approvals / preview 面板
- 移动端改为底部 tab + 顶部切换 + 可拖拽 sheet

## 5.3 视觉方向

界面基调最终建议：

- 主强调色：暖黄
- 次强调色：橙红
- 大面积底色：偏灰黄和深炭色，而不是纯黑或纯白
- 保持 Codex 桌面端的密度
- 保持 Claude Code 手机端的触控 ergonomics

第一阶段就定义 `design-tokens`：

- `--color-accent-primary`
- `--color-accent-secondary`
- `--color-surface-*`
- `--radius-*`
- `--space-*`
- `--shadow-*`
- `--motion-*`

这样后面无论是继续做 PWA，还是用 Capacitor 包壳，甚至以后重做为原生，都能复用设计语言。

## 6. 后端最终方案

## 6.1 Panda Agent

`Panda Agent` 是第一阶段真正的产品核心。

建议职责固定为：

- 扫描本地项目
- 扫描本地 Codex 会话
- 管理 Panda 受管会话
- 管理 git 状态和操作
- 管理终端和运行脚本
- 检测 preview URL / 端口
- 对外暴露 HTTP / WebSocket API
- 向 Hub 报到

内部模块建议如下：

- `agent-server`
- `session-indexer`
- `provider-codex`
- `managed-session-runner`
- `git-service`
- `terminal-service`
- `runtime-service`
- `preview-service`
- `pairing-auth-service`
- `agent-registry-client`

## 6.2 Panda Hub

`Panda Hub` 第一阶段只做轻量能力，不做重量编排。

职责限定为：

- agent 注册表
- 机群列表聚合
- 会话摘要聚合
- 轻量缓存
- 可选的身份签发

第一阶段 Hub 不做下面这些：

- 强依赖的中心转发
- 公网 relay
- 复杂 RBAC
- 多租户

## 6.3 接口协议

协议最终定为：

- 查询和命令：`HTTP JSON`
- 实时流：`WebSocket`

不要在第一阶段引入：

- GraphQL
- gRPC
- Socket.IO
- 事件消息队列

一个 `WebSocket` 连接复用多个主题即可：

- `agent.events`
- `session.events`
- `git.events`
- `terminal.events`
- `runtime.events`
- `preview.events`

## 7. Provider 抽象最终方案

第一阶段虽然只交付 Codex，但核心模型不能写死为 Codex。

建议 `packages/protocol` 内定义统一接口语义：

```ts
interface ProviderAdapter {
  discoverProjects(): Promise<ProjectRef[]>
  discoverSessions(): Promise<SessionRef[]>
  getSessionCapabilities(sessionId: string): Promise<SessionCapability>
  attachSession(sessionId: string): Promise<AttachedSessionHandle>
  createManagedSession(input: CreateManagedSessionInput): Promise<ManagedSessionHandle>
  sendUserInput(sessionId: string, input: UserInput): Promise<void>
  interruptTurn(sessionId: string): Promise<void>
  approveRequest(sessionId: string, approvalId: string): Promise<void>
  rejectRequest(sessionId: string, approvalId: string): Promise<void>
}
```

## 7.1 CodexAdapter 的三层优先级

第一阶段的 `CodexAdapter` 运行顺序建议固定为：

1. 优先附着现有 `codex app-server`
2. 如果没有则由 Panda 受管启动 `codex app-server`
3. 对普通 CLI / Codex App 会话走 `session scanner + rollout scanner`

这正好对应三类能力：

- `Managed`
- `Attached Live`
- `History Only`

## 7.2 会话能力模型必须独立显示

每个会话都必须携带能力标志：

- `can_stream_live`
- `can_send_input`
- `can_interrupt`
- `can_approve`
- `can_reject`
- `can_show_git`
- `can_show_terminal`

这件事必须进入 UI，不允许系统假装“所有会话都能完整远程控制”。

## 8. 会话发现与实时镜像最终方案

这是第一阶段最关键的设计点。

Panda 不能强制用户用 `panda codex` 启动，所以会话发现必须走“双轨制”。

### 8.1 外部会话

数据源优先级：

- `~/.codex/sessions`
- rollout / JSONL 文件
- 可探测的 `codex app-server` 端点

实现方式：

- `chokidar` 监听目录和文件变化
- agent 定期做 reconcile，避免漏事件
- 为每个 session 保存解析游标、最后 mtime、最后 rollout offset

### 8.2 Panda 受管会话

由 Panda Agent 启动 `codex app-server` 或相关 managed 进程，获得：

- 完整流式输出
- 审批控制
- 中断
- 更稳定的 turn 生命周期事件

### 8.3 统一事件总线

无论事件来自：

- app-server
- rollout scanner
- managed PTY

都要被归一化成内部事件：

- `session.discovered`
- `session.updated`
- `turn.started`
- `turn.delta`
- `turn.completed`
- `approval.requested`
- `approval.resolved`

## 9. Git、Worktree、Terminal、Preview 最终方案

## 9.1 Git

Git 必须是一等能力。

第一阶段 API 直接覆盖：

- status
- staged / unstaged diff
- stage / unstage
- revert file
- revert hunk
- commit
- fetch / pull / push
- branch list / switch / create
- worktree list / create / switch

实现策略：

- 优先直接调用系统 `git`
- 简单状态查询可配合 `simple-git`
- hunk 级操作用 patch 方式实现

不要为了 git 引入重 ORM 或重型后端框架。

## 9.2 Terminal

终端统一使用 `node-pty`。

支持：

- start
- write
- resize
- stop
- reconnect

实时日志通过 `terminal.events` 推送。

## 9.3 Runtime / Preview

每个项目允许保存多条具名命令，例如：

- `dev`
- `test`
- `build`
- `storybook`

Agent 负责：

- 启动进程
- 记录 pid / cwd / env profile
- 推送日志
- 解析日志中的 URL
- 检测绑定端口

预览 URL 最终策略：

- 本地服务继续跑在开发机
- 通过 Tailscale 的地址或 `tailscale serve` 的 HTTPS 地址暴露给手机

## 10. 存储最终方案

数据库只做 Panda 自己的元数据，不做 provider 会话真相源。

## 10.1 Agent 本地 SQLite

建议表：

- `agent_settings`
- `projects`
- `session_index`
- `session_cursors`
- `managed_sessions`
- `runtime_profiles`
- `runtime_processes`
- `preview_endpoints`
- `pairing_tokens`
- `git_snapshots`

这里面最重要的原则是：

- 会话正文优先来自 Codex 自己的持久化
- SQLite 只保存索引、缓存和 Panda 自己的状态

## 10.2 Hub SQLite

建议表：

- `agents`
- `agent_heartbeats`
- `project_cache`
- `session_cache`
- `user_devices`
- `hub_tokens`

第一阶段不要上 PostgreSQL。

SQLite 足够支撑单用户或小团队的机群管理，而且部署最轻。

## 11. 认证与网络最终方案

## 11.1 网络

第一阶段网络策略直接定为：

- 只支持 `Tailscale`
- Agent 和 Hub 默认监听本机
- 对手机访问推荐使用 `tailscale serve` 暴露 HTTPS

这样能同时满足：

- 无公网 IP
- NAT 打洞
- PWA 安装
- 麦克风权限和安全上下文

## 11.2 鉴权

第一阶段不做复杂账号系统。

推荐方案：

- Agent 首次启动生成本地设备密钥
- Web 端通过一次性 pairing code / QR 完成绑定
- 绑定后签发短期 access token 和长期 refresh token
- 如果使用 Hub，则 Hub 负责签发和校验；直连模式则由 Agent 自己签发

这样足够轻，也比单纯裸露在 tailnet 内更稳。

## 12. 移动端优先与原生迁移最终方案

第一阶段不要直接写 Android / iOS 原生。

最优路线是：

- 先交付高质量 PWA
- 第二阶段如需要，再用 `Capacitor` 进行原生壳封装

这样做的原因：

- 迁移成本最低
- 不需要重写 React UI
- 可以逐步补齐 push、文件选择、系统分享等原生能力

为了让这条路成立，第一阶段必须遵守两条约束：

- 所有 API 访问逻辑都放在 `packages/sdk`
- 语音、通知、文件上传都做成 adapter，不要把 DOM API 写死在业务层

## 13. 第一阶段开发顺序

正式开工建议按下面顺序执行。

### 第 1 步

搭 monorepo 骨架：

- `apps/web`
- `apps/agent`
- `apps/hub`
- `packages/protocol`
- `packages/sdk`
- `packages/provider-codex`

### 第 2 步

完成 `packages/protocol`：

- DTO
- 事件名
- 会话能力模型
- zod schema

### 第 3 步

完成 `Panda Agent` 最小闭环：

- health
- agent metadata
- 项目扫描
- session 扫描
- WebSocket 推送

### 第 4 步

先打通 `CodexAdapter` 的外部会话发现和实时镜像：

- 目录扫描
- rollout 监听
- session list
- live tail

### 第 5 步

再打通受管会话：

- 新建 session
- 发 prompt
- 收流
- 中断
- 审批

### 第 6 步

接入 git / terminal / runtime / preview。

### 第 7 步

最后再补最小 Hub：

- agent 注册
- agent 列表
- 机群会话汇总

## 14. 明确延后到第二阶段的内容

下面这些不进入第一阶段：

- Claude Code 完整支持
- 公网 relay
- 推送通知完整链路
- 多用户 RBAC
- 原生 Android / iOS
- 多 agent 编排自动化

## 15. 最终拍板

第一阶段最终架构就按下面这套执行：

- `Node.js 22 + TypeScript + Fastify + WebSocket + SQLite`
- `React 19 + Vite + PWA`
- `pnpm monorepo`
- `Tailscale only`
- `Hub optional`
- `Codex first`
- `session interop first`
- `git / terminal / preview as first-class features`

这套方案最大的优点是：

- 足够轻，不臃肿
- 真正贴合你的核心诉求
- 可以正式开始开发

如果后面要扩到 Claude Code、推送通知、原生移动端，这个底座也不用推翻，只需要继续往上加。
