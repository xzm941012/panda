# Panda 架构

## 1. 产品定位

Panda 是一个面向移动端优先的本地 AI 编码代理远程控制系统。

主要目标：

- 先支持 Codex

规划目标：

- 下一步支持 Claude Code

关键约束：

- 用户必须能够继续使用普通的 `codex`、Codex App，以及未来普通的 `claude` 工作流。
- Panda 应当在可能的情况下自动附着。
- Panda 不应要求每个会话都必须通过一个特殊的包装命令来启动。

## 2. 设计原则

1. 以 Tailscale 为优先的网络方案。
2. 面向操作者体验的移动端优先 UX。
3. 与 provider 无关的核心层。
4. 先做好现有会话互操作，再考虑复杂编排。
5. Hub 可选，而不是强制存在。
6. 基于能力的会话控制，而不是伪装成统一能力。

## 3. 推荐拓扑

```text
┌────────────────────────────────────────────────────────────┐
│                        Panda Client                        │
│            运行在手机 / 平板 / 桌面浏览器上的 PWA          │
└──────────────────────────────┬─────────────────────────────┘
                               │
                    通过 Tailscale 直连或经由 Panda Hub
                               │
        ┌──────────────────────┴──────────────────────┐
        │                                             │
        ▼                                             ▼
┌──────────────────────┐                    ┌──────────────────────┐
│      Panda Hub       │                    │     Panda Agent      │
│ 可选的管理节点       │                    │ 每台机器一个         │
│ agent 注册表         │                    │ provider 适配器      │
│ 机群会话索引         │                    │ 会话扫描器           │
│ 通知                 │                    │ PTY / git / 预览     │
│ 搜索缓存             │                    │ 实时事件总线         │
└──────────┬───────────┘                    └──────────┬───────────┘
           │                                           │
           │                               ┌───────────┴───────────┐
           │                               │                       │
           ▼                               ▼                       ▼
      多个 Panda Agent               Codex 适配器             Claude 适配器
                                     外部附着                 外部附着
                                     受管启动                 受管启动
```

## 4. 主要运行时组件

## 4.1 Panda Agent

在每一台开发机器上运行一个 `Panda Agent`。

职责：

- 发现本地项目
- 发现本地会话
- 附着到已有的 provider 运行时
- 在收到请求时生成受管会话
- 流式传输终端和 agent 事件
- 暴露 git 和预览 API
- 将自己宣告给 Panda Hub，或直接宣告给客户端

建议的内部模块：

- `agent-core`
- `provider-adapters`
- `session-scanner`
- `runtime-manager`
- `git-service`
- `terminal-service`
- `preview-service`
- `notification-service`
- `voice-service`
- `tailscale-service`

## 4.2 Panda Hub

Hub 是可选的。

使用场景：

- 多台机器
- 一个移动端客户端控制多个 agent
- 跨 agent 搜索
- 推送通知
- 机群总览

职责：

- agent 注册表
- 认证和用户身份
- 聚合会话列表
- 轻量级持久索引
- 事件扇出
- 通知路由

如果不存在 Hub：

- 移动端客户端可以通过 Tailscale 直接连接到某一个 Panda Agent

## 4.3 Panda Client

PWA 优先。

视觉方向：

- Codex 桌面应用的界面密度
- Claude Code 的移动端人体工学
- 以白色为基础的配色系统

主要界面：

- 机群仪表盘
- agent 详情
- 项目列表
- 会话列表
- 会话时间线
- git 面板
- 终端面板
- 预览面板
- 设置 / provider 健康状态

## 5. Provider 抽象层

不要在系统核心中把 “只支持 Codex” 写死。

定义类似下面这样的 provider 契约：

```text
ProviderAdapter
  discoverProjects()
  discoverSessions()
  classifySessionCapabilities()
  attachSession()
  createManagedSession()
  sendUserInput()
  interruptTurn()
  approveRequest()
  rejectRequest()
  watchFiles()
```

Provider 实现：

- `CodexAdapter`
- `ClaudeAdapter`

每个适配器都应支持三种模式。

### 5.1 Managed Session

由 Panda 启动。

能力：

- 完整流式输出
- 审批
- 中断
- 追问提示
- git 集成
- 预览集成

### 5.2 Attached Live Session

在 Panda 外部启动，但 Panda 可以进行足够实时的附着来镜像活动。

能力：

- 实时读取
- 部分追问
- 部分中断
- 审批控制取决于 provider 的传输能力

### 5.3 Attached History Session

在 Panda 外部启动，并且只拿得到历史记录/日志。

能力：

- 只读历史
- 打开项目
- 检查 diff/文件
- 基于这个上下文创建一个新的分支会话

这个能力模型至关重要。

它可以防止系统对用户“假装有能力”。

## 6. 以 Codex 为先的技术方案

## 6.1 Codex 传输顺序

Panda 应按以下顺序尝试 Codex：

1. 如果可用，优先使用已有的 `codex app-server` 端点
2. 使用由 Panda 受管启动的 `codex app-server`
3. 对现有 Codex CLI 或 Codex App 会话使用 session/rollout 扫描器

