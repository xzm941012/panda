# Panda 右下角上下文占用进度圈为空的原因分析

日期：2026-03-22

## 现状原因

Panda 右下角的上下文占用进度圈经常为空，核心原因不是前端圆环绘制失败，而是当前链路只有在拿到 **有效的 `token_count` 事件** 后，才会生成 `session.context_usage`。只要这个对象不存在，前端就直接不渲染进度圈。

当前仓库里的实际判定条件如下：

- `packages/provider-codex/src/index.ts` 的 `parseSessionContextUsage(...)` 只有在 `info.total_token_usage.total_tokens` 和 `info.model_context_window` 都是有效数字时才返回结果，否则返回 `null`。
- `packages/provider-codex/src/live-session-stream.ts` 的实时流处理逻辑也是同样条件。
- `apps/web/src/components/sessions/session-detail-page.tsx` 只有在 `session.context_usage` 存在时才显示右下角进度圈；不存在时不显示占位、不显示“未知状态”，因此从 UI 上看就是“空的”。

结合本机真实 Codex rollout 数据，这个行为是符合 Codex 数据本身特性的：

- `task_started` 往往先出现，此时只知道 `model_context_window`，还不知道已用 token。
- 随后的第一条 `token_count` 经常是 `info: null`。
- 再后面的 `token_count` 才会带上 `total_token_usage` 和 `model_context_window`。

也就是说，**上下文占用通常不是“打开历史会话就必然可见”的静态数据，而是会话开始运行后，由 Codex 逐步补发出来的运行时数据**。

另外，当前 Panda 还有一个语义偏差：它用的是 `total_token_usage.total_tokens`。这能解释“有值时为什么可能比 Codex App 看起来更大或语义不完全一致”，但它不是“为空”的主因。`为空` 的主因仍然是：**当前会话尚未产出有效 `token_count`**。

## 数据来源

### 1. 本地 Codex rollout / archived_sessions 实测

本机抽样统计结果：

- 活跃会话 rollout：`133` 个文件
- 其中包含 `token_count`：`119` 个
- 其中包含有效 `model_context_window` 的 `token_count`：`117` 个
- 归档会话 rollout：`4` 个文件
- 其中包含 `token_count`：`3` 个
- 其中包含有效 `model_context_window` 的 `token_count`：`3` 个

这说明两件事：

- 不是所有会话都会留下可用的上下文占用数据。
- 历史会话**可以恢复**上下文占用，但前提是该 rollout 文件里曾经写入过有效 `token_count`；如果从未写入，Panda 无法凭空恢复。

活跃会话样本序列：

```json
{"timestamp":"2026-02-28T07:00:41.637Z","type":"event_msg","payload":{"type":"task_started","turn_id":"019ca30c-a810-79a3-8e4e-069d3a2c987c","model_context_window":258400,"collaboration_mode_kind":"default"}}
{"timestamp":"2026-02-28T07:00:46.952Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex"}}}
{"timestamp":"2026-02-28T07:00:48.872Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":8381},"last_token_usage":{"total_tokens":8381},"model_context_window":258400},"rate_limits":{"limit_id":"codex"}}}
{"timestamp":"2026-02-28T07:00:48.873Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"019ca30c-a810-79a3-8e4e-069d3a2c987c"}}
```

归档会话样本序列：

```json
{"timestamp":"2026-03-06T06:44:52.362Z","type":"event_msg","payload":{"type":"task_started","turn_id":"019cc1e4-401f-7043-a5ff-d104577f89c8","model_context_window":258400,"collaboration_mode_kind":"default"}}
{"timestamp":"2026-03-06T06:44:53.830Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex"}}}
{"timestamp":"2026-03-06T06:45:02.182Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":12671},"last_token_usage":{"total_tokens":12671},"model_context_window":258400},"rate_limits":{"limit_id":"codex"}}}
```

结论很明确：

- `token_count` 常见，但不是每个会话都有。
- `token_count` 的首条不一定可用。
- 历史会话只有“写进去过”才恢复得出来。

### 2. Panda 当前代码链路

协议层：

- `packages/protocol/src/index.ts`
  - `sessionContextUsageSchema` 定义了 `used_tokens / total_tokens / remaining_tokens / percent_used / updated_at`。
  - session 上的 `context_usage` 允许为 `null`。

Provider 离线/历史解析：

- `packages/provider-codex/src/index.ts`
  - `parseSessionContextUsage(...)` 从 `token_count.payload.info` 中提取数据。
  - 遍历 timeline 时，遇到 `eventType === 'token_count'` 才更新 `contextUsage`。
  - 最后把结果挂到 session 的 `context_usage` 字段上。

Provider 实时流：

- `packages/provider-codex/src/live-session-stream.ts`
  - 实时追踪器同样只在 `token_count` 到来时更新 `tracker.contextUsage`。
  - 推给前端的 live session snapshot 中，`context_usage` 直接来自 `tracker.contextUsage`。

前端展示：

- `apps/web/src/components/sessions/session-detail-page.tsx`
  - `const contextUsage = session.context_usage`
  - 只有 `contextUsage` 存在时才渲染右下角圆环与弹层。

### 3. 参考项目对比

`D:\ai\remodex` 和 `D:\ai\remotecodex` 的做法与 Panda 的方向一致，都是把 `token_count` 作为主数据源，而不是自己推导：

- `D:\ai\remodex\phodex-bridge\src\rollout-watch.js`
  - 通过增量读取 rollout chunk，提取最新可用 `token_count`。
  - 代码里明确写了“Extracts the latest usable context-window numbers from persisted token_count lines.”
