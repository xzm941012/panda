# 子代理 03

范围：

- `baryhuang/claude-code-by-agents`
- `milisp/codexia`

## Claude Code by Agents

### 架构

- 源自 `claude-code-webui` 的 fork 血缘
- 拆分为：
  - `backend`
  - `frontend`
  - `electron`
  - `shared`
- 通过 HTTP 暴露远程 agent 端点
- 一个 orchestrator 加多个本地/远程 agent
- `@agent-name` 路由模型

### 优点

- 在样本集合里拥有最明确的多 agent 编排思路。
- 远程 agent 是一等概念，而不仅仅是会话。
- 将工作路由给专业化 agent 的操作者概念很好。
- 通过 UI 进行动态 agent 管理，这一点与 Panda 非常相关。

### 缺点

- 当前 README 说明今天只支持一个 room。
- 仍然强烈偏向 Claude。
- 并不明显是移动端优先。
- 编排模型看起来更像是应用驱动，而不是 provider-neutral。

### Panda 应该借鉴什么

- agent 注册表和 agent 元数据模型。
- 面向多 agent 工作流的 `@mention` 路由概念。
- orchestrator 节点与 worker 节点的区分。

### Panda 应该避免什么

- 把编排过度耦合到某一个 provider 或某一个 room。

## Codexia

### 架构

- `src/` 中的 React 前端
- `src-tauri/src/` 中的 Rust/Tauri 后端
- 桌面后端内部包含一个无头 Axum Web 服务器
- Rust 中已经存在 provider 拆分：
  - `cc/`
  - `codex/`
  - `web_server/`
  - `db/`
  - `commands/`

### 优点

- 在样本集合里拥有最好的 git/worktree 模型。
- 很强的 “AI 工作站” 设计：
  - 项目树
  - 编辑器
  - git
  - 自动化
  - 预览
- 同时支持桌面端 + 无头 API 的思路在战略上很强。
- 是终端、文件系统、git 和调度器 API 的很好参考。

### 缺点

- 产品形态以桌面端为先。
- 更像“agent 工作站”，而不是“多机器远程机群”。
- 对现有会话的附着能力，比互操作优先的工具要弱。
- Tauri 应用不应该成为 Panda 的强制依赖。

### Panda 应该借鉴什么

- Git/worktree 操作。
- 无头后端 API 表面。
- 预览/运行时 API。
- 后端运行时内部的 provider 适配器拆分。

### Panda 应该避免什么

- 让桌面外壳成为整个系统的中心。

## 组合结论

这一对项目定义了 Panda 的管理平面：

- `claude-code-by-agents` 提供了机群/编排思路。
- `codexia` 提供了工作站操作能力思路。

Panda 应该把它们组合起来：

- 从 Agentrooms 借多 agent 注册表
- 从 Codexia 借 git/worktree/terminal/preview 的深度