## 6.2 Codex 附着策略

借鉴 Remodex 和 Yep Anywhere：

- 监听 `~/.codex/sessions`
- 监听 rollout 文件
- 从 rollout 更新中合成实时事件
- 将会话分类为：
  - managed
  - live-mirrored
  - history-only

为了保证 MVP 的诚实性：

- 外部创建的 Codex App 会话至少应当保证提供 “live view”
- 除非存在经过验证的传输路径，否则这些会话上的 “approval control” 应标记为实验性能力

## 7. Claude Code 的规划策略

即使第一阶段还不交付，也应该现在就把 Claude 支持设计进去。

建议方案：

- 扫描 `~/.claude/projects` 及相关会话持久化数据
- 在可能的情况下使用官方 hooks，将更丰富的事件发射到 Panda Agent
- 支持受管启动，以获得完整控制
- 在日志/hooks 允许的情况下支持 attached-history 和 attached-live 模式

重要：

- 优先使用 hooks，而不是 wrappers
- 为用户保留普通的 `claude` 调用方式，不要破坏

## 8. 以 Tailscale 为优先的网络模型

Tailscale 应当成为 Panda 默认的远程访问路径。

原因：

- 不需要公网 IP
- 不需要自己做 NAT 打洞工作
- 对个人/团队开发网络已经足够好用
- 私网地址稳定
- 是移动端访问 Web 预览最简单的路径

推荐模型：

- 每个 Panda Agent 同时绑定 localhost 和 tailnet 接口
- 移动端客户端加入同一个 tailnet
- 如果启用 Panda Hub，它也部署在 tailnet 中

后续可选：

- 为拒绝使用 Tailscale 的用户提供 relay 模式

但这不是 MVP 的必需项。

## 9. 事件模型

使用一个与 provider 无关的内部事件总线。

核心事件：

- `agent.online`
- `agent.offline`
- `project.discovered`
- `session.discovered`
- `session.updated`
- `turn.started`
- `turn.delta`
- `turn.completed`
- `approval.requested`
- `approval.resolved`
- `git.changed`
- `terminal.chunk`
- `preview.detected`
- `notification.raised`

实时分发：

- Agent 本地总线
- 面向交互式客户端使用 WebSocket
- 对被动仪表盘使用 SSE 也可以接受

## 10. 数据模型

建议的核心实体：

- `AgentNode`
- `ProviderKind`
- `ProjectRef`
- `SessionRef`
- `SessionCapability`
- `TurnRef`
- `ApprovalRequest`
- `GitWorkspaceState`
- `PreviewEndpoint`
- `TerminalSession`

建议的会话能力标志：

- `can_stream_live`
- `can_send_input`
- `can_interrupt`
- `can_approve`
- `can_reject`
- `can_show_git`
- `can_show_terminal`

## 11. Git 与工作区层

Panda 必须把 git 视为一等操控面板，而不是事后补上的功能。

必需操作：

- status
- unstaged/staged diff
- revert file/hunk
- stage/unstage
- commit
- fetch/pull/push
- branch switch
- create worktree
- switch worktree

主要参考：

- Codexia
- Remodex
- Claude Code Viewer

## 12. 预览与运行时层

Panda 应为每台机器都包含一个通用运行时管理器。

职责：

- 按项目保存具名的运行/调试命令
- 启动后台进程
- 流式传输日志
- 检测绑定的本地端口
- 提供预览 URL
- 在需要时把预览 URL 重写成可通过 Tailscale 访问的地址

这个特性是移动端远程开发的核心组成部分。

## 13. 语音层

语音应被构建为输入适配器，而不是硬编码在会话 UI 中。

MVP：

- 在受支持设备上使用浏览器语音转文本
- 转换为会话输入

后续：

- 本地 Whisper 风格转写选项

## 14. Panda 首先应该构建什么

第一阶段的架构重点：

- Panda Agent
- Codex 适配器
- 仅支持 Tailscale 的访问
- 可选的轻量 Panda Hub
- 移动端 PWA
- 会话发现
- 对现有 Codex 会话的实时镜像
- 对 Panda 受管 Codex 会话的完整控制
- git 面板
- 终端 + 预览

其他一切都可以往后放。

## 15. 最大风险

### 风险 1

外部会话未必都支持完整的审批接管。

缓解方式：

- 能力标志
- 清晰的 UI 标注
- 用受管会话保证可控性

### 风险 2

试图一次性同时交付 relay、移动端原生应用和多 provider 支持。

缓解方式：

- 以 Tailscale 为先的 MVP
- 以 Codex 为先的 MVP
- 先 PWA，原生稍后

### 风险 3

过早地过度中心化。

缓解方式：

- 让 Hub 保持可选
- 让 agent 单独运行时依然有价值

## 16. 最终架构建议

将 Panda 构建为：

- 每台机器一个 `Panda Agent`
- 外加一个可选的 `Panda Hub`
- 再加一个面向移动端优先的 PWA
- 配合与 provider 无关的适配器层
- 并为附着会话与受管会话建立严格的能力模型

这是仍然能满足真实产品目标的最短路径。
