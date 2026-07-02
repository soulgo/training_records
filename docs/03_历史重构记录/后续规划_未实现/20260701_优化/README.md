# 20260701 优化剩余规划

> 状态：高 / 中优先级已实现并归档；本目录只保留低优先级未实现项。
> 历史规划：见 [重构历史/20260701_优化高中优先级落地](../../重构历史/20260701_优化高中优先级落地/README.md)。
> 当前事实入口：见 [系统总览](../../../02_系统核心逻辑/系统总览.md)、[图片识别逻辑](../../../02_系统核心逻辑/图片识别逻辑.md)、[Action 日志与失败补偿](../../../02_系统核心逻辑/Action日志与失败补偿.md)、[Action 日志排查](../../../04_问题与排查/Action日志.md)。

## 已实现并移出

| 范围 | 当前事实入口 |
| --- | --- |
| Action 日志脱敏、safe report、workflow 敏感标识收敛 | [Action 日志与失败补偿](../../../02_系统核心逻辑/Action日志与失败补偿.md)、[Action 日志排查](../../../04_问题与排查/Action日志.md) |
| `sleepBackfill` 目标日期回填，避免图片同步全量扫描 | [数据入库流程](../../../02_系统核心逻辑/数据入库流程.md)、[Action 日志与失败补偿](../../../02_系统核心逻辑/Action日志与失败补偿.md) |
| 识别 schema v3、`records.sleep` 必填、语义 warning、`eval:recognition` | [图片识别逻辑](../../../02_系统核心逻辑/图片识别逻辑.md) |
| 只读 DB、sync workflow 权限说明、`sync:feishu` 入口迁移、旧 NDJSON 主链路下线 | [系统配置](../../../01_系统配置/README.md)、[系统总览](../../../02_系统核心逻辑/系统总览.md)、[Action 日志与失败补偿](../../../02_系统核心逻辑/Action日志与失败补偿.md) |

## 低优先级剩余项

| 优先级 | 项目 | 当前状态 | 验收重点 |
| --- | --- | --- | --- |
| 低 | deploy wait summary 细化 | 未实现 | 区分 queue wait、build duration、provider deploy duration；不削弱 push/manual deploy 的质量门禁。 |
| 低 | image download / cache read / DB persist 长期耗时摘要 | 未实现 | summary 只输出计数、耗时和慢查询安全摘要，不输出 SQL、图片 URL、file id、caption 或用户文本。 |
| 低 | 删除无引用薄 facade | 未实现 | 迁移测试和脚本 import 后，`rg` 确认无引用，再删除 `tools/*` 兼容转发壳。 |
| 低 | 历史敏感日志保留策略和复核 run 记录 | 未实现 | 新日志脱敏稳定后记录复核 run；旧日志中的明文标识不复制到文档、issue 或评论。 |

## 落地规则

1. 任一低优先级项实现后，先把当前事实写回 `docs/01_系统配置/`、`docs/02_系统核心逻辑/` 或 `docs/04_问题与排查/` 的对应文档。
2. 实现后的历史材料移入 `docs/03_历史重构记录/重构历史/`，本目录只保留未实现项。
3. 不把历史 run 中的真实 chat id、飞书 `oc_`、COS bucket/domain、DB URL、Prompt、caption 或 SQL 参数写入文档。
