# Panda 监控并跳入 Codex App 子代理会话可行性研究

## 是否可行

结论：可行，而且不是只能做“伪 UI”。Codex App 创建的 background agent / subagent 在本机会落成真实的独立会话线程，Panda 只要补齐会话元数据解析与父子关系索引，就可以做到：

- 在主会话输入框上方显示 `x background agents`
- 点击展开子代理列表，显示昵称、角色、运行状态
- 点击某个子代理后跳入其独立会话页面，查看实时流式内容
- 在子代理会话内显示“退出/返回主会话”入口，再回到主会话

这条链路最适合采用“`rollout/session_meta` 为主，`app-server` 为辅”的方案。也就是：

- 子会话发现与父子关系建立，优先依赖本地 rollout 第一行 `session_meta`
- 子会话实时内容，继续复用 Panda 已有的 rollout watcher + app-server 增强链路

## 证据

### 1. 本机真实 Codex 数据里，子代理会话会生成独立线程

在本机 `C:\Users\82462\.codex\state_5.sqlite` 的 `threads` 表里，已经存在明确的子代理线程记录。实测样例：

- 主线程 id：`019cffd9-905e-7392-a322-83b02816c936`
- 子线程 id：`019cffdf-787e-7bd2-82a9-c582944409e2`
- `source` 字段内容：

```json
{"subagent":{"thread_spawn":{"parent_thread_id":"019cffd9-905e-7392-a322-83b02816c936","depth":1,"agent_nickname":"Halley","agent_role":"explorer"}}}
```

这说明：

- 子代理不是主会话里的普通消息块，而是独立线程
- 线程级别就带有 `parent_thread_id`
- 还带有 `depth`、`agent_nickname`、`agent_role`

### 2. 子代理自己的 rollout 第一行也带完整父子信息

真实子代理 rollout：

- `C:\Users\82462\.codex\sessions\2026\03\18\rollout-2026-03-18T15-36-01-019cffdf-787e-7bd2-82a9-c582944409e2.jsonl`

第一行 `session_meta` 中直接包含：

- `id`
- `forked_from_id`
- `source.subagent.thread_spawn.parent_thread_id`
- `source.subagent.thread_spawn.depth`
- `agent_nickname`
- `agent_role`

这比只看 sqlite 更好，因为 Panda 当前本来就以 rollout 为主要数据源。也就是说，Panda 不必先依赖 sqlite，就能在现有架构上建立子会话关系。

### 3. 主会话里还能看到 spawn_agent 的即时结果

真实主会话 rollout：

- `C:\Users\82462\.codex\sessions\2026\03\18\rollout-2026-03-18T15-29-34-019cffd9-905e-7392-a322-83b02816c936.jsonl`

其中存在：

- `spawn_agent` function call
- function output：

```json
{"agent_id":"019cffdf-787e-7bd2-82a9-c582944409e2","nickname":"Halley"}
```

这说明主会话在运行时就能拿到子代理 id 和昵称，因此 Panda 甚至可以在子会话完整 hydration 之前，就先把“background agents”条目挂到主会话上，做到更像 Codex App 的即时反馈。

### 4. 参考项目给出了方向，但不能原样照搬

对 `D:\ai\remotecodex` 的参考结果：

- `yepanywhere` 的协议代码里已经出现 `SessionSource = ... | { subAgent: ... }`
- 还出现了 `thread_spawn.parent_thread_id` 的类型定义
- 订阅层有把 `agentId + isSidechain` 识别为 subagent message 的逻辑

但同仓库另一个 `codex-reader.ts` 里仍写着 “Codex doesn't have subagent sessions like Claude”，说明这部分支持并不完全统一，属于“协议层已经看到了信号，但读取层未必全部跟上”。

因此，对 Panda 来说最稳的路线不是照搬引用项目，而是基于本机已验证的真实 Codex 数据格式直接实现。

## Panda 当前情况

Panda 现在还不能显示或跳入子代理，核心不是 UI 不够，而是元数据没有读出来。

当前 `packages/provider-codex/src/index.ts` 的 `readRolloutRecord()` 只从 rollout 第一行读取：

- `payload.id`
- `payload.cwd`
- `payload.timestamp`

然后生成当前的 `SessionRef`。它没有继续暴露：

- `forked_from_id`
- `source.subagent.thread_spawn.parent_thread_id`
- `source.subagent.thread_spawn.depth`
- `agent_nickname`
- `agent_role`

所以 Panda 虽然已经能监控独立 session 的 timeline，但还不知道“哪个 session 是哪个主会话的 background agent”。

## 推荐方案

### 方案总览

推荐做法：

1. 以 rollout `session_meta` 为父子关系主数据源
2. 用主会话里的 `spawn_agent` 输出做“即时增强”
3. 继续复用现有 Panda 的 `discoverLocalCodexData`、`createCodexLiveSessionStream`、前端会话页路由和 timeline 渲染
4. `app-server` 不负责“发现子代理关系”，只负责在用户打开某个子会话后增强其实时性

### 具体实现建议

#### A. 先扩会话元数据模型

建议在 Panda 会话模型中新增这些可选字段：

- `parent_session_id?: string | null`
- `forked_from_session_id?: string | null`
- `is_background_agent?: boolean`
- `background_agent_depth?: number | null`
- `background_agent_name?: string | null`
- `background_agent_role?: string | null`
- `session_source?: string | null`

其中：

- `parent_session_id` 优先取 `source.subagent.thread_spawn.parent_thread_id`
- `forked_from_session_id` 取 `forked_from_id`
- `is_background_agent` 由 `source.subagent` 是否存在决定

#### B. 在 provider 层建立父子关系索引

在 `discoverLocalCodexData()` 里：

