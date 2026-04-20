# Panda 参考项目调研：context usage / token window / 压缩提示

## 结论总览

- `D:\ai\remodex` 有现成、直接可借鉴的实现，且和 Panda 当前的 Codex 方向高度一致。它已经覆盖了：
  - `token_count` 持久化事件解析
  - `model_context_window` / `last_token_usage` / `total_token_usage` 提取
  - 线程级 context usage 读取与刷新
  - “等待 token usage” 的空状态处理
  - `contextcompaction` 事件识别与提示文案
- `D:\ai\remotecodex` 没有发现可直接复用的 Codex 风格 context window usage ring 实现。它更偏向：
  - Claude 会话的 token usage 聚合
  - cost 计算与展示
  - 统计项包括 `input/output/cache` tokens
- 结论很明确：
  - Panda 如果要做“上下文占用进度圈 / token_count / 自动压缩提示”，主要应参考 `remodex`
  - `remotecodex` 只能作为“usage 数字面板 / 成本统计结构”的旁路参考，不能作为 Codex context window 主方案

## Remodex：是否有现成可借鉴实现

结论：有，而且比较完整。

### 1. 有明确的数据模型

`D:\ai\remodex\CodexMobile\CodexMobile\Models\ContextWindowUsage.swift`

- 定义了 `tokensUsed`、`tokenLimit`
- 直接提供：
  - `tokensRemaining`
  - `fractionUsed`
  - `percentUsed`
  - `percentRemaining`
  - `tokensUsedFormatted`
  - `tokenLimitFormatted`

这说明 Remodex 不是只显示原始 token 数字，而是已经把“usage ring / 百分比 / 文案展示”这一层抽象好了。

### 2. 有 rollout 持久化日志解析逻辑

`D:\ai\remodex\phodex-bridge\src\rollout-watch.js`

已确认它会从 persisted rollout JSONL 中提取 `token_count`：

- 只认 `payload.type === "token_count"`
- 优先读取 `info.last_token_usage`
- 兼容回退到 `info.total_token_usage`
- 读取 `info.model_context_window`
- `tokensUsed` 优先读 `total_tokens`
- 如果没有 `total_tokens`，再回退累加 `input_tokens + output_tokens + reasoning_output_tokens`

这部分对 Panda 最有价值，因为它说明：

- Codex 的上下文占用不是必须依赖前端估算
- 可以直接从 rollout 里的 `token_count` 事件拿到较可信的已用量
- `last_token_usage` 比 `total_token_usage` 更适合做“当前上下文占用”，因为后者更像会话累计量

### 3. 有线程级读取接口，不只是监听流

`D:\ai\remodex\phodex-bridge\src\thread-context-handler.js`

- 暴露 `thread/contextWindow/read`
- 输入 `threadId` / `turnId`
- 返回 `{ threadId, usage, rolloutPath }`

这说明 Remodex 不是单纯靠实时推送，而是同时提供“按线程主动读取最新 usage 快照”的接口。这个模式很适合 Panda：

- 前端右下角 usage ring 可以按当前线程单独读
- 进入历史会话时可立即拉一次
- 流式过程中再用增量事件更新

### 4. 有 UI 层空状态和展示逻辑

`D:\ai\remodex\CodexMobile\CodexMobile\Views\Turn\TurnStatusSheet.swift`

- 有 usage 时显示：
  - `xx% left`
  - `(used / total)`
  - 进度条
- 没有 usage 时显示：
  - `Unavailable`
  - `Waiting for token usage`

这和你现在观察到的 Codex 行为一致：项目刚打开、还没开始跑时，可能没有 usage；开始提问并且 Codex 发出 `token_count` 后才有数据。

### 5. 有测试，说明这不是偶然行为

`D:\ai\remodex\CodexMobile\CodexMobileTests\CodexStatusTests.swift`

已确认测试覆盖：

- `thread/contextWindow/read` 响应解码
- `last_token_usage` 优先于 `total_token_usage`
- `model_context_window` 读取
- 千位格式化展示

这意味着 Remodex 的这套实现不是临时试验，而是作者明确维护的正式能力。

### 6. 有上下文压缩提示链路

`D:\ai\remodex\CodexMobile\CodexMobile\Services\CodexService+History.swift`
`D:\ai\remodex\CodexMobile\CodexMobile\Services\CodexService+Incoming.swift`

已确认存在明确事件类型：

- `contextcompaction`

并且有对应文案：

- 进行中：`Compacting context…`
- 完成后：`Context compacted`

这说明“自动压缩背景信息”在 Remodex 里不是推测出来的，而是走事件类型识别。Panda 后续如果能在 agent 侧拿到同类事件，就应直接做成显式状态，而不是基于 usage 下降去猜。

