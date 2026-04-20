# Panda 外部 Codex 会话远程监控研究

## 结论摘要

- 对 **Panda 监控“外部发起”会话** 这件事，最合适的基线方案不是直接依赖 `app-server`，而是 **以 `~/.codex/sessions/**/rollout-*.jsonl` 为主数据源做增量 tail**，再把增量解析成统一事件流推给手机端。
- 原因很简单：`app-server` 方案实时性最好，但它更适合 **Panda 自己发起或已知 endpoint 的会话**；对“Codex App / 普通 codex 在 Panda 外部发起”的会话，**rollout 文件是最稳定、最通用、实现风险最低的观测面**。
- 最推荐的落地方式是 **混合架构**：
  - 基线：`rollout jsonl` 文件监听 + 增量读取 + 状态机。
  - 快路径：如果 Panda 恰好掌握某个会话对应的 `app-server` 连接，就额外订阅原生 `ServerNotification`，覆盖/增强状态。
- Panda 侧边栏想显示“转圈 / 绿点”，核心判断规则可以非常简单：
  - `running`: 最近一次终态前，已看到 `task_started` 或 `turn/started`
  - `completed`: 最近一次终态是 `task_complete` 或 `turn/completed(status=completed)`
  - `failed`: 最近一次终态是 `error` / `turn/failed` / `turn/completed(status!=completed)`（仅在拿得到原生事件时可靠）
  - `idle`: 已知线程，但当前无活动 turn

## 明确推荐方案

### 1. 数据来源

- **主数据源**：`CODEX_HOME/sessions/**/rollout-*.jsonl`
  - 默认可按 `~/.codex/sessions` 理解。
  - 对 Panda 的目标场景，这个来源最关键，因为它不要求 Panda 事先接入会话运行时。
- **可选增强源**：Panda 自己启动或已知地址的 `codex app-server` 事件流
  - 只作为增强，不应作为“外部会话监控”的唯一依赖。

### 2. 事件检测方式

- 启动时：
  - 先扫描最近修改的少量 rollout 文件，建立 `threadId -> rolloutPath` 索引。
  - 只在目标线程找不到时才做全量回退扫描。
- 运行时：
  - 用目录级 watcher 监听 `sessions` 树里的新建/变更。
  - 对“热线程”保存 `offset + partialLine`，只读取新增字节。
  - 将 rollout 中的关键事件规范化为 Panda 内部事件：
    - `event_msg.payload.type == task_started` -> `turn_started`
    - `event_msg.payload.type == task_complete` -> `turn_completed`
    - `event_msg.payload.type == user_message` -> `user_message`
    - `event_msg.payload.type == agent_message` -> `assistant_message`
    - `response_item.type == reasoning/function_call/function_call_output` -> thinking / tool / output 增量

### 3. 增量刷新策略

- 不要周期性全盘扫描 `~/.codex/sessions`。
- 推荐策略：
  1. 冷启动时只扫描最近 `N` 个 rollout 文件（例如 24 个）。
  2. 目录 watcher 发现变更后，再精确命中对应文件。
  3. 对活跃线程按文件偏移量 append-read。
  4. 连续一段时间无增长后停止热跟踪，仅保留目录 watcher。
- 手机端只接收 **规范化后的轻量事件**，不要直接流式传整行 raw jsonl。

### 4. 状态机设计

建议 Panda 维护以下线程状态：

| 状态 | 进入条件 | 退出条件 | UI |
| --- | --- | --- | --- |
| `idle` | 线程已发现，但没有活跃 turn | 新的 `task_started` / `turn/started` | 普通态 |
| `running` | 收到 `task_started` / `turn/started` | `task_complete` / `turn/completed` / `error` | 转圈 |
| `completed` | 收到成功终态 | TTL 到期后回落到 `idle`；或下一次 `running` | 绿点 |
| `failed` | 收到失败终态 | TTL 到期后回落到 `idle`；或下一次 `running` | 红点/告警 |
| `stale` | 长时间无增长且无明确终态 | 新增长量或人工刷新 | 弱提示，可选 |

建议再维护 4 个字段：

- `activeTurnId`
- `lastEventAt`
- `lastTerminalAt`
- `lastTerminalResult`

侧边栏判定可直接写成：

- `isRunning = activeTurnId != null`
- `showGreenDot = !isRunning && lastTerminalResult === "completed" && now - lastTerminalAt < 15s`

如果 Panda 只能看到 rollout 而看不到原生失败事件，那么可以把 `task_complete` 视为“本轮已结束且大概率成功”；此时 `failed` 只作为增强态，不作为基础依赖。

## 为什么推荐“rollout 主、app-server 辅”

### 方案 A：只走 app-server

**不推荐作为外部会话基线。**

优点：

- 延迟最低。
- 原生就有 `turn/started`、`turn/completed`、`thread/status/changed`、`item/*delta` 等语义。

问题：

- 对“外部发起”的会话，Panda 往往 **并不知道该接哪个 endpoint**。
- `Codex App` 内部使用的运行时并不天然对 Panda 开放。
- 即使技术上能接，也会引入 endpoint 发现、权限、生命周期绑定等额外复杂度。

### 方案 B：只扫 `~/.codex/sessions`

**推荐作为外部会话基线。**

优点：

- 对 Codex App / CLI / 外部 app-server 写入都通用。
- 低风险，不需要接管运行时。
- 可以稳定做远程流式展示，因为本地只需一个轻量 watcher，手机端只收规范化事件。

代价：

- 实时性略逊于直连运行时。
- 某些失败/中断语义不如原生事件流完整。

### 方案 C：混合方案

**这是 Panda 最适合的最终形态。**

