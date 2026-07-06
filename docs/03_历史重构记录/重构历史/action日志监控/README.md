# Action 日志监控落地记录

本目录保存 GitHub Action 日志监控从规划到落地的历史材料，不作为当前操作入口。

## 当前事实入口

| 主题 | 当前文档 |
| --- | --- |
| 监控链路、上报规则、页面读取 | [Action 日志与失败补偿](../../../02_系统核心逻辑/Action日志与失败补偿.md) |
| `monitor.*` 数据库模型 | [数据库模型](../../../02_系统核心逻辑/数据库模型.md) |
| dev/main 配置 | [dev 配置](../../../01_系统配置/dev.md)、[main 配置](../../../01_系统配置/main.md) |
| 故障排查 | [Action 日志排查](../../../04_问题与排查/Action日志.md) |

## 历史材料

| 文件 | 说明 |
| --- | --- |
| `01_现状分析.md` | 落地前的 Actions 日志能力、缺口和风险分析。 |
| `02_架构设计与实现方案.md` | run_id 驱动采集、分支隔离、幂等写库和 failure extraction 方案。 |
| `03_github_action_monitor.sql` | `monitor.github_action_runs/jobs/steps/failures` 建表脚本与字段注释。 |

## 落地结果

- 所有 workflow 已接入最终 `Report Action Status` step，并保持 `if: always()` 与 `continue-on-error: true`。
- 上报默认优先使用 runner 内本地 reporter 直写分支对应 PostgreSQL，HTTP report URL 仅作兜底。
- PostgreSQL `monitor.*` 已成为 Action 监控长期事实源。
- 站点已新增独立 `/action-monitor/` 页面，展示 Action 状态、workflow、run 编号、commit、触发人、分支、耗时和失败摘要。