## Remotecodex：是否有现成可借鉴实现

结论：没有发现可直接复用的 Codex context window 现成实现。

### 1. 有 token usage / cost 聚合，但不是 context window

代表文件：

- `D:\ai\remotecodex\claude-code-viewer\src\server\core\session\functions\aggregateTokenUsageAndCost.ts`
- `D:\ai\remotecodex\claude-code-viewer\src\app\projects\[projectId]\sessions\[sessionId]\components\SessionPageMain.tsx`
- `D:\ai\remotecodex\Claude-Code-Remote\README.md`

它们做的事情主要是：

- 从 Claude assistant message 的 `message.usage` 聚合 token
- 计算成本
- 展示：
  - input tokens
  - output tokens
  - cache creation tokens
  - cache read tokens
  - total USD cost

这套能力更接近“账单统计 / 会话消耗分析”，不是“当前上下文窗口还剩多少”。

### 2. 没发现这些关键能力

没有发现与 Panda 目标强相关的现成实现：

- 没发现 `model_context_window`
- 没发现 `token_count` 持久化事件解析
- 没发现 `last_token_usage` / `total_token_usage` 这类 Codex rollout 字段处理
- 没发现 usage ring / 剩余百分比 UI
- 没发现类似 `contextcompaction` 的上下文压缩提示链路

所以这里要明确说：`remotecodex` 没有现成可直接借给 Panda 的 Codex 上下文占用实现。

### 3. 它能借鉴什么

虽然不能直接拿来做 context window，但仍有两点可参考：

- token usage 数字分解展示方式
  - 把 usage 拆成 input/output/cache 等细项
- 统计模型与 UI 分层
  - 后端先聚合 usage
  - 前端只负责展示 breakdown

如果 Panda 后续除了“上下文占用”还想显示“本轮 token 消耗 / 会话累计 token / 成本估算”，可以参考这部分结构。

## 对 Panda 的可落地建议

### 建议 1：主方案直接按 Remodex 路线做

Panda 应该采用下面这条链路：

1. agent 监听 rollout 增量
2. 只处理 `token_count` 事件
3. 优先取 `info.last_token_usage`
4. 取 `info.model_context_window`
5. 归一成 Panda 自己的线程级 `ContextUsage`
6. 推给前端 usage ring 和详情浮层

建议统一成类似结构：

```ts
type ContextUsage = {
  threadId: string;
  turnId?: string | null;
  tokensUsed: number;
  tokenLimit: number;
  percentUsed: number;
  percentRemaining: number;
  source: "rollout" | "app-server";
  updatedAt: string;
};
```

### 建议 2：前端要接受“有时拿不到 usage”

不要假设会话一打开就有 token 占用数据。

建议 UI 分三态：

- `idle/unavailable`
  - 显示空环或淡灰态
  - 文案类似“等待上下文数据”
- `available`
  - 显示百分比、已用/总量
- `compacting`
  - 显示居中文案：`----正在自动压缩背景信息----`

### 建议 3：压缩提示优先监听显式事件，不要先做猜测逻辑

如果 Panda 的 agent 已经能接到类似 `contextcompaction` 的事件，就直接用事件驱动。

只有在明确拿不到事件时，才考虑弱推断，例如：

- usage 突降
- turn 未结束
- 紧接着继续 reasoning / assistant 输出

但这类推断只能作为兜底，不应做主逻辑。

### 建议 4：右下角 usage ring 不要做成“全会话累计 token”

你要的是“当前上下文窗口占用”，不是“这个会话总共花了多少 token”。

因此：

- 用 `last_token_usage` 做 ring
- `total_token_usage` 如果保留，只适合放到详情面板里作为累计统计
- 不要把 Claude 项目里的 cost 统计逻辑直接混进 Panda 主 UI

### 建议 5：如果后续想扩展，可以分两层

- 第一层：Codex 风格 context window
  - 只关注 `tokensUsed / tokenLimit / percent / compaction`
- 第二层：usage analytics
  - 输入 token
  - 输出 token
  - reasoning token
  - cache token
  - 成本估算

第一层应优先落地，第二层是增强项。

## 最终判断

- `remodex`：有现成可借鉴实现，且可直接指导 Panda 落地
- `remotecodex`：没有现成可直接借鉴的 Codex context window 实现，只能参考 token/cost 统计思路

如果 Panda 现在要做“右下角上下文占用进度圈 + 点击看百分比/已用量 + 自动压缩提示”，最佳路线就是：

- 以 `remodex` 的 `token_count + model_context_window + contextcompaction` 方案为主
- 把 `remotecodex` 限定为“后续统计面板参考”，不要拿它做主链路
