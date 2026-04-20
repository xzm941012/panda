# 子代理 01

范围：

- `siteboon/claudecodeui`
- `d-kimuson/claude-code-viewer`

## CloudCLI / Claude Code UI

### 架构

- `src/` 中的 React + Vite 前端
- `server/` 中的 Node 后端
- `shared/` 中的共享常量
- 多 provider 适配器文件：
  - `server/claude-sdk.js`
  - `server/openai-codex.js`
  - `server/cursor-cli.js`
  - `server/gemini-cli.js`
- 后端整体形态大体上是经典 Web 应用风格：
  - 路由
  - 服务
  - 中间件
  - 数据库

### 优点

- 在样本集合中拥有最宽的产品面。
- 移动端和桌面端 UI 都是一等公民。
- 覆盖终端、文件、git、会话、项目管理、插件系统。
- 在同一个 UI 中支持 Claude Code、Codex、Cursor CLI、Gemini CLI。
- 自动发现现有会话。

### 缺点

- 后端看起来运维负担较重，并且部分偏单体。
- 像 `server/index.js` 和 `server/projects.js` 这样的大文件，说明维护压力正在增加。
- 产品广度很强，但围绕多机注册表和去中心化部署的清晰度较弱。
- 它更像是“单机上的一个能力很强的 UI”，而不是一个真正的多 agent 机群管理器。

### Panda 应该借鉴什么

- 对移动端响应式友好的信息架构。
- 统一的会话/项目/git/文件/终端界面。
- 插件扩展模型。
- 从第一天开始就采用多 provider 的 framing。

### Panda 应该避免什么

- 巨大的单进程后端文件。
- 在同一层里混合 provider 逻辑、项目逻辑和传输逻辑。

## Claude Code Viewer

### 架构

- 前端应用位于 `src/app`
- 后端位于 `src/server`
- 清晰拆分为：
  - `core`
  - `hono`
  - `terminal`
  - `lib`
- 使用 Hono + 大量 Effect 的设计
- 把 Claude 会话日志当作主要数据源，而不是重新发明一个新的规范存储

### 优点

- 在样本集合中拥有最好的“日志优先”设计。
- 搜索、历史、索引、调度器、浏览器预览、git review 都很强。
- 很擅长通过持久化日志附着到现有会话。
- 对会话生命周期有很强的思考：
  - 启动
  - 恢复
  - 继续，并且不丢失进程身份

### 缺点

- 当前只支持 Claude。
- 单机视角。
- Effect 技术栈带来了严谨性，但也提高了贡献者复杂度。
- 很重的领域分层对于快速 MVP 来说可能过头。

### Panda 应该借鉴什么

- 会话能力拆分：
  - 历史附着
  - 实时附着
  - 受管运行时
- 搜索和索引模型。
- 内建的浏览器预览和 git review 模式。
- 围绕会话/事件解析的严格 schema 校验。

### Panda 应该避免什么

- 在第一个版本里把架构做得过于重框架化。

## 组合结论

这两个项目分别提供了两种不同的启发：

- `claudecodeui` 展示了 UI 产品面应该有多宽。
- `claude-code-viewer` 展示了如何扎根于真实的会话持久化，不丢数据。

对 Panda 来说，正确的动作是：

- 用 `claudecodeui` 借它的广度
- 用 `claude-code-viewer` 借它在会话模型上的纪律性
