# 外部项目排名

选择规则：

- 必须与 Codex 或 Claude Code 的远程控制明确相关。
- 必须有近期维护活动。
- 在相关仓库中按 GitHub star 数优先排序。
- `vision` 和 `remodex` 被排除在这个外部列表之外，因为它们已经被放进专门的本地研究线中。

快照日期：

- 2026-03-17

## 选出的 Top 8

| 排名 | 仓库 | Stars | 最近一次 push（UTC） | 选择原因 |
| --- | --- | ---: | --- | --- |
| 1 | `siteboon/claudecodeui` | 8547 | 2026-03-17 10:11 | 在移动端/Web 多 CLI UI 里吸引力最高。产品面很强。 |
| 2 | `JessyTsui/Claude-Code-Remote` | 1166 | 2025-12-06 08:54 | 远程通知与消息控制模型很强。 |
| 3 | `d-kimuson/claude-code-viewer` | 972 | 2026-03-03 08:18 | 基于会话日志驱动的 Web 客户端很强，并且包含 git/preview/scheduler。 |
| 4 | `sugyan/claude-code-webui` | 964 | 2025-11-03 04:49 | 干净、轻量的 Claude Web UI，并且移动端处理很强。 |
| 5 | `baryhuang/claude-code-by-agents` | 807 | 2026-01-01 06:54 | 与多 agent 远程编排最相关的变体。 |
| 6 | `milisp/codexia` | 491 | 2026-03-09 11:40 | 最好的工作站级 git/worktree/headless API 参考。 |
| 7 | `coleam00/remote-agentic-coding-system` | 339 | 2025-11-29 16:00 | 最好的 adapter 驱动型 ChatOps 编排设计。 |
| 8 | `kzahel/yepanywhere` | 210 | 2026-03-16 18:31 | 与目标产品形态最接近：移动端优先、E2EE、互操作、无数据库。 |

## 本地专门研究线

下面这些项目被单独研究，因为它们已经位于本地工作区中，而且重要性过高，不能像普通外部样本那样处理：

- `xzm941012/vision`
- `Emanuele-web04/remodex`

## 有价值的备选项

这些项目没有进入最终 top-8 集合，但后续仍然值得借鉴其中的思路：

- `MobileCLI/mobilecli`
  很好的 Tailscale/LAN 风格手机直连终端思路。
- `ZohaibAhmed/clauder`
  一个简单的 iPhone 优先远程访问方向。
- `frudas24/deskslice`
  对那些难以附着的外部会话来说，这是一个很有意思的“串流真实 Codex UI”路径。
- `konsti-web/claude_push`
  一个非常聚焦的审批推送通知工作流。

## 排名说明

- 只看 GitHub star 数远远不够。有几个低 star 仓库对 Panda 仍然非常相关，因为它们正好解决了“手机远程审批/实时查看”这个问题。
- `yepanywhere` 能进入最终集合，是因为它在战略方向上比某些更高层级、但更偏桌面优先的工具更接近 Panda。
- 保留 `claude-code-by-agents` 和 `codexia`，是因为 Panda 需要多 agent 能力和工作站能力，而不只是聊天远程控制。
