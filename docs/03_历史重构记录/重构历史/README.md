# 重构历史

本目录保存历史重构方案和审查记录。它们是证据，不是当前操作入口。

## 使用规则

- 可以用于追溯"为什么当时这么设计"。
- 不作为当前操作手册。
- 不作为当前代码行为的事实源。
- 新事实不要写进本目录。
- 若归档内容与正式文档冲突，以 [系统核心逻辑](../../02_系统核心逻辑/README.md) 和当前代码为准。

## 重构包索引

| 目录 / 文件 | 时间 | 目标 | 结论 |
| --- | --- | --- | --- |
| `v13-数据统一与六边形架构/` | 早期 | 数据统一与六边形架构重构 | 按 Ports and Adapters 方向演进，建立 core/ingest/archive 三层数据模型，保留部分历史 facade |
| `v18-新增飞书功能/` | 早期 | 飞书通道新增 | 飞书通过 adapter 复用 Telegram 同步主链路，用 `source_channel='feishu'` 区分来源 |
| `v19-dev环境Action与Workers合并/` | 早期 | dev 环境 Worker/Action 合并 | dev 的 Telegram 与飞书入口收敛为统一 Worker 和 `sync-dev.yml` |
| `v20-main环境Action与Workers合并/` | 早期 | main 环境 Worker/Action 合并 | main 的 Telegram 与飞书入口收敛为统一 Worker 和 `sync.yml` |
| `v21-文档内容优化/` | 早期 | 文档内容修正 | 让长期文档反映统一 Worker + 统一 sync workflow，删除旧独立入口说明 |
| `v22-文档优化删除/` | 早期 | 文档删除与收敛 | 删除 v5-v17 旧阶段方案和旧入口文档，收敛为当前维护文档 + 少量已实施方案留痕 |
| `v23-docs体系精简/` | 2026-06-22 | docs 体系精简审查 | 诊断主文档拆得过细、同一事实反复出现；建议合并为少数事实文档，把正式主文档从 92 个收敛到 15-18 个 |
| `prompt改造02-后续计划/` | 早期 | Prompt 改造后续计划 | Prompt 模块化、准确率提升、数据库映射审查的方案与实施路线图 |
| `action日志排查优化/` | 2026-06-30 | Action 日志排查与结构化日志优化 | 已落地 action logger、sync summary、compact markdown export、DB summary 和 deploy wait 日志；当前事实见 `02_系统核心逻辑/Action日志与失败补偿.md` 与 `04_问题与排查/Action日志.md` |
| `action日志监控/` | 2026-07-06 | GitHub Actions run/job/step/failure 监控落库与页面展示 | 已落地 `Report Action Status`、本地 PostgreSQL reporter、HTTP report 兜底、`monitor.*` 表和 `/action-monitor/` 页面；当前事实见 `01_系统配置/`、`02_系统核心逻辑/Action日志与失败补偿.md`、`02_系统核心逻辑/数据库模型.md` 与 `04_问题与排查/Action日志.md` |
| `参数有效时间监控/` | 2026-07-07 | 系统参数有效期 registry、audit 和页面展示 | 已落地 `config/parameter-validity/<env>.json`、`Parameter Validity Audit`、`monitor.system_config_parameters/checks` 和 `/action-monitor/` 参数有效期模块；当前事实见 `01_系统配置/`、`02_系统核心逻辑/Action日志与失败补偿.md`、`02_系统核心逻辑/数据库模型.md` 与 `04_问题与排查/Action日志.md` |
| `数据库优化/` | 2026-07-02 | PostgreSQL 权限收敛与运行时 DDL 下线 | 已落地显式 migration 边界、只读连接、运行时 DDL 默认下线和权限巡检；当前事实见 `01_系统配置/`、`02_系统核心逻辑/数据库模型.md` 与 `04_问题与排查/PostgreSQL.md` |
| `20260701_优化高中优先级落地/` | 2026-07-02 | 20260701 优化高 / 中优先级落地 | 已落地日志脱敏、sleepBackfill 目标日期回填、schema v3、语义 warning、识别评测、只读 DB、入口迁移和旧 NDJSON 主链路下线；低优先级剩余项仍在 `后续规划_未实现/20260701_优化/` |
| `核心代码优化01/` | 早期 | 核心代码优化全量重构包 | AI 容灾与调度优化、数据库优化、消息链路梳理、分支与环境一致性等 |
| `图片oss存储/` | 早期 | 腾讯云 COS 随想图片存储 | 设计、配置安全、容灾和验收报告；COS 只用于随想图片，不用于训练截图原图 |
| `docs体系升级目标.md` | 早期 | docs IA 升级目标记录 | 记录从旧长期文档到新 IA 的迁移目标 |
| `docs治理审计修复记录.md` | 早期 | docs 治理审计修复记录 | docs 治理审计后的修复记录 |
