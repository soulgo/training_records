# 20260701 优化规划

> 状态：高/中优先级已实现并完成本地测试；低优先级仍未实现
> 来源：2026-07-01 dev/main GitHub Actions 截图、`gh run view` 日志抽样、当前代码和系统核心文档复核。
> 目的：在现有 Telegram / 飞书同步、图片识别入库和随想指令均可正常运行的前提下，整理下一轮优化问题，不把本目录内容写成已上线事实。

## 总结

本轮日志显示系统主链路可用，失败补偿、AI fallback、DB 持久化和 deploy dispatch 都已经具备基本闭环。下一轮优化重点不是“修通功能”，而是降低运行成本和长期维护成本：

1. 图片 AI 识别：当前已有 schema、缓存、fallback 和 strict JSON retry，但 `records.sleep` 未进入必填 schema，且缺少字段级合理性校验和固定样本评测。
2. 运行速度：慢 run 主要被同步后的 `sleepBackfill` 拖慢。dev 飞书 run `28481129329` 中 AI 识别约 14.1s，DB persist 约 3.6s，但 `sleepBackfill` 约 213.4s。
3. 数据安全：Action summary 已经做 hash/脱敏，但同步命令 stdout 和 workflow env 展示仍泄露 chat id、飞书 `oc_`、COS bucket/domain、`sourceId` / `chatIds` 等敏感标识。
4. 冗余清理：`src` 已不再反向依赖 `tools/*` 兼容入口，旧 NDJSON sync 重放已下线；`tools` 下仍保留一批薄 facade，留待低优先级阶段删除。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [00_优先级总览.md](00_优先级总览.md) | 全目录高/中/低优先级清单，带代码证据和验收重点。 |
| [01_日志事实与瓶颈.md](01_日志事实与瓶颈.md) | dev/main run 时长、阶段耗时、代码证据和优先级判断。 |
| [02_AI解析准确率优化.md](02_AI解析准确率优化.md) | schema、语义校验、评测集、prompt/model 观测建议。 |
| [03_运行速度优化.md](03_运行速度优化.md) | sleep backfill、DB 修复、deploy wait、AI/DB 小瓶颈优化。 |
| [04_数据安全优化.md](04_数据安全优化.md) | Action 日志脱敏缺口、只读 DB 配置、权限和验收 grep。 |
| [05_冗余代码与旧接口清理.md](05_冗余代码与旧接口清理.md) | Clean Code 审计、可迁移/可删除文件、旧接口下线顺序。 |
| [06_实施顺序与验收.md](06_实施顺序与验收.md) | 建议落地顺序、测试命令、线上 run 验收和回滚规则。 |

## 优先级快照

| 优先级 | 先看内容 | 原因 |
| --- | --- | --- |
| 高 | raw Action 日志脱敏、`sleepBackfill` 同步阻塞、`records.sleep` schema v3 | 已有代码和 run 日志证据，直接影响数据安全、同步速度和图片入库正确性。 |
| 中 | 字段级语义校验、只读 DB 配置、workflow 权限收敛、识别评测集、`src`/`tools` 入口迁移、旧 NDJSON pending 下线 | 不阻断当前运行，但会影响准确率、权限边界和后续重构风险。 |
| 低 | deploy wait 细化、耗时观测增强、薄 facade 删除、历史日志保留治理 | 主要是体验、观测和维护成本优化，可跟随相关模块改动处理。 |

## 不纳入本轮直接改动

- 不改变当前 main/dev 正常同步行为。
- 不删除任何仍被 workflow、package script、测试或文档引用的入口。
- 不把 `core.*`、`ingest.*`、`archive.*` 的事实源关系重新设计；数据库权限和连接池优化仍以既有 [数据库优化](../数据库优化/README.md) 为主线。
- 不把本目录内容同步到正式系统事实文档，除非后续代码和配置已经落地并验收。