- 外部会话：默认走 rollout 监控。
- Panda 自己启动/接管的会话：直接消费 app-server 事件。
- 两者统一归一到同一套 Panda 事件模型和状态机。

这个组合在“实时性 / 资源占用 / 实现风险 / 手机端稳定流式显示”之间最均衡。

## 关键依据

### 来自 `remodex`

1. `D:\ai\remodex\README.md:318-340`
   - 明确写到 Remodex 底层是 `codex app-server`，同时会话会持久化到 `~/.codex/sessions`。
   - 更关键的是，它明确承认桌面 GUI **不会自动 live reload 外部写入**，只能靠落盘后的刷新/补偿。

2. `D:\ai\remodex\phodex-bridge\src\codex-transport.js:10-24`
   - Remodex 的实时链路是“自己 spawn `codex app-server` 或连接已知 websocket endpoint”。
   - 这证明 `app-server` 适合“自己掌控的运行时”，但不能自动覆盖所有外部会话。

3. `D:\ai\remodex\phodex-bridge\src\rollout-live-mirror.js:18-20`
   - 文件注释直接说明：它会把 **desktop-origin rollout activity** 镜像回实时 bridge 通知。
   - 这其实就是一个很强的证据：**对外部/桌面端发起的会话，Remodex 的补偿办法就是盯 rollout，而不是接桌面 app 的内部实时流。**

4. `D:\ai\remodex\phodex-bridge\src\rollout-live-mirror.js:319-365`
   - 它把 `task_started` 映射为 `turn/started`，把 `task_complete` 映射为 `turn/completed`。
   - 这套映射非常适合 Panda 直接复用。

5. `D:\ai\remodex\phodex-bridge\src\rollout-watch.js:24-185`
   - 这里已经实现了一个低开销 watcher：等待 rollout materialize、记录文件大小、只读新增、空闲超时后停止。

6. `D:\ai\remodex\phodex-bridge\src\rollout-watch.js:394-503`
   - 它不是每次全树扫，而是先取“最近修改的 rollout 候选”，找不到才回退全树。
   - 这是 Panda 在资源占用上最值得借鉴的一点。

### 来自 `remotecodex`

1. `D:\ai\remotecodex\claude-code-viewer\src\server\core\events\services\fileWatcher.ts:50-120`
   - 它用目录 watcher + 100ms debounce 推送 session 变化。
   - 说明“文件变化驱动 UI 更新”这条路在远程会话产品里是可行的。

2. `D:\ai\remotecodex\codexia\src\bindings\ServerNotification.ts:52`
   - 这里列出了 Codex 原生通知：`thread/status/changed`、`turn/started`、`turn/completed`、`item/*delta` 等。
   - 说明如果 Panda 手头有 app-server 事件流，状态判断会更干净。

3. `D:\ai\remotecodex\codexia\src\bindings\v2\ThreadStartParams.ts:10-18`
   - `experimentalRawEvents` / `persistExtendedHistory` 的定义说明：Codex 运行时确实区分“原生实时事件”和“用于恢复历史的持久化历史”。
   - 这也再次支持 Panda 采用“实时流 + 持久化回放”双层模型。

4. `D:\ai\remotecodex\codexia\src\hooks\codex\useCodexEvents.ts:125-143`
   - 它在 UI 层就是靠 `turn/started` 和 `turn/completed` 驱动任务中/任务完成逻辑。

5. `D:\ai\remotecodex\codexia\src\components\codex\ChatInterface.tsx:33-50`
   - `isProcessing` 的推导非常直接：最后一个 turn 级事件是 `turn/started` 就算处理中；`turn/completed` / `error` 就不算。
   - Panda 侧边栏完全可以照这个逻辑做。

## Panda 具体落地建议

### 最小可行实现

1. 本地 agent 监听 `~/.codex/sessions` 根目录。
2. 为每个活跃 rollout 维护：
   - `offset`
   - `partialLine`
   - `threadId`
   - `activeTurnId`
   - `lastEventAt`
   - `lastTerminalResult`
3. 解析关键行后，发给手机端统一事件：
   - `thread_seen`
   - `turn_started`
   - `assistant_delta`
   - `tool_started`
   - `tool_output_delta`
   - `turn_completed`
4. 侧边栏只消费归一化状态，不直接消费 raw rollout。

### 进阶增强

- 如果 Panda 自己启动某个 `codex app-server`，优先消费原生 `ServerNotification`。
- 若同一线程同时拥有 app-server 流和 rollout：
  - `running/failed/completed` 以 app-server 为准
  - rollout 用来补丢包、断线恢复、历史回放

## 特别值得借鉴的实现

- `D:\ai\remodex\phodex-bridge\src\rollout-live-mirror.js`
  - 最值得借鉴。
  - 价值不在“读文件”，而在 **把 rollout 增量重建成 app-server 风格通知**。

- `D:\ai\remodex\phodex-bridge\src\rollout-watch.js`
  - 值得借鉴它的“最近候选优先 + 热文件增量读取 + idle timeout”。

- `D:\ai\remotecodex\claude-code-viewer\src\server\core\events\services\fileWatcher.ts`
  - 值得借鉴它的目录 watcher + debounce，而不是粗暴轮询全目录。

- `D:\ai\remotecodex\codexia\src\components\codex\ChatInterface.tsx`
  - 值得借鉴它极简的“处理中”判断逻辑，适合 Panda 侧边栏。

## 最终建议

Panda 应该采用：

**`rollout jsonl` 作为外部会话监控主链路，`app-server` 作为已知 endpoint 场景下的增强链路。**

这比“只连 app-server”更通用，也比“持续扫整个 `~/.codex/sessions`”更省资源。  
如果目标是让手机端稳定看到流式过程、并可靠显示转圈/绿点，这是当前实现风险最低、综合收益最高的方案。
