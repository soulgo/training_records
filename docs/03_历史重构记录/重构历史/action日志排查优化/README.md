# Action 日志排查优化归档

本目录保存 Action 日志排查优化从现状分析、方案、审计到实施 checklist 的历史材料。该规划已从 `后续规划_未实现` 移出，不再作为当前系统事实入口。

## 当前事实入口

| 内容 | 当前文档 |
| --- | --- |
| Action 日志链路、summary 字段、失败补偿、维护命令 | [Action 日志与失败补偿](../../../02_系统核心逻辑/Action日志与失败补偿.md) |
| 故障现象、日志特征、排查步骤、解决方案和预防措施 | [Action 日志排查](../../../04_问题与排查/Action日志.md) |
| 后续规划完成后的文档同步规则 | [后续规划落地文档同步规则](../../../05_日常规则/后续规划落地文档同步规则.md) |

## 归档内容

| 文件 | 作用 |
| --- | --- |
| `01_Action日志现状分析.md` | 规划期现状分析和风险归类。 |
| `02_Action日志优化方案.md` | 规划期目标日志格式、traceId、脱敏和新增日志建议。 |
| `03_代码与日志对应关系.md` | Workflow、脚本、AI、DB、Markdown 和部署日志对应关系。 |
| `04_Action性能与稳定性优化.md` | 性能、稳定性和日志降噪建议。 |
| `05_最终实施建议.md` | P0/P1/P2 实施顺序和验收标准。 |
| `06_最终验收报告.md` | 文档审计验收口径。 |
| `07_第三轮审计_实际日志复核.md` | 结合真实 Action 日志的复核修订。 |
| `08_实施Checklist.md` | 已完成的实施清单。 |

## 落地状态

- `export:markdown` 默认 compact summary，GitHub Actions 中禁用 `--debug-json`。
- sync workflow 只跨 step 传递 `SYNC_DISPATCH_EVENT_PATH`，不写原始 dispatch payload。
- `tools/lib/action-logger.mjs` 提供 `[action-log]` 单行 JSON 和敏感字段处理。
- `tools/action-sync-summary.mjs` 统一 Telegram / 飞书 sync summary。
- DB 写入结果包含 `persistenceResult` 安全摘要。
- deploy wait 阶段输出周期性状态日志。