- 扫描 rollout 第一行时解析 `session_meta.source`
- 若发现 `subagent.thread_spawn.parent_thread_id`，则给该 session 打上子代理标记
- 同时建立 `parent_session_id -> child_session_ids[]` 的内存索引

这样第一次打开 Panda 时，就能把历史上已经存在的 background agent 都挂到对应主会话上。

#### C. 在 live watcher 里增量补关系

在 `createCodexLiveSessionStream()` 里：

- 新发现 rollout 文件时，第一时间读取首行 `session_meta`
- 如果是子代理会话，立即广播一次关系更新
- 主会话里如果出现 `spawn_agent` 输出，也可以先把 `{ childSessionId, nickname }` 暂存到父会话的“待确认子代理列表”

推荐关系优先级：

- 以子会话自己的 `session_meta.source.subagent.thread_spawn` 为最终真相
- 以父会话 `spawn_agent` 输出为更快的预告信号

#### D. 前端 UI 的最小可落地形态

主会话页：

- 在输入框上方新增一条 `background agents` 信息条
- 文案示例：`2 background agents`
- 点击后展开列表，列表项显示：
  - 昵称，如 `Mill`
  - 角色，如 `explorer`
  - 当前状态，如 `is awaiting instruction / running / completed`
  - 右侧 `Open`

点击 `Open`：

- 直接路由到该子会话详情页
- 不需要新造“嵌套消息视图”，继续用 Panda 当前会话详情页即可

进入子会话后：

- 输入框上方不再显示子代理列表
- 改为显示“退出/返回主会话”入口
- 点击后回到 `parent_session_id` 对应的主会话

#### E. 实时性与资源占用建议

最轻量的方案不是把所有子代理都常驻订阅，而是：

- 会话列表层只监听 session 级 patch 和 run_state
- 只有用户点开某个子代理会话时，才订阅它的 timeline delta / changeset delta
- 关闭子会话页面后取消该 session 的细粒度订阅

这样既能做到“主会话看到 background agents 状态变化”，又不会让 agent 端同时为大量子线程做高频 timeline 广播。

## 对 5 个问题的直接回答

### 1. Codex app 创建 subagent 后，本地数据里是否会产生独立可监听实体？

会。

已经确认至少会产生：

- 独立 thread 记录（`state_5.sqlite` 的 `threads` 表）
- 独立 rollout 文件（独立 `rollout-*.jsonl`）
- 独立 `session_meta`

所以 Panda 可以把它当成普通 session 去监听 timeline，只是需要额外识别它是“某个主会话的子代理”。

### 2. 主会话与子会话之间是否有可用于建立关联的字段或信号？

有，且证据很强：

- 子会话 `session_meta.forked_from_id`
- 子会话 `session_meta.source.subagent.thread_spawn.parent_thread_id`
- 子会话 `session_meta.agent_nickname`
- 子会话 `session_meta.agent_role`
- 主会话 `spawn_agent` 输出里的 `agent_id` 和 `nickname`

当前没有证据表明必须依赖 app-server 才能做关系建立。app-server 可以做增强，但不是关系发现的前提。

### 3. Panda 是否可以像 Codex app 一样展示 background agents 列表并跳入子会话？

可以。

因为子代理本身就是独立 session，而 Panda 已经具备：

- session 列表
- session timeline 实时流
- session 路由切换

差的只是：

- 父子关系元数据
- 主会话顶部的 background agents UI
- 子会话页的返回主会话入口

### 4. 最优实现方案是什么？

最优方案是：

- `session_meta.source.subagent.thread_spawn` 做主关系源
- 父会话 `spawn_agent` 输出做即时增强
- 子会话 timeline 继续走现有 rollout watcher + app-server 增强链路
- 前端只在需要时订阅子会话详情流，避免常驻高频监听

这是目前实时性、资源占用、改动面三者平衡最好的方案。

### 5. 参考项目能直接复用吗？

不能直接照搬，但能提供思路。

最有参考价值的是 `D:\ai\remotecodex\yepanywhere`，它说明了：

- 新版协议里确实开始显式表达 subagent/source 概念
- 前端可以把 subagent 当独立 session 或 sidechain 去组织

但 Panda 更适合直接基于本机真实 Codex rollout/session_meta 格式实现，因为这比参考项目的抽象层更贴近当前环境，也更稳。

## 风险与未知项

### 已知风险

- 不同 Codex 版本里，`source` 字段可能是字符串、对象，或只出现在 sqlite 不出现在某些旧 rollout，需要写宽松解析器。
- 父会话 `spawn_agent` 输出不一定在所有版本/所有流程都稳定存在，因此不能把它当唯一关系源。
- 已归档/被移除的子会话如何在主会话顶部展示，需要和 Panda 现有 archived 规则统一。

### 未知项

- 还没有验证当前 Codex App 的 app-server 是否会直接推送“background agents 列表变化”这类高层事件。
- 还没有验证一个主会话在极短时间内连续创建多个子代理时，主会话输出与子会话 `session_meta` 的先后顺序是否稳定。

### 应对建议

- 第一版不要等 app-server 高层信号，先靠 rollout/session_meta 落地。
- 关系解析写成“多信号合并”：
  - 子会话 `session_meta` 为最终真相
  - 父会话 `spawn_agent` 输出为提前显示
  - sqlite `threads.source` 作为冷启动补偿

## 最终建议

建议直接继续实现，不需要再做一轮大范围预研。

优先开发顺序：

1. 扩 `protocol` / `provider-codex` 的会话元数据
2. 在 `discoverLocalCodexData()` 建 parent-child 索引
3. 在 live stream 中增量发现子会话
4. 前端主会话输入框上方加 `background agents` 条
5. 子会话页加“返回主会话”

如果按这个顺序做，Panda 完全有机会做到和 Codex App 很接近的 background agents 体验。
