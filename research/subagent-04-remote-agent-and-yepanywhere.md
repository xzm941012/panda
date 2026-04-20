# 子代理 04

范围：

- `coleam00/remote-agentic-coding-system`
- `kzahel/yepanywhere`

## Remote Agentic Coding System

### 架构

- 为以下部分定义了清晰接口：
  - 平台适配器
  - 助手客户端
  - 编排器
  - 命令处理器
- 使用持久化 PostgreSQL 存储
- 支持 Telegram 和 GitHub 适配器
- 支持 Claude Code 和 Codex 客户端

### 优点

- 在样本集合中拥有最好的接口驱动型架构。
- 在以下边界之间有很强的分离：
  - 传输层
  - 编排层
  - provider 客户端
  - 持久化层
- 是多平台控制平面抽象的很好参考。
- 有不错的流式优先设计纪律。

### 缺点

- 以 ChatOps 为先，而不是以可视界面为先。
- 需要外部数据库和部署配套。
- 不太适合移动端 diff/文件/预览工作流。
- 它更像一个自动化机器人平台，而不是一个丰富的远程编码控制台。

### Panda 应该借鉴什么

- `IPlatformAdapter` / `IAssistantClient` 风格的抽象。
- 会话持久化契约。
- 命令路由边界。

### Panda 应该避免什么

- 在第一个可用版本里过早引入数据库。

## Yep Anywhere

### 架构

- 多包工作区：
  - `server`
  - `client`
  - `desktop`
  - `mobile`
  - `relay`
  - `shared`
  - `device-bridge`
- 移动端优先 UI
- 带 E2EE 远程访问能力的 relay
- 仓库中显式提交了一部分 Codex 协议子集
- 以互操作为先：
  - 读取现有 CLI 持久化数据
  - 避免创建一个新的规范数据库

### 优点

- 与 Panda 目标最接近。
- 移动端优先思维最强。
- 同时支持 Claude 和 Codex。
- 对现有会话的互操作是一个重要差异点。
- 包含：
  - push 通知
  - 审批
  - diff
  - 文件上传
  - 语音输入
  - 全局活动视图
  - 远程设备串流
- 同时提供托管 relay 风格路径和 Tailscale/自托管路径。

### 缺点

- 架构雄心很大，因此也更复杂。
- 安全/relay/移动端/桌面端/设备这一整套堆栈提高了实现成本。
- 它本质上仍然主要是单机服务器，而不明显是一个真正的多机器机群管理器。
- 无数据库设计很优雅，但当机群级索引继续增长时，可能会变成限制。

### Panda 应该借鉴什么

- 互操作优先的会话模型。
- 面向移动端优先的 PWA 产品哲学。
- 可选的加密远程访问层。
- 语音/文件上传/push 审批工作流。
- 基于能力处理 provider，而不是假设所有会话都一样。

### Panda 应该避免什么

- 在核心产品发布之前，试图先把整个 relay/移动端/设备串流堆栈都做出来。

## 组合结论

这一对项目定义了 Panda 的架构脊柱：

- `remote-agentic-coding-system` 提供了干净的抽象。
- `yepanywhere` 提供了目标 UX 和互操作模型。

如果 Panda 只借一个仓库的产品哲学，那应该借 `yepanywhere`。
如果 Panda 只借一个仓库的代码组织原则，那应该借 `remote-agentic-coding-system` 里这种面向适配器的分离方式。