- `D:\ai\remotecodex\claudecodeui\server\index.js`
  - 直接从 rollout 末尾反向扫描，取“最新一个带 info 的 `token_count`”。
- `D:\ai\remotecodex\claudecodeui\server\projects.js`
  - 同样只认 `token_count`，拿 `total_token_usage.total_tokens` 和 `model_context_window`。

这说明：**把上下文占用建立在 rollout `token_count` 上，是当前最稳妥、最贴近 Codex 原始数据的路线。**

## 可行方案

最可行方案不是去发明新的“估算占用逻辑”，而是把 Panda 现有链路补成一个更完整的三段式方案。

### 方案 A：保留 `token_count` 作为唯一可信来源

这是基线方案，不建议改。

原因：

- `token_count` 是 Codex 原生给出的上下文使用数据。
- `task_started.model_context_window` 只能告诉我们总窗口大小，不能告诉我们当前已用多少。
- 历史会话是否可恢复，也完全取决于 rollout 里有没有有效 `token_count`。

### 方案 B：把“空”从无提示改成“未知状态”

当前 UI 把 `context_usage = null` 直接渲染成“什么都没有”，用户很容易误判为异常。

建议改为：

- 当会话还没有有效 `token_count` 时，右下角显示一个低强调的“未知/等待中”状态。
- 如果当前 turn 已经 `task_started`，但还没有有效 `token_count`，可以显示灰色空心圈或占位文案，例如“上下文统计待生成”。
- 当拿到第一条有效 `token_count` 后，再切换为正式进度圈。

这样做不会伪造数据，但能把真实状态表达清楚。

### 方案 C：后端统一做“最新可用值恢复”

Panda 现在已经在 timeline 解析过程中顺手提取 `contextUsage`，但建议把这条策略明确固化：

- 历史加载时：
  - 从 rollout 文件里提取“最后一条有效 `token_count`”作为 session 当前上下文占用。
- 实时监听时：
  - 用现有 offset 增量读取逻辑持续覆盖最新值。
- 会话结束后：
  - 保留最后一次已知 `context_usage`，不要因为 turn 结束就清空。

这会保证：

- 有历史数据的会话，重新打开时能恢复。
- 正在运行的会话，能随着 `token_count` 增量推进。
- 已完成但曾有统计的会话，仍然能显示最后一次已知占用。

### 方案 D：把统计口径切到 `last_token_usage` 优先，`total_token_usage` 兜底

这不是为了解决“为空”，而是为了解决“显示值和 Codex App 语义可能不一致”。

建议改法：

- 优先使用 `info.last_token_usage.total_tokens`
- 如果没有 `last_token_usage`，再回退到 `info.total_token_usage.total_tokens`
- `model_context_window` 仍然取 `info.model_context_window`

原因：

- `total_token_usage` 更像整个会话累计量。
- `last_token_usage` 更接近“当前轮/当前上下文负载”。
- `D:\ai\remodex\phodex-bridge\src\rollout-watch.js` 已经明确采用“`last_token_usage` 优先，`total_token_usage` 兜底”的策略。

如果目标是让 Panda 更接近 Codex App 右下角体验，这一步值得做。

### 最终推荐

最可行、收益最高、实现成本也最低的方案是：

1. 保持 rollout `token_count` 为唯一可信数据源。
2. 前端把 `null` 从“完全不显示”改成“未知/待生成”。
3. 后端明确使用“最后一条有效 `token_count`”做历史恢复和实时覆盖。
4. 统计口径改为 `last_token_usage` 优先，`total_token_usage` 兜底。

这个方案有三个优点：

- 不造数据，仍然严格跟随 Codex 原始事件。
- 能解释为什么有些历史会话就是拿不到占用值。
- 能最大程度贴近 Codex App 的实际显示语义。

## 风险

### 1. 某些会话天然没有可恢复数据

如果 rollout 文件从未出现过有效 `token_count`，即使会话已经结束，Panda 也无法恢复上下文占用。这不是 Panda 缺陷，而是源数据缺失。

### 2. `last_token_usage` 与 Codex App 的完全一致性仍需实机对齐

虽然 `last_token_usage` 在语义上更像当前轮上下文负载，但 Codex App 最终显示是否完全等同于它，仍然需要对照更多真实会话验证。

### 3. 首次打开历史会话时仍可能短暂无值

如果 Panda 的 session 列表页拿到的是精简 session 元数据，而详细 rollout 尚未扫描完成，前端可能会短暂处于“未知状态”。这比当前“空白”更合理，但仍需在 UX 上接受。

### 4. 不能用 `task_started.model_context_window` 伪造占用百分比

`task_started` 只有总窗口，没有已用 token。若仅凭它生成百分比，会制造假数据。因此它最多只能作为“总窗口已知、占用未知”的辅助信息，不能直接画真实进度。

## 结论

Panda 右下角上下文占用进度圈常为空，根因是：

- Panda 只在拿到有效 `token_count` 后才生成 `context_usage`。
- Codex 的 `token_count` 本来就常常在会话开始后才出现，且首条可能是 `info: null`。
- 历史会话只有在 rollout 里写入过有效 `token_count` 时才可恢复。

因此，最合理的落地方向不是“另找来源估算 token”，而是：

- 继续以 rollout `token_count` 为准；
- 把前端空白改成“未知/待生成”；
- 后端稳定恢复“最后一条有效 `token_count`”；
- 并将统计口径优化为 `last_token_usage` 优先。
