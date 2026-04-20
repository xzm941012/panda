# 子代理 06 - Remodex

分析时间：

- 2026-03-18

分析范围：

- `D:\ai\remodex\README.md`
- `D:\ai\remodex\phodex-bridge\package.json`
- `D:\ai\remodex\phodex-bridge\src\rollout-live-mirror.js`
- `D:\ai\remodex\phodex-bridge\src\bridge.js`
- `D:\ai\remodex\phodex-bridge\src\git-handler.js`

## 结论

`remodex` 不是 Panda 的整体架构模板，但它是 Panda 第一阶段里最重要的 `Codex 实时镜像` 参考样本。

它最有价值的不是 iOS 外壳，而是这三件事：

- 用一个很轻的本地 bridge 连接 `codex app-server`
- 对桌面端已有会话做 rollout 级别的实时镜像
- 把 git 操作放进远程控制链路，而不是做成独立页面

## Panda 应该借鉴的点

### 1. 外部会话实时镜像路径是成立的

`rollout-live-mirror.js` 明确说明了一条很关键的路线：

- 监听 `~/.codex/sessions` 相关 rollout 文件
- 识别当前活跃 run
- 合成接近 `app-server` 风格的实时事件
- 把这些事件重新推送给远端客户端

这和 Panda 的核心目标高度一致，因为 Panda 不想强制所有会话都通过 wrapper 启动。

对 Panda 的直接启发：

- `CodexAdapter` 必须同时支持 `app-server` 模式和 `rollout scanner` 模式
- 会话能力必须区分 `Managed`、`Attached Live`、`History Only`
- 外部会话的“实时查看”可以先保证，“审批完全接管”不要一开始承诺过头

### 2. bridge 必须足够轻

`phodex-bridge` 本身依赖极少，核心依赖只有：

- `ws`
- `qrcode-terminal`

这证明第一阶段不需要上很重的服务框架，也不需要先做完整中心平台，单机 agent 只要把几个关键职责打穿就有价值。

对 Panda 的直接启发：

- `Panda Agent` 应以轻量守护进程为核心，而不是先做一个大而全平台
- 先用简洁的 HTTP + WebSocket 即可，不需要 Socket.IO、GraphQL、消息队列一起上

### 3. git 应是会话内联能力

`remodex` 远程端直接支持：

- commit
- push / pull
- branch switch

这说明对移动端操作者来说，git 不是“附属页面”，而是会话控制体验的一部分。

对 Panda 的直接启发：

- 会话详情页必须直接展示变更、branch、worktree、diff
- git 更新要和会话事件一起刷新，而不是依赖用户手动点刷新

## Panda 不应照搬的点

### 1. 不要继承它的单机思维

`remodex` 的产品中心是“一台 Mac + 一台 iPhone”的配对关系。

这不适合 Panda，因为 Panda 的目标从第一天就是：

- 多 agent
- 机群管理
- 可选 Hub

### 2. 不要把 iOS 原生作为起点

`remodex` 的 UI 深度来自原生 iOS，但 Panda 第一阶段更适合：

- PWA 优先
- 共享一套 Web 前端
- 后续再用 Capacitor 或原生壳迁移

### 3. 不要把 relay 作为 MVP 前提

`remodex` 有 relay、自托管和配对体系，但 Panda 既然已经确定第一阶段以 Tailscale 为先，就没必要先复制一整套公网 relay。

## 对 Panda 第一阶段的落地建议

从 `remodex` 只拿下面这些“硬价值”：

- `Codex rollout` 监听与实时镜像
- `app-server` 优先、scanner 兜底的双路径模型
- 会话内联的 git 操作
- 远程端对活跃 run 的流式查看与继续追问

不要拿下面这些：

- iOS 原生优先
- 单机配对即中心
- relay 先行

## 最终判断

如果 Panda 第一阶段只能从 `remodex` 借一个最关键能力，那就是：

- `外部 Codex 会话的 rollout 级实时镜像`

这是 Panda 能否真正做到“用户继续照常使用 Codex，而 Panda 自动发现并实时查看”的关键。
