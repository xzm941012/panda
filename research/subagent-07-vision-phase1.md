# 子代理 07 - Vision / HAPI

分析时间：

- 2026-03-18

分析范围：

- `D:\ai\vision\README.md`
- `D:\ai\vision\package.json`
- `D:\ai\vision\hub\package.json`
- `D:\ai\vision\web\package.json`
- `D:\ai\vision\shared\package.json`
- `D:\ai\vision\shared\src\index.ts`

## 结论

`vision` 不是 Panda 第一阶段最适合直接复刻的实现，但它提供了 Panda 非常需要的 `多机控制平面骨架`。

如果说 `remodex` 解决的是 Codex 专用深度，那么 `vision` 解决的是：

- Hub 可选
- Agent / Hub / Web 分层
- 多 provider framing
- 协议共享包

## Panda 应该借鉴的点

### 1. monorepo 分层是对的

`vision` 的工作区拆分很清楚：

- `cli`
- `hub`
- `web`
- `shared`

这说明 Panda 第一阶段也应该从一开始就把下面几层分开：

- `agent`
- `hub`
- `web`
- `protocol`

对 Panda 的直接启发：

- 共享 schema 和事件类型必须独立成包
- Web 不应直接依赖 agent 内部实现
- Hub 应保持可选，而不是架构中心

### 2. Hub 必须是可选增强层

`vision` 的产品强调远程控制、多 provider 和 handoff，这和 Panda 很接近，但它偏 wrapper 启动。

Panda 可以借它的控制平面纪律，而不继承它的产品假设。

对 Panda 的直接启发：

- 没有 Hub 时，客户端可以直连某台 agent
- 有 Hub 时，Hub 负责注册表、聚合索引、通知，不抢占 agent 的核心职责
- 实时流最好默认直连 agent，Hub 做发现和聚合，不做所有流量中转

### 3. 协议共享包必须从第一天存在

`vision/shared` 说明了一件很实际的事：

- 只要有 `agent + hub + web` 三方通信，就必须把协议单独提出来

对 Panda 的直接启发：

- 定义 `AgentSummary`、`SessionSummary`、`SessionCapability`、`GitWorkspaceState`、`PreviewEndpoint`、`TerminalEvent`
- 用 `zod` 做运行时校验
- 所有事件名和 payload 在 `packages/protocol` 内统一定义

## Panda 不应照搬的点

### 1. 不要走 wrapper-first 路线

`vision` 的强项在于“用 HAPI 启动 provider，再远程控制它”，而 Panda 的硬约束恰恰是：

- 用户继续用普通 `codex`
- Panda 自动附着已有会话

所以 Panda 不能把 HAPI 的 wrapper 思维当成主路径。

### 2. 不要把 relay 和 voice 复杂度前置

`vision` 在 relay、Telegram Mini App、voice assistant 上已经走得很远，但这些都不该压到 Panda 第一阶段架构里。

第一阶段只需要：

- Tailscale
- Web PWA
- 基础语音输入

### 3. 不要把 Bun 作为 Panda 的默认后端选择

`vision` 基于 Bun 没问题，但 Panda 第一阶段要重点考虑：

- Windows 兼容
- `node-pty`
- 现成 git / 文件 / 进程生态

在这件事上，Node.js 比 Bun 更稳。

## 对 Panda 第一阶段的落地建议

从 `vision` 只拿这些结构性价值：

- `agent / hub / web / protocol` 的 monorepo 切分
- Hub 可选，不抢主链路
- 多 provider 的 framing，但第一阶段只实现 `CodexAdapter`
- 共享 schema 包

不要拿这些：

- wrapper-first 运行模型
- relay-first 设计
- 过早扩大的 provider 面

## 最终判断

如果 Panda 第一阶段只能从 `vision` 借一个最关键思想，那就是：

- `可选 Hub 的分层控制平面`

它能保证 Panda 一开始就能支持多 agent，但又不会把系统设计成“没有中心就不可用”。
