# 子代理 05

范围：

- `D:\ai\vision`
- `D:\ai\remodex`

## Vision / HAPI

### 架构

- Bun 工作区
- `cli/` 作为 provider 外层 wrapper
- `hub/` 作为中心控制平面
- `web/` 作为 PWA 客户端
- `shared/` 用于协议/类型
- `runner/` 用于远程生成的模型
- CLI 和 hub 之间使用 Socket.IO
- hub 和 web 之间使用 SSE
- 使用 SQLite 持久化

### 优点

- 最好的多机器、多 provider 控制平面基础。
- hub/runner 拆分很强。
- 移动端 Web 交付路径很好。
- 适合管理节点部署。
- 已经解决了：
  - agent 注册
  - 会话持久化
  - PWA/Telegram 控制
  - 远程生成

### 缺点

- 对现有外部会话的附着能力较弱。
- 比起互操作优先，更偏向 wrapper 优先。
- 与那些产品特化工具相比，provider-specific UX 深度较浅。
- 把 Codex 实时附着到外部会话上，仍然是一个难点。

### Panda 应该借鉴什么

- 可选的中心 Hub。
- machine/runner 注册表
- SSE + 实时状态扇出
- 多 provider 外壳

## Remodex

### 架构

- iOS 应用
- 本地 bridge
- relay
- Codex app-server 传输
- 安全配对与可信重连
- 面向桌面端发起运行的 rollout 实时镜像

### 优点

- 最好的 Codex 专用移动端 UX。
- 证明外部会话的实时镜像在一定程度上可以被解决。
- 安全配对这条线很强。
- 对活动运行进行转向控制的思路非常好。
- git 操作被内建到了移动端控制界面中。

### 缺点

- 只支持 Codex。
- 单机 bridge 模式。
- iOS 专用；不是 PWA 优先。
- 不是一个机群管理器。

### Panda 应该借鉴什么

- rollout-live-mirror 模式
- 配对后的安全重连概念
- 移动端审批与运行转向细节
- git 操作的人体工学

## 组合结论

`vision` 和 `remodex` 几乎是完美互补的：

- `vision` 更擅长广度和机群管理。
- `remodex` 更擅长 Codex 专用的移动端深度。

Panda 实际上应该是：

- HAPI 的机器与会话控制平面纪律
- 再加上 Remodex 的 Codex 实时镜像与移动交互质量
- 再加上一个更强的 provider 抽象层，让 Claude Code 可以在后面加入
